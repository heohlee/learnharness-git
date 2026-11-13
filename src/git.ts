/** Git operations over an injected process runner. No real process is spawned here. */
import fs from "node:fs";
import path from "node:path";
import { type CloneResult, cloneInPlace } from "./clone.ts";
import { type ConflictPolicy, createResolver, parseUnmerged, type Resolution } from "./conflicts.ts";
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
	async function status(): Promise<Status> {
		return parseStatus((await exec(["status", "--porcelain=v1", "--branch", "-z", "-uall"])).stdout);
	}

	return {
		/** Whether the data directory itself is the top level of a repository. */
		async repoState(): Promise<RepoState> {
			const result = await run(["rev-parse", "--show-toplevel"], { cwd });
			if (result.code !== 0) return { kind: "none" };
			const topLevel = result.stdout.trim();
			return path.resolve(topLevel) === path.resolve(cwd) ? { kind: "repo" } : { kind: "nested", topLevel };
		},
		async init(): Promise<void> {
			await exec(["init", "-b", "main"]);
		},
		/** Clones `url` into the data directory in place; `now` names the backup folder. */
		clone(url: string, now: Date): Promise<CloneResult> {
			return cloneInPlace({ exec, run: (args) => run(args, { cwd }) }, cwd, url, now);
		},
		status,
		async stage(paths: readonly string[]): Promise<void> {
			await exec(paths.length ? [LITERAL, "add", "-A", "--", ...paths] : [LITERAL, "add", "-A"]);
		},
		async unstage(paths: readonly string[]): Promise<void> {
			await exec(paths.length ? [LITERAL, "reset", "-q", "--", ...paths] : [LITERAL, "reset", "-q"]);
		},
		async diff(file: string, options: { staged: boolean; untracked: boolean }): Promise<string> {
			if (options.untracked) {
				return (await exec([LITERAL, "diff", "--no-color", "--no-index", "--", "/dev/null", file], [0, 1])).stdout;
			}
			return (await exec([LITERAL, "diff", "--no-color", ...(options.staged ? ["--cached"] : []), "--", file])).stdout;
		},
		async commit(message: string, options: { all: boolean }): Promise<{ committed: boolean }> {
			if (!message.trim()) throw new Error("Commit message is empty.");
			await refuseDuringMerge();
			if (options.all) await exec(["add", "-A"]);
			const staged = await exec(["diff", "--cached", "--quiet"], [0, 1]);
			if (staged.code === 0) return { committed: false };
			await exec(["commit", "-q", "-m", message]);
			return { committed: true };
		},
		/**
		 * Merges the upstream. On conflicts every file gets a side from `policy` and the merge is committed;
		 * when any file cannot be decided the merge is aborted (files unchanged) and ConflictError lists them.
		 */
		async pull(policy: PullPolicy = { mode: "manual" }): Promise<"no-upstream" | "up-to-date" | "pulled"> {
			const { upstream } = await status();
			if (!upstream) return "no-upstream";
			// Only a merge started by this pull may be resolved or aborted below.
			await refuseDuringMerge();
			const before = await revision("HEAD");
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
				throw new ConflictError(upstream, listed, notes);
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
