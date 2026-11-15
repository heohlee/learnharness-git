/** Git operations over an injected process runner. No real process is spawned here. */
import fs from "node:fs";
import path from "node:path";
import { type CloneResult, cloneInPlace } from "./clone.ts";
import {
	type ConflictPolicy,
	createResolver,
	deletionDecision,
	isChatFile,
	isGraphLedger,
	ledgerLines,
	parseUnmerged,
	type Repair,
	type Resolution,
} from "./conflicts.ts";
import { conflictMessage } from "./format.ts";

export type { Resolution, ResolvedFile, Side } from "./conflicts.ts";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type GitRunner = (args: readonly string[], options: { cwd: string }) => Promise<GitResult>;

export class GitError extends Error {
	readonly args: readonly string[];
	readonly result: GitResult;
	constructor(args: readonly string[], result: GitResult) {
		const command = args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? "";
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		super(`git ${command} failed: ${detail}`);
		this.name = "GitError";
		this.args = args;
		this.result = result;
	}
}

/** A pull stopped on conflicts nothing could decide; the merge was aborted. */
export class ConflictError extends Error {
	readonly upstream: string;
	/** Conflicted paths to show: the ones the user already chose plus those still needing a choice. */
	readonly files: readonly string[];
	/** One line per file whose chosen side was rejected (not valid JSON), in conflict order. */
	readonly notes: readonly string[];
	constructor(upstream: string, files: readonly string[], notes: readonly string[] = []) {
		super(conflictMessage(upstream));
		this.name = "ConflictError";
		this.upstream = upstream;
		this.files = files;
		this.notes = notes;
	}
}

export class MergeInProgressError extends Error {
	constructor() {
		super("Unfinished merge. Finish or abort it to resume sync.");
		this.name = "MergeInProgressError";
	}
}

/** git could not authenticate to the remote; the message names the fixes. */
export class AuthError extends Error {
	/** git's own message. */
	readonly detail: string;
	constructor(url: string | null, detail: string) {
		const ssh = url === null ? null : sshUrl(url);
		super(
			ssh === null
				? "Git authentication failed. No credentials for the remote. Set up one, then retry: gh auth login && gh auth setup-git, or use an SSH URL."
				: `Git authentication failed. No credentials for ${ssh.host}. Set up one, then retry: gh auth login && gh auth setup-git, or use an SSH URL (git@${ssh.host}:${ssh.path}).`,
		);
		this.name = "AuthError";
		this.detail = detail;
	}
}

const AUTH_FAILURE =
	/could not read Username|terminal prompts disabled|Authentication failed|Permission denied \(publickey\)|invalid username or password/i;

/** Host and repository path of a remote URL (https, ssh:// or scp-like), or null for a local path. */
function sshUrl(url: string): { host: string; path: string } | null {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
		try {
			const parsed = new URL(url);
			const repo = parsed.pathname.replace(/^\/+|\/+$/g, "");
			return parsed.hostname && repo ? { host: parsed.hostname, path: repo } : null;
		} catch {
			return null;
		}
	}
	const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(url);
	return scp ? { host: scp[1] as string, path: (scp[2] as string).replace(/^\/+/, "") } : null;
}

/** How `pull` handles a merge that stops on conflicts. */
export interface PullPolicy extends ConflictPolicy {
	/** Names the backup folder; defaults to the current time. */
	now?: Date;
	/** Called with the report after the conflicts were resolved and committed. */
	onResolved?: (resolution: Resolution) => void;
}

export interface FileChange {
	path: string;
	/** Original path of a rename or copy. */
	from?: string;
	/** One-letter status: M, A, D, R, C, T, U (conflict) or ? (untracked). */
	code: string;
}

export interface Status {
	branch: string | null;
	upstream: string | null;
	hasCommits: boolean;
	ahead: number;
	behind: number;
	/** Set when the upstream branch no longer exists on the remote. */
	upstreamGone?: boolean;
	staged: FileChange[];
	unstaged: FileChange[];
}

export interface Commit {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	subject: string;
	files: FileChange[];
}

export type RepoState = { kind: "repo" } | { kind: "none" } | { kind: "nested"; topLevel: string };

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function change(file: string, code: string, from: string | undefined): FileChange {
	return from === undefined ? { path: file, code } : { path: file, from, code };
}

function parseBranch(header: string, status: Status): void {
	const match = /^(.*?)(?: \[(.*)\])?$/.exec(header);
	const head = match?.[1] ?? header;
	for (const part of (match?.[2] ?? "").split(", ")) {
		const [word, count] = part.split(" ");
		if (word === "ahead") status.ahead = Number(count);
		if (word === "behind") status.behind = Number(count);
		// The remote branch was deleted or never pushed (for example after cloning an empty remote).
		if (part === "gone") status.upstreamGone = true;
	}
	const unborn = /^(?:No commits yet|Initial commit) on (.*)$/.exec(head);
	if (unborn) {
		status.branch = unborn[1] ?? null;
		status.hasCommits = false;
	} else if (head !== "HEAD (no branch)") {
		const [branch, upstream] = head.split("...");
		status.branch = branch ?? null;
		status.upstream = upstream ?? null;
	}
}

export function parseStatus(stdout: string): Status {
	const status: Status = {
		branch: null,
		upstream: null,
		hasCommits: true,
		ahead: 0,
		behind: 0,
		staged: [],
		unstaged: [],
	};
	const records = stdout.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i] ?? "";
		if (record.startsWith("## ")) {
			parseBranch(record.slice(3), status);
			continue;
		}
		if (record.length < 4) continue;
		const xy = record.slice(0, 2);
		const file = record.slice(3);
		const x = xy[0] ?? " ";
		const y = xy[1] ?? " ";
		const from = x === "R" || x === "C" ? records[++i] : undefined;
		if (xy === "??") status.unstaged.push(change(file, "?", undefined));
		else if (CONFLICT_CODES.has(xy)) status.unstaged.push(change(file, "U", undefined));
		else {
			if (x !== " ") status.staged.push(change(file, x, from));
			if (y !== " ") status.unstaged.push(change(file, y, undefined));
		}
	}
	return status;
}

export function parseLog(stdout: string): Commit[] {
	const commits: Commit[] = [];
	for (const chunk of stdout.split("\x1e")) {
		if (!chunk.trim()) continue;
		const [header = "", ...lines] = chunk.split("\n");
		const [hash = "", shortHash = "", author = "", date = "", subject = ""] = header.split("\x1f");
		const files: FileChange[] = [];
		for (const line of lines) {
			if (!line) continue;
			const [status = "", first = "", second] = line.split("\t");
			const code = status.charAt(0);
			files.push(second === undefined ? change(first, code, undefined) : change(second, code, first));
		}
		commits.push({ hash, shortHash, author, date, subject, files });
	}
	return commits;
}

/** Files Initialize adds to a new repository, each only when it does not exist yet. */
export const DEFAULT_REPO_FILES: readonly { name: string; content: string }[] = [
	{
		name: ".gitignore",
		content: [
			"# Automatic graph copies: Git already keeps every version of graph/.",
			"graph-backup-*/",
			"# Usage log of the built-in plugins: nothing reads it.",
			"core-plugin-data/*/usage.jsonl",
			"# Community plugin code; keep only each plugin's data/ (its settings).",
			"plugins/*/*",
			"!plugins/*/data/",
			"# Graph layout: rewritten whenever the graph is opened, and recomputed if missing.",
			"graph/positions.json",
			"",
		].join("\n"),
	},
	{ name: ".gitattributes", content: "graph/*.jsonl merge=union\n" },
];

/** Creates `name` exclusively; an existing file or symlink is left untouched. */
function writeIfMissing(dir: string, name: string, content: string): void {
	try {
		fs.writeFileSync(path.join(dir, name), content, { flag: "wx" });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return;
		throw new Error(`Repository created, but ${name} could not be written (${code ?? String(error)}). Add it by hand.`);
	}
}

/**
 * Plugin folders (`plugins/<id>/`) that are Git repositories themselves, holding a `.git` folder or file (a
 * plugin installed with git clone, or a worktree or submodule). `git add -A` would commit them as embedded
 * repositories. A symlinked folder is skipped and not followed: git stores it as a link and never looks inside.
 */
function nestedPluginRepos(cwd: string): string[] {
	const plugins = path.join(cwd, "plugins");
	if (fs.lstatSync(plugins, { throwIfNoEntry: false })?.isDirectory() !== true) return [];
	return fs
		.readdirSync(plugins, { withFileTypes: true })
		.filter((entry) => {
			if (!entry.isDirectory()) return false;
			const dotGit = fs.lstatSync(path.join(plugins, entry.name, ".git"), { throwIfNoEntry: false });
			return dotGit?.isDirectory() === true || dotGit?.isFile() === true;
		})
		.map((entry) => entry.name)
		.sort();
}

/** Exclude pattern matching only the folder `plugins/<id>/`, with glob characters in `id` taken literally. */
const pluginPattern = (id: string) => `/plugins/${id.replace(/[\\*?[]/g, "\\$&")}/`;

const BLOCK_START = "# learnharness-git: plugins installed with git clone\n";
const BLOCK_END = "# end learnharness-git\n";

/** Rewrites only the plugin's marked block in `file` to hold `lines` (none: no block); the rest stays byte-identical. */
function writeExcludeBlock(file: string, lines: readonly string[]): void {
	const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	const padded = `\n${current}`;
	const start = padded.indexOf(`\n${BLOCK_START}`);
	const end = start < 0 ? -1 : padded.indexOf(`\n${BLOCK_END}`, start + BLOCK_START.length);
	const [head, tail] = end < 0 ? [current, ""] : [current.slice(0, start), current.slice(end + BLOCK_END.length)];
	const block = lines.length ? `${BLOCK_START}${lines.map((line) => `${line}\n`).join("")}${BLOCK_END}` : "";
	const next = `${head}${block && head && !head.endsWith("\n") ? "\n" : ""}${block}${tail}`;
	if (next === current) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, next);
}

/**
 * Real location of `target`, resolving symlinks in the deepest part that exists, so a path git only reports as
 * deleted can still be checked through the folders that remain.
 */
function realLocation(target: string): string {
	let current = target;
	const rest: string[] = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync(current), ...rest);
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return target;
			rest.unshift(path.basename(current));
			current = parent;
		}
	}
}

export function createGit(run: GitRunner, cwd: string) {
	async function fail(args: readonly string[], result: GitResult): Promise<never> {
		if (AUTH_FAILURE.test(result.stderr)) throw new AuthError(await remoteUrl(), result.stderr.trim());
		throw new GitError(args, result);
	}
	async function exec(args: string[], okCodes: readonly number[] = [0]): Promise<GitResult> {
		const result = await run(args, { cwd });
		if (!okCodes.includes(result.code)) await fail(args, result);
		return result;
	}
	const resolver = createResolver(exec, cwd);
	async function revision(name: string): Promise<string | null> {
		const result = await run(["rev-parse", "-q", "--verify", name], { cwd });
		return result.code === 0 ? result.stdout.trim() : null;
	}
	/** The commit HEAD and the upstream share, or null when their histories are unrelated. */
	async function mergeBase(): Promise<string | null> {
		const result = await run(["merge-base", "HEAD", "@{upstream}"], { cwd });
		const base = result.stdout.trim();
		return result.code === 0 && base ? base : null;
	}
	/** Paths whose content differs between two revisions; `-z` keeps the names raw, never quoted. */
	async function changedPaths(from: string, to: string): Promise<string[]> {
		return (await exec(["diff", "--name-only", "-z", from, to])).stdout.split("\0").filter(Boolean);
	}
	/** Content of `file` at `rev`, or null when that revision does not have it. */
	async function contentAt(rev: string, file: string): Promise<string | null> {
		const result = await run(["show", `${rev}:${file}`], { cwd });
		return result.code === 0 ? result.stdout : null;
	}
	/**
	 * Paths the incoming merge must repair instead of letting a line union undo a removal here: a graph ledger this
	 * computer removed lines from, or a chat it deleted, that the upstream also changed. Every other path keeps the
	 * ordinary pull, and unrelated histories have no base to compare with.
	 */
	async function deletionRepairs(): Promise<Repair[]> {
		const base = await mergeBase();
		if (base === null) return [];
		const local = new Set(await changedPaths(base, "HEAD"));
		const repairs: Repair[] = [];
		for (const file of await changedPaths(base, "@{upstream}")) {
			if (!local.has(file)) continue;
			if (isGraphLedger(file)) {
				const original = await contentAt(base, file);
				const kept = await contentAt("HEAD", file);
				if (original === null || kept === null) continue;
				const removed = new Set(ledgerLines(kept));
				if (!ledgerLines(original).some((line) => !removed.has(line))) continue;
				const repair = { path: file, base: original, local: kept, remote: await contentAt("@{upstream}", file) };
				// A ledger the committed side already settled needs no rewrite, so git keeps any uncommitted edit.
				if (deletionDecision(repair) !== null) repairs.push(repair);
			} else if (isChatFile(file) && (await contentAt("HEAD", file)) === null) {
				const repair = { path: file, base: null, local: null, remote: await contentAt("@{upstream}", file) };
				if (deletionDecision(repair) !== null) repairs.push(repair);
			}
		}
		return repairs;
	}
	/**
	 * A repair rewrites a file from its committed content, so an uncommitted edit to that same file would be lost.
	 * Refusing leaves both the edit and the repository exactly as they were.
	 */
	async function refuseDirtyRepairs(current: Status, repairs: readonly Repair[]): Promise<void> {
		const touched = new Set([...current.staged, ...current.unstaged].map((change) => change.path));
		const dirty = repairs.map((repair) => repair.path).filter((file) => touched.has(file));
		if (!dirty.length) return;
		throw new Error(
			`Sync needs to rewrite ${dirty.join(", ")}, which has uncommitted changes. Commit or discard them, then pull again.`,
		);
	}
	/**
	 * Takes over a diverged pull that would undo a deletion: `pull` is never run (the union attribute would bring
	 * removed lines back). The merge is started without committing, the repair paths are decided so a removal here
	 * wins, any other conflict gets its usual side, and one merge commit ends it. A step that cannot finish aborts
	 * the merge, leaving the files as they were.
	 */
	async function repairMerge(upstream: string, repairs: readonly Repair[], policy: PullPolicy): Promise<"pulled"> {
		const args = ["merge", "--no-ff", "--no-commit", "@{upstream}"];
		const started = await run(args, { cwd });
		// A merge that stopped on conflicts leaves MERGE_HEAD behind; any other failure changed nothing.
		if (started.code !== 0 && (await revision("MERGE_HEAD")) === null) return fail(args, started);
		const decisions = [];
		for (const repair of repairs) {
			const decision = deletionDecision(repair);
			if (decision !== null) decisions.push(decision);
		}
		const repaired = new Set(decisions.map((decision) => decision.path));
		const plan = async () => {
			const unmerged = parseUnmerged((await exec(["ls-files", "-u", "-z"])).stdout);
			const other = new Map([...unmerged].filter(([file]) => !repaired.has(file)));
			return { other, planned: await resolver.plan(other, policy) };
		};
		let outcome: Awaited<ReturnType<typeof plan>>;
		try {
			outcome = await plan();
		} catch (error) {
			await run(["merge", "--abort"], { cwd });
			throw error;
		}
		if (outcome.planned.undecided.length) {
			await exec(["merge", "--abort"]);
			const chosen = new Set(outcome.planned.decisions.filter((d) => d.rule === "your choice").map((d) => d.path));
			const listed = [...outcome.other.keys()].filter(
				(file) => chosen.has(file) || outcome.planned.undecided.includes(file),
			);
			throw new ConflictError(upstream, listed, outcome.planned.notes);
		}
		let resolution: Resolution;
		try {
			resolution = await resolver.apply([...decisions, ...outcome.planned.decisions], policy.now ?? new Date());
		} catch (error) {
			await run(["merge", "--abort"], { cwd });
			throw error;
		}
		policy.onResolved?.(resolution);
		return "pulled";
	}
	/** A merge the user started must never be committed half-resolved or aborted by the plugin. */
	async function refuseDuringMerge(): Promise<void> {
		// A merge, cherry-pick, revert or rebase the user left unfinished belongs to them.
		for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
			if ((await revision(ref)) !== null) throw new MergeInProgressError();
		}
		// git can leave a stale REBASE_HEAD after a finished rebase; its state directories are removed reliably.
		const rebase = await exec(["rev-parse", "--git-path", "rebase-merge", "--git-path", "rebase-apply"]);
		for (const dir of rebase.stdout.split("\n").filter(Boolean)) {
			if (fs.existsSync(path.resolve(cwd, dir))) throw new MergeInProgressError();
		}
		// Cherry-pick, stash pop and rebase conflicts leave unmerged entries without MERGE_HEAD.
		if ((await exec(["ls-files", "-u", "-z"])).stdout !== "") throw new MergeInProgressError();
	}
	// Paths are file names, never globs: "a[1].json" must not also match "a1.json".
	const LITERAL = "--literal-pathspecs";
	async function remoteUrl(): Promise<string | null> {
		const result = await run(["remote", "get-url", "origin"], { cwd });
		return result.code === 0 ? result.stdout.trim() : null;
	}
	/**
	 * Keeps the nested plugin repositories, and only them, in a marked block of the repository's own exclude file
	 * (never .gitignore), so no status, stage or commit picks them up and a plugin reinstalled normally is backed
	 * up again. A file that cannot be written stops the caller before git runs.
	 */
	async function excludeNestedRepos(): Promise<void> {
		const ids = nestedPluginRepos(cwd);
		const broken = ids.find((id) => /[\r\n]/.test(id));
		if (broken !== undefined) {
			const folder = JSON.stringify(`plugins/${broken}/`);
			throw new Error(
				`Could not keep ${folder} (its own Git repository) out of the backup: its name has a line break. Rename the folder.`,
			);
		}
		const dotGit = fs.lstatSync(path.join(cwd, ".git"), { throwIfNoEntry: false });
		if (ids.length === 0 && dotGit?.isFile() !== true) {
			// A plain .git folder: drop a stale block without asking git. No .git at all: nothing to reconcile.
			if (dotGit?.isDirectory() === true) writeExcludeBlock(path.join(cwd, ".git", "info", "exclude"), []);
			return;
		}
		// Worktrees and custom git dirs keep the exclude file elsewhere: ask git where it is.
		const file = (await exec(["rev-parse", "--git-path", "info/exclude"])).stdout.replace(/\r?\n$/, "");
		try {
			writeExcludeBlock(path.resolve(cwd, file), ids.map(pluginPattern));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? String(error);
			const folders = ids.map((id) => `plugins/${id}/`).join(", ") || "plugins installed with git clone";
			const own = ids.length === 1 ? "its own Git repository" : "each its own Git repository";
			throw new Error(`Could not keep ${folders} (${own}) out of the backup: ${file} could not be written (${code}).`);
		}
	}
	async function status(): Promise<Status> {
		return parseStatus((await exec(["status", "--porcelain=v1", "--branch", "-z", "-uall"])).stdout);
	}
	/**
	 * Refuses a diffed path whose real location is outside the data directory: an absolute path, a `..` segment, a
	 * sibling folder that merely shares the folder's name prefix, or a symlink redirecting the file or a parent. The
	 * check runs before any git call, so a refused path changes nothing. Only the requested path is named: the
	 * location it would resolve to is never echoed back.
	 */
	function confine(file: string): void {
		const fail = (): never => {
			throw new Error(
				`Cannot show ${JSON.stringify(file)}: the change viewer only shows a relative path that resolves inside the learning-data folder.`,
			);
		};
		// An absolute path is refused even when it points inside the folder, so one rule covers every caller.
		if (path.isAbsolute(file) || path.win32.isAbsolute(file)) fail();
		const root = realLocation(path.resolve(cwd));
		const relative = path.relative(root, realLocation(path.resolve(cwd, file)));
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail();
	}

	return {
		/** Whether the data directory itself is the top level of a repository. */
		async repoState(): Promise<RepoState> {
			const result = await run(["rev-parse", "--show-toplevel"], { cwd });
			if (result.code !== 0) return { kind: "none" };
			const topLevel = result.stdout.trim();
			return path.resolve(topLevel) === path.resolve(cwd) ? { kind: "repo" } : { kind: "nested", topLevel };
		},
		/** `git init`, then the default .gitignore and .gitattributes where missing. Clone does not use this. */
		async init(): Promise<void> {
			await exec(["init", "-b", "main"]);
			for (const file of DEFAULT_REPO_FILES) writeIfMissing(cwd, file.name, file.content);
			await excludeNestedRepos();
		},
		/** Clones `url` into the data directory in place; `now` names the backup folder. */
		clone(url: string, now: Date): Promise<CloneResult> {
			return cloneInPlace({ exec, run: (args) => run(args, { cwd }) }, cwd, url, now);
		},
		async status(): Promise<Status> {
			await excludeNestedRepos();
			return status();
		},
		async stage(paths: readonly string[]): Promise<void> {
			await excludeNestedRepos();
			await exec(paths.length ? [LITERAL, "add", "-A", "--", ...paths] : [LITERAL, "add", "-A"]);
		},
		async unstage(paths: readonly string[]): Promise<void> {
			await exec(paths.length ? [LITERAL, "reset", "-q", "--", ...paths] : [LITERAL, "reset", "-q"]);
		},
		async diff(file: string, options: { staged: boolean; untracked: boolean }): Promise<string> {
			confine(file);
			if (options.untracked) {
				return (await exec([LITERAL, "diff", "--no-color", "--no-index", "--", "/dev/null", file], [0, 1])).stdout;
			}
			return (await exec([LITERAL, "diff", "--no-color", ...(options.staged ? ["--cached"] : []), "--", file])).stdout;
		},
		async commit(message: string, options: { all: boolean }): Promise<{ committed: boolean }> {
			if (!message.trim()) throw new Error("Commit message is empty.");
			await refuseDuringMerge();
			await excludeNestedRepos();
			if (options.all) await exec(["add", "-A"]);
			const staged = await exec(["diff", "--cached", "--quiet"], [0, 1]);
			if (staged.code === 0) return { committed: false };
			await exec(["commit", "-q", "-m", message]);
			return { committed: true };
		},
		/**
		 * Fetches first, then merges the upstream. A diverged pull that would undo a deletion is repaired before any
		 * commit; otherwise conflicts get a side from `policy`, and one nothing can decide aborts the merge (files
		 * unchanged) with a ConflictError listing it.
		 */
		async pull(policy: PullPolicy = { mode: "manual" }): Promise<"no-upstream" | "up-to-date" | "pulled"> {
			const current = await status();
			if (!current.upstream) return "no-upstream";
			// Only a merge started by this pull may be resolved or aborted below.
			await refuseDuringMerge();
			const before = await revision("HEAD");
			// Fetch before reading the divergence: a stale @{upstream} would hide the very change that must not
			// undo a deletion made here.
			await exec(["fetch"]);
			const fresh = await status();
			if (fresh.ahead > 0 && fresh.behind > 0) {
				const repairs = await deletionRepairs();
				if (repairs.length) {
					await refuseDirtyRepairs(fresh, repairs);
					return repairMerge(current.upstream, repairs, policy);
				}
			}
			const args = ["pull", "--no-rebase", "--no-edit"];
			const result = await run(args, { cwd });
			if (result.code === 0) return (await revision("HEAD")) === before ? "up-to-date" : "pulled";
			if ((await revision("MERGE_HEAD")) === null) return fail(args, result);
			const conflicts = parseUnmerged((await exec(["ls-files", "-u", "-z"])).stdout);
			const { decisions, undecided, notes } = await resolver.plan(conflicts, policy);
			if (undecided.length || decisions.length === 0) {
				// Never leave conflict markers inside JSON learning records.
				await exec(["merge", "--abort"]);
				// Files the user already chose stay listed, so the screen keeps those choices and a conflict
				// that appears between two attempts adds to the list instead of replacing it.
				// A rejected choice is undecided, so its file stays listed next to its note.
				const chosen = new Set(decisions.filter((d) => d.rule === "your choice").map((d) => d.path));
				const listed = [...conflicts.keys()].filter((file) => chosen.has(file) || undecided.includes(file));
				throw new ConflictError(current.upstream, listed, notes);
			}
			let resolution: Resolution;
			try {
				resolution = await resolver.apply(decisions, policy.now ?? new Date());
			} catch (error) {
				await run(["merge", "--abort"], { cwd });
				throw error;
			}
			policy.onResolved?.(resolution);
			return "pulled";
		},
		/** Read-only diff of one file between HEAD and the fetched upstream. */
		async conflictDiff(file: string): Promise<string> {
			return (await exec([LITERAL, "diff", "--no-color", "HEAD", "@{upstream}", "--", file])).stdout;
		},
		async push(): Promise<"no-upstream" | "up-to-date" | "pushed"> {
			const current = await status();
			if (!current.upstream) return "no-upstream";
			if (current.ahead === 0 && !current.upstreamGone) return "up-to-date";
			await exec(["push"]);
			return "pushed";
		},
		remoteUrl,
		/** Points origin at `url`, adding it when missing, and drops any push URL so pushes go to `url` too. */
		async setRemote(url: string): Promise<void> {
			await exec(
				(await remoteUrl()) === null ? ["remote", "add", "origin", url] : ["remote", "set-url", "origin", url],
			);
			const args = ["config", "--unset-all", "remote.origin.pushurl"];
			const result = await run(args, { cwd });
			// Exit 5: no push URL was set.
			if (result.code !== 0 && result.code !== 5) throw new GitError(args, result);
		},
		/** Origin's configured push URLs; empty when pushes use the fetch URL. */
		async pushUrls(): Promise<string[]> {
			const result = await run(["config", "--get-all", "remote.origin.pushurl"], { cwd });
			return result.code === 0 ? result.stdout.split("\n").filter(Boolean) : [];
		},
		async restorePushUrls(urls: readonly string[]): Promise<void> {
			for (const url of urls) await exec(["config", "--add", "remote.origin.pushurl", url]);
		},
		async removeRemote(): Promise<void> {
			await exec(["remote", "remove", "origin"]);
		},
		/** Every path the history of `branch` ever touched; a push uploads all of them. */
		async historyFiles(branch: string): Promise<string[]> {
			if ((await revision(branch)) === null) return [];
			const args = ["-c", "core.quotePath=false", "log", branch, "--name-only", "--format=", "-z"];
			return [...new Set((await exec(args)).stdout.split(/[\0\n]/).filter(Boolean))];
		},
		/** First push of `branch` to origin, recording it as the upstream. */
		async publish(branch: string): Promise<void> {
			await exec(["push", "-u", "origin", branch]);
		},
		/** Files a commit of everything would include: tracked plus untracked, non-ignored. */
		async listFiles(): Promise<string[]> {
			await excludeNestedRepos();
			const args = ["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"];
			return (await exec(args)).stdout.split("\0").filter(Boolean);
		},
		/** The configured `user.name`, or null when it is unset or cannot be read. */
		async userName(): Promise<string | null> {
			const result = await run(["config", "user.name"], { cwd });
			const name = result.stdout.trim();
			return result.code === 0 && name ? name : null;
		},
		/** Recent commits; a merge lists the files it changed relative to its first parent. */
		async log(limit: number): Promise<Commit[]> {
			if ((await revision("HEAD")) === null) return [];
			const format = "--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s";
			return parseLog(
				(
					await exec([
						"-c",
						"core.quotePath=false",
						"log",
						`-n${limit}`,
						format,
						"--name-status",
						"--diff-merges=first-parent",
					])
				).stdout,
			);
		},
	};
}

export type Git = ReturnType<typeof createGit>;
