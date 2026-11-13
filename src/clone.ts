/**
 * Clone a backup repository into the existing learning data folder ("clone in place") on a new computer.
 * `git clone` cannot target a non-empty folder, so this initializes a repository, fetches the remote and
 * checks out its default branch, after moving every local path the remote also has to a dated backup.
 */
import fs from "node:fs";
import path from "node:path";
import type { GitResult } from "./git.ts";

export interface CloneResult {
	branch: string;
	/** Backup folder relative to the learning data folder, or null when nothing collided. */
	backupDir: string | null;
	/** Local paths moved into the backup, relative to the learning data folder. */
	backedUp: string[];
}

export const BACKUP_ROOT = ".learnharness-git-backup";

type Exec = (args: string[]) => Promise<GitResult>;

/** `exec` throws on a non-zero exit; `run` returns the result as is. */
export interface CloneGit {
	exec: Exec;
	run: Exec;
}

const isDirectory = (file: string) => fs.statSync(file, { throwIfNoEntry: false })?.isDirectory() === true;

function containsFile(dir: string): boolean {
	if (!isDirectory(dir)) return false;
	return (
		fs
			.readdirSync(dir, { withFileTypes: true })
			// Anything but a folder counts: files, and also symlinks to sessions kept elsewhere.
			.some((entry) => !entry.isDirectory() || containsFile(path.join(dir, entry.name)))
	);
}

/** Sessions or a knowledge graph mean this is not a new computer: two libraries must be merged by hand. */
function hasOwnData(cwd: string): boolean {
	if (containsFile(path.join(cwd, "chats"))) return true;
	const graph = path.join(cwd, "graph");
	if (!isDirectory(graph)) return false;
	return fs
		.readdirSync(graph, { withFileTypes: true })
		.some(
			(entry) => entry.isFile() && entry.name.endsWith(".jsonl") && fs.statSync(path.join(graph, entry.name)).size > 0,
		);
}

/** Local paths in the way of `remote`: the same path, or a local non-folder where the remote needs a folder. */
function collisions(cwd: string, remote: readonly string[]): string[] {
	const found = new Set<string>();
	for (const file of remote) {
		const parts = file.split("/");
		for (let i = 1; i <= parts.length; i++) {
			const rel = parts.slice(0, i).join("/");
			const stat = fs.lstatSync(path.join(cwd, rel), { throwIfNoEntry: false });
			if (!stat) break;
			if (i === parts.length || !stat.isDirectory()) {
				found.add(rel);
				break;
			}
		}
	}
	return [...found].sort();
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) =>
	`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

/** Removes `dir` and its subfolders when they hold no files. */
function removeEmpty(dir: string): void {
	if (!isDirectory(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) removeEmpty(path.join(dir, entry.name));
	}
	if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

function excludeBackups(cwd: string): void {
	const exclude = path.join(cwd, ".git", "info", "exclude");
	fs.mkdirSync(path.dirname(exclude), { recursive: true });
	const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
	const line = `${BACKUP_ROOT}/`;
	if (current.split("\n").includes(line)) return;
	fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
}

export async function cloneInPlace(git: CloneGit, cwd: string, url: string, now: Date): Promise<CloneResult> {
	if (hasOwnData(cwd)) {
		throw new Error(
			"This folder already has your own sessions or knowledge graph. Cloning would mix two libraries; merge them by hand with git instead.",
		);
	}
	const gitDir = path.join(cwd, ".git");
	const hadGitDir = fs.existsSync(gitDir);
	const createdRoot = !fs.existsSync(path.join(cwd, BACKUP_ROOT));
	const moved: { from: string; to: string }[] = [];
	let backupDir: string | null = null;
	try {
		await git.exec(["init", "-b", "main"]);
		await git.exec(["remote", "add", "origin", url]);
		await git.exec(["fetch", "origin"]);
		const symref = (await git.exec(["ls-remote", "--symref", "origin", "HEAD"])).stdout;
		const branch = /^ref: refs\/heads\/([^\s-]\S*)\tHEAD$/m.exec(symref)?.[1] ?? "main";
		if ((await git.run(["rev-parse", "-q", "--verify", `refs/remotes/origin/${branch}`])).code !== 0) {
			throw new Error(
				"The remote repository is empty. Use “Initialize repository” and connect it from Settings instead.",
			);
		}
		const listing = await git.exec([
			"-c",
			"core.quotePath=false",
			"ls-tree",
			"-r",
			"-z",
			"--name-only",
			`origin/${branch}`,
		]);
		const colliding = collisions(cwd, listing.stdout.split("\0").filter(Boolean));

		if (colliding.length) {
			backupDir = `${BACKUP_ROOT}/${stamp(now)}`;
			// Never move a file onto an earlier backup.
			for (let n = 2; fs.existsSync(path.join(cwd, backupDir)); n++) backupDir = `${BACKUP_ROOT}/${stamp(now)}-${n}`;
			for (const rel of colliding) {
				const from = path.join(cwd, rel);
				const to = path.join(cwd, backupDir, rel);
				fs.mkdirSync(path.dirname(to), { recursive: true });
				fs.renameSync(from, to);
				moved.push({ from, to });
			}
		}
		excludeBackups(cwd);
		await git.exec(["checkout", "-b", branch, "--track", `origin/${branch}`]);
		return { branch, backupDir, backedUp: colliding };
	} catch (error) {
		for (const { from, to } of moved.reverse()) {
			try {
				fs.mkdirSync(path.dirname(from), { recursive: true });
				fs.renameSync(to, from);
			} catch {
				// The file stays in the backup folder; it is never deleted.
			}
		}
		// Remove only the folders this clone created; earlier backups stay as they were.
		if (backupDir !== null) removeEmpty(path.join(cwd, backupDir));
		if (createdRoot) removeEmpty(path.join(cwd, BACKUP_ROOT));
		if (!hadGitDir) fs.rmSync(gitDir, { recursive: true, force: true });
		throw error;
	}
}
