import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { AuthError, ConflictError, createGit, GitError, type GitRunner } from "../src/git.ts";
import { fakeGit } from "./fake-git.ts";

const dir = "/data";
const STATUS = ["status", "--porcelain=v1", "--branch", "-z", "-uall"];
const MERGING = ["rev-parse", "-q", "--verify", "MERGE_HEAD"];
const UNMERGED = ["ls-files", "-u", "-z"];
const REBASE_DIRS = ["rev-parse", "--git-path", "rebase-merge", "--git-path", "rebase-apply"];
const absent = (ref: string) => ({ args: ["rev-parse", "-q", "--verify", ref], result: { code: 1 } });
const noMerge = [
	{ args: MERGING, result: { code: 1 } },
	absent("CHERRY_PICK_HEAD"),
	absent("REVERT_HEAD"),
	{ args: REBASE_DIRS, result: { stdout: "/nonexistent/rebase-merge\n/nonexistent/rebase-apply\n" } },
	{ args: UNMERGED, result: { stdout: "" } },
];

describe("repoState", () => {
	test("is repo when the top level is the data directory", async () => {
		const fake = fakeGit([{ args: ["rev-parse", "--show-toplevel"], result: { stdout: "/data\n" } }]);
		assert.deepEqual(await createGit(fake.run, dir).repoState(), { kind: "repo" });
		assert.deepEqual(fake.calls, [{ args: ["rev-parse", "--show-toplevel"], cwd: "/data" }]);
	});
	test("is nested when an enclosing repository owns the directory", async () => {
		const fake = fakeGit([{ args: ["rev-parse", "--show-toplevel"], result: { stdout: "/home/me\n" } }]);
		assert.deepEqual(await createGit(fake.run, dir).repoState(), { kind: "nested", topLevel: "/home/me" });
	});
	test("is none outside any repository", async () => {
		const fake = fakeGit([
			{ args: ["rev-parse", "--show-toplevel"], result: { code: 128, stderr: "fatal: not a git repository" } },
		]);
		assert.deepEqual(await createGit(fake.run, dir).repoState(), { kind: "none" });
	});
});

describe("status", () => {
	test("parses branch, upstream, divergence and staged/unstaged changes", async () => {
		const stdout = [
			"## main...origin/main [ahead 2, behind 1]",
			"M  sessions/a.json",
			" M graph.json",
			"MM notes.md",
			"R  new name.json",
			"old name.json",
			"?? fresh.json",
			"UU clash.json",
			"",
		].join("\0");
		const fake = fakeGit([{ args: STATUS, result: { stdout } }]);
		assert.deepEqual(await createGit(fake.run, dir).status(), {
			branch: "main",
			upstream: "origin/main",
			hasCommits: true,
			ahead: 2,
			behind: 1,
			staged: [
				{ path: "sessions/a.json", code: "M" },
				{ path: "notes.md", code: "M" },
				{ path: "new name.json", from: "old name.json", code: "R" },
			],
			unstaged: [
				{ path: "graph.json", code: "M" },
				{ path: "notes.md", code: "M" },
				{ path: "fresh.json", code: "?" },
				{ path: "clash.json", code: "U" },
			],
		});
	});
	test("reports an unborn branch and a detached head", async () => {
		const unborn = fakeGit([{ args: STATUS, result: { stdout: "## No commits yet on main\0" } }]);
		const detached = fakeGit([{ args: STATUS, result: { stdout: "## HEAD (no branch)\0" } }]);
		const base = { upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [] };
		assert.deepEqual(await createGit(unborn.run, dir).status(), { ...base, branch: "main", hasCommits: false });
		assert.deepEqual(await createGit(detached.run, dir).status(), { ...base, branch: null, hasCommits: true });
	});
	test("throws GitError with git's message on failure", async () => {
		const fake = fakeGit([{ args: STATUS, result: { code: 128, stderr: "fatal: bad thing\n" } }]);
		const error = await createGit(fake.run, dir)
			.status()
			.catch((e: unknown) => e);
		assert.ok(error instanceof GitError);
		assert.equal(error.message, "git status failed: fatal: bad thing");
	});
});

describe("stage, unstage, init", () => {
	test("stage adds the given paths, or everything without paths", async () => {
		const fake = fakeGit([
			{ args: ["--literal-pathspecs", "add", "-A", "--", "a.json", "b c.json"] },
			{ args: ["--literal-pathspecs", "add", "-A"] },
		]);
		const git = createGit(fake.run, dir);
		await git.stage(["a.json", "b c.json"]);
		await git.stage([]);
		fake.done();
	});
	test("unstage resets the given paths, or the whole index", async () => {
		const fake = fakeGit([
			{ args: ["--literal-pathspecs", "reset", "-q", "--", "a.json"] },
			{ args: ["--literal-pathspecs", "reset", "-q"] },
		]);
		const git = createGit(fake.run, dir);
		await git.unstage(["a.json"]);
		await git.unstage([]);
		fake.done();
	});
});

describe("init", () => {
	const GITIGNORE = [
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
	].join("\n");
	const GITATTRIBUTES = "graph/*.jsonl merge=union\n";
	let tmp = "";
	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-init-"));
	});
	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});
	const read = (file: string) => fs.readFile(path.join(tmp, file), "utf8");

	test("creates a repository on branch main and writes the default .gitignore and .gitattributes", async () => {
		const fake = fakeGit([{ args: ["init", "-b", "main"] }]);
		await createGit(fake.run, tmp).init();
		fake.done();
		assert.deepEqual(fake.calls, [{ args: ["init", "-b", "main"], cwd: tmp }]);
		assert.deepEqual((await fs.readdir(tmp)).sort(), [".gitattributes", ".gitignore"]);
		assert.equal(await read(".gitignore"), GITIGNORE);
		assert.equal(await read(".gitattributes"), GITATTRIBUTES);
	});
	test("leaves an existing .gitignore byte-identical and still writes .gitattributes", async () => {
		await fs.writeFile(path.join(tmp, ".gitignore"), "mine\r\nno newline");
		const fake = fakeGit([{ args: ["init", "-b", "main"] }]);
		await createGit(fake.run, tmp).init();
		fake.done();
		assert.equal(await read(".gitignore"), "mine\r\nno newline");
		assert.equal(await read(".gitattributes"), GITATTRIBUTES);
	});
	test("leaves an existing .gitattributes byte-identical and still writes .gitignore", async () => {
		await fs.writeFile(path.join(tmp, ".gitattributes"), "");
		const fake = fakeGit([{ args: ["init", "-b", "main"] }]);
		await createGit(fake.run, tmp).init();
		fake.done();
		assert.equal(await read(".gitattributes"), "");
		assert.equal(await read(".gitignore"), GITIGNORE);
	});
	test("a symlink counts as existing and is not followed", async () => {
		await fs.symlink("missing-target", path.join(tmp, ".gitignore"));
		const fake = fakeGit([{ args: ["init", "-b", "main"] }]);
		await createGit(fake.run, tmp).init();
		fake.done();
		assert.equal(await fs.readlink(path.join(tmp, ".gitignore")), "missing-target");
		assert.deepEqual((await fs.readdir(tmp)).sort(), [".gitattributes", ".gitignore"]);
	});
	test("a failed git init writes nothing", async () => {
		const fake = fakeGit([{ args: ["init", "-b", "main"], result: { code: 1, stderr: "fatal: nope" } }]);
		await assert.rejects(createGit(fake.run, tmp).init(), { message: "git init failed: fatal: nope" });
		fake.done();
		assert.deepEqual(await fs.readdir(tmp), []);
	});
	test("a failed write reports which file is missing after the repository was created", async () => {
		const missing = path.join(tmp, "gone");
		const fake = fakeGit([{ args: ["init", "-b", "main"] }]);
		await assert.rejects(createGit(fake.run, missing).init(), {
			message: `Repository created, but .gitignore could not be written (ENOENT). Add it by hand.`,
		});
		fake.done();
		assert.deepEqual(await fs.readdir(tmp), []);
	});
});

describe("diff", () => {
	test("shows working tree or staged changes of one file", async () => {
		const fake = fakeGit([
			{ args: ["--literal-pathspecs", "diff", "--no-color", "--", "a.json"], result: { stdout: "WT" } },
			{ args: ["--literal-pathspecs", "diff", "--no-color", "--cached", "--", "a.json"], result: { stdout: "IDX" } },
		]);
		const git = createGit(fake.run, dir);
		assert.equal(await git.diff("a.json", { staged: false, untracked: false }), "WT");
		assert.equal(await git.diff("a.json", { staged: true, untracked: false }), "IDX");
	});
	test("shows an untracked file as fully added (exit code 1 is a difference)", async () => {
		const fake = fakeGit([
			{
				args: ["--literal-pathspecs", "diff", "--no-color", "--no-index", "--", "/dev/null", "new.json"],
				result: { code: 1, stdout: "+{}" },
			},
		]);
		assert.equal(await createGit(fake.run, dir).diff("new.json", { staged: false, untracked: true }), "+{}");
	});
});

describe("diff confinement", () => {
	// A real tree, so a path that leaves the data folder through a symlink is caught the way a user's disk behaves.
	let base = "";
	let root = "";
	let sibling = "";
	const outside = (file: string) =>
		`Cannot show ${JSON.stringify(file)}: the change viewer only shows a relative path that resolves inside the learning-data folder.`;
	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-diff-"));
		root = path.join(base, "data");
		sibling = path.join(base, "data-elsewhere");
		mkdirSync(path.join(root, "notes"), { recursive: true });
		mkdirSync(path.join(root, "weird"), { recursive: true });
		mkdirSync(sibling, { recursive: true });
		writeFileSync(path.join(root, "notes", "nested.json"), "{}\n");
		writeFileSync(path.join(root, "weird", "a[1].json"), "{}\n");
		writeFileSync(path.join(base, "secret.txt"), "outside\n");
		writeFileSync(path.join(sibling, "secret.txt"), "outside\n");
		await fs.symlink(sibling, path.join(root, "linked"));
		await fs.symlink(path.join(base, "secret.txt"), path.join(root, "leak.json"));
		// A symlink that stays inside: it makes `inner/..` the data folder, not its parent.
		await fs.symlink(path.join(root, "notes"), path.join(root, "inner"));
		// A symlink to the folder itself, and a chain of symlinks that leaves it.
		await fs.symlink(root, path.join(root, "rootlink"));
		await fs.symlink(path.join(root, "linked"), path.join(root, "chain"));
	});
	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	const escapes: [string, string][] = [
		["a symlink then .. naming the file beside the folder", "linked/../secret.txt"],
		[".. after a symlink to the folder itself", "rootlink/../secret.txt"],
		["a chain of symlinks then ..", "chain/../secret.txt"],
		["two steps back through a symlinked sibling", "linked/../data-elsewhere/../secret.txt"],
	];
	for (const [why, file] of escapes) {
		test(`refuses ${why} without running git`, async () => {
			const fake = fakeGit([]);
			await assert.rejects(createGit(fake.run, root).diff(file, { staged: false, untracked: true }), {
				message: outside(file),
			});
			assert.deepEqual(fake.calls, []);
			fake.done();
		});
	}
	test("still shows a tracked path through .. that stays inside the data folder", async () => {
		const fake = fakeGit([
			{
				args: ["--literal-pathspecs", "diff", "--no-color", "--", "weird/../notes/nested.json"],
				result: { stdout: "-{}" },
			},
		]);
		assert.equal(
			await createGit(fake.run, root).diff("weird/../notes/nested.json", { staged: false, untracked: false }),
			"-{}",
		);
		fake.done();
	});
	test("refuses an absolute path outside the data folder without running git", async () => {
		const fake = fakeGit([]);
		const file = path.join(sibling, "secret.txt");
		await assert.rejects(createGit(fake.run, root).diff(file, { staged: false, untracked: true }), {
			message: outside(file),
		});
		assert.deepEqual(fake.calls, []);
		fake.done();
	});
	test("refuses a .. segment leaving the data folder without running git", async () => {
		const fake = fakeGit([]);
		await assert.rejects(createGit(fake.run, root).diff("../secret.txt", { staged: false, untracked: true }), {
			message: outside("../secret.txt"),
		});
		assert.deepEqual(fake.calls, []);
		fake.done();
	});
	test("refuses a sibling folder whose name starts with the data folder's name", async () => {
		const fake = fakeGit([]);
		const file = "../data-elsewhere/secret.txt";
		await assert.rejects(createGit(fake.run, root).diff(file, { staged: false, untracked: true }), {
			message: outside(file),
		});
		assert.deepEqual(fake.calls, []);
		fake.done();
	});
	test("refuses a path whose parent folder is a symlink leaving the data folder", async () => {
		const fake = fakeGit([]);
		const file = "linked/secret.txt";
		await assert.rejects(createGit(fake.run, root).diff(file, { staged: false, untracked: true }), {
			message: outside(file),
		});
		assert.deepEqual(fake.calls, []);
		fake.done();
	});
	test("refuses a path leaving the data folder through a symlink followed by ..", async () => {
		const fake = fakeGit([]);
		const file = "linked/../data-elsewhere/secret.txt";
		await assert.rejects(createGit(fake.run, root).diff(file, { staged: false, untracked: true }), {
			message: outside(file),
		});
		assert.deepEqual(fake.calls, []);
		fake.done();
	});
	test("refuses a symlink-plus-.. path on the tracked branch too", async () => {
		const fake = fakeGit([]);
		const file = "linked/../data-elsewhere/secret.txt";
		const git = createGit(fake.run, root);
		await assert.rejects(git.diff(file, { staged: false, untracked: false }), { message: outside(file) });
		await assert.rejects(git.diff(file, { staged: true, untracked: false }), { message: outside(file) });
		assert.deepEqual(fake.calls, []);
		fake.done();
	});
	test("refuses a symlinked file whose target leaves the data folder", async () => {
		const fake = fakeGit([]);
		const file = "leak.json";
		await assert.rejects(createGit(fake.run, root).diff(file, { staged: false, untracked: true }), {
			message: outside(file),
		});
		assert.deepEqual(fake.calls, []);
		fake.done();
	});
	test("refuses an absolute path even when it points inside the data folder", async () => {
		const fake = fakeGit([]);
		const file = path.join(root, "notes", "nested.json");
		await assert.rejects(createGit(fake.run, root).diff(file, { staged: false, untracked: false }), {
			message: outside(file),
		});
		assert.deepEqual(fake.calls, []);
		fake.done();
	});
	test("still shows a tracked file at a nested path", async () => {
		const fake = fakeGit([
			{ args: ["--literal-pathspecs", "diff", "--no-color", "--", "notes/nested.json"], result: { stdout: "WT" } },
			{
				args: ["--literal-pathspecs", "diff", "--no-color", "--cached", "--", "notes/nested.json"],
				result: { stdout: "IDX" },
			},
		]);
		const git = createGit(fake.run, root);
		assert.equal(await git.diff("notes/nested.json", { staged: false, untracked: false }), "WT");
		assert.equal(await git.diff("notes/nested.json", { staged: true, untracked: false }), "IDX");
		fake.done();
	});
	test("still shows an untracked nested file as fully added", async () => {
		const fake = fakeGit([
			{
				args: ["--literal-pathspecs", "diff", "--no-color", "--no-index", "--", "/dev/null", "notes/nested.json"],
				result: { code: 1, stdout: "+{}" },
			},
		]);
		assert.equal(await createGit(fake.run, root).diff("notes/nested.json", { staged: false, untracked: true }), "+{}");
		fake.done();
	});
	test("still shows an untracked file whose name holds a glob character", async () => {
		const fake = fakeGit([
			{
				args: ["--literal-pathspecs", "diff", "--no-color", "--no-index", "--", "/dev/null", "weird/a[1].json"],
				result: { code: 1, stdout: "+{}" },
			},
		]);
		assert.equal(await createGit(fake.run, root).diff("weird/a[1].json", { staged: false, untracked: true }), "+{}");
		fake.done();
	});
	test("still shows a path whose .. stays inside the data folder", async () => {
		const fake = fakeGit([
			{
				args: [
					"--literal-pathspecs",
					"diff",
					"--no-color",
					"--no-index",
					"--",
					"/dev/null",
					"notes/../weird/a[1].json",
				],
				result: { code: 1, stdout: "+{}" },
			},
		]);
		assert.equal(
			await createGit(fake.run, root).diff("notes/../weird/a[1].json", { staged: false, untracked: true }),
			"+{}",
		);
		fake.done();
	});
	test("still shows a path through a symlink that stays inside the data folder", async () => {
		const fake = fakeGit([
			{ args: ["--literal-pathspecs", "diff", "--no-color", "--", "inner/nested.json"], result: { stdout: "WT" } },
		]);
		assert.equal(await createGit(fake.run, root).diff("inner/nested.json", { staged: false, untracked: false }), "WT");
		fake.done();
	});
	test("still shows a tracked path git reports as deleted", async () => {
		const fake = fakeGit([
			{ args: ["--literal-pathspecs", "diff", "--no-color", "--", "gone/removed.json"], result: { stdout: "-{}" } },
		]);
		assert.equal(await createGit(fake.run, root).diff("gone/removed.json", { staged: false, untracked: false }), "-{}");
		fake.done();
	});
});

describe("commit", () => {
	test("commits staged changes", async () => {
		const fake = fakeGit([
			...noMerge,
			{ args: ["diff", "--cached", "--quiet"], result: { code: 1 } },
			{ args: ["commit", "-q", "-m", "msg"] },
		]);
		assert.deepEqual(await createGit(fake.run, dir).commit("msg", { all: false }), { committed: true });
		fake.done();
	});
	test("stages everything first when all is set", async () => {
		const fake = fakeGit([
			...noMerge,
			{ args: ["add", "-A"] },
			{ args: ["diff", "--cached", "--quiet"], result: { code: 1 } },
			{ args: ["commit", "-q", "-m", "msg"] },
		]);
		assert.deepEqual(await createGit(fake.run, dir).commit("msg", { all: true }), { committed: true });
		fake.done();
	});
	test("does nothing when nothing is staged", async () => {
		const fake = fakeGit([...noMerge, { args: ["diff", "--cached", "--quiet"] }]);
		assert.deepEqual(await createGit(fake.run, dir).commit("msg", { all: false }), { committed: false });
		fake.done();
	});
	test("refuses while a merge is in progress, without staging anything", async () => {
		const fake = fakeGit([{ args: MERGING, result: { stdout: "ccc\n" } }]);
		await assert.rejects(createGit(fake.run, dir).commit("msg", { all: true }), {
			name: "MergeInProgressError",
			message: "Unfinished merge. Finish or abort it to resume sync.",
		});
		fake.done();
	});
	test("refuses while a rebase is stopped (its state directory exists)", async () => {
		const state = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-"));
		try {
			const fake = fakeGit([
				{ args: MERGING, result: { code: 1 } },
				absent("CHERRY_PICK_HEAD"),
				absent("REVERT_HEAD"),
				{ args: REBASE_DIRS, result: { stdout: `/nonexistent/rebase-merge\n${state}\n` } },
			]);
			await assert.rejects(createGit(fake.run, dir).commit("msg", { all: true }), { name: "MergeInProgressError" });
			fake.done();
		} finally {
			await fs.rm(state, { recursive: true, force: true });
		}
	});
	test("refuses while a resolved cherry-pick is not yet continued", async () => {
		const fake = fakeGit([
			{ args: MERGING, result: { code: 1 } },
			{ args: ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], result: { stdout: "ddd\n" } },
		]);
		await assert.rejects(createGit(fake.run, dir).commit("msg", { all: true }), { name: "MergeInProgressError" });
		fake.done();
	});
	test("refuses while unmerged entries exist (cherry-pick, stash pop or rebase conflict)", async () => {
		const fake = fakeGit([
			{ args: MERGING, result: { code: 1 } },
			absent("CHERRY_PICK_HEAD"),
			absent("REVERT_HEAD"),
			{ args: REBASE_DIRS, result: { stdout: "/nonexistent/rebase-merge\n/nonexistent/rebase-apply\n" } },
			{ args: UNMERGED, result: { stdout: "100644 abc 1\tf.json\0" } },
		]);
		await assert.rejects(createGit(fake.run, dir).commit("msg", { all: true }), {
			name: "MergeInProgressError",
			message: "Unfinished merge. Finish or abort it to resume sync.",
		});
		fake.done();
	});
	test("rejects an empty message without running git", async () => {
		const fake = fakeGit([]);
		await assert.rejects(createGit(fake.run, dir).commit("  ", { all: true }), { message: "Commit message is empty." });
		assert.deepEqual(fake.calls, []);
	});
});

const clean = (branchLine: string) => ({ args: STATUS, result: { stdout: `## ${branchLine}\0` } });
const HEAD = ["rev-parse", "-q", "--verify", "HEAD"];
const MERGE_BASE = ["merge-base", "HEAD", "@{upstream}"];
const FETCH = ["fetch"];
const MERGE_UPSTREAM = ["merge", "--no-ff", "--no-commit", "@{upstream}"];
const COMMIT_MERGE = ["commit", "--no-edit", "-q"];
const LIT = "--literal-pathspecs";
const NOW = new Date(2026, 10, 12, 22, 40, 5);
const BACKUP = ".learnharness-git-backup/conflicts/2026-11-12_22-40-05";
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const graph = (content: string | null) => ({ "graph/nodes.jsonl": content });

/** Changed paths between two revisions, as git reports them for these contents. */
function differing(from: Record<string, string | null>, to: Record<string, string | null>): string[] {
	return [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((file) => from[file] !== to[file]);
}

/**
 * Fake git for a pull whose branches diverged: `base`, `head` and `upstream` hold each revision's files, and
 * null means that revision deleted the file, so the changed paths are the ones whose content differs. Every
 * other command succeeds with no output, and a command the pull does not need fails the test.
 */
function diverged(
	versions: {
		base?: Record<string, string | null>;
		head?: Record<string, string | null>;
		upstream?: Record<string, string | null>;
	},
	options: { branchLine?: string; mergeBase?: boolean } = {},
) {
	const revisions: Record<string, Record<string, string | null>> = {
		base: versions.base ?? {},
		HEAD: versions.head ?? {},
		"@{upstream}": versions.upstream ?? {},
	};
	const calls: string[][] = [];
	const run: GitRunner = async (args) => {
		calls.push([...args]);
		const key = args.join(" ");
		if (key === STATUS.join(" ")) return ok(`## ${options.branchLine ?? "main...origin/main [ahead 1, behind 1]"}\0`);
		if (key === FETCH.join(" ")) return ok();
		if (key === HEAD.join(" ")) return ok(calls.some((call) => call[0] === "pull") ? "merged\n" : "local\n");
		if (key.startsWith("rev-parse -q --verify ")) return { code: 1, stdout: "", stderr: "" };
		if (key === REBASE_DIRS.join(" ")) return ok("/nonexistent/rebase-merge\n/nonexistent/rebase-apply\n");
		if (key === UNMERGED.join(" ")) return ok();
		if (key === MERGE_BASE.join(" ")) {
			return options.mergeBase === false ? { code: 1, stdout: "", stderr: "" } : ok("base\n");
		}
		if (args[0] === "diff" && args[1] === "--name-only") {
			const [from, to] = [args.at(-2) ?? "", args.at(-1) ?? ""];
			return ok(
				differing(revisions[from] ?? {}, revisions[to] ?? {})
					.map((file) => `${file}\0`)
					.join(""),
			);
		}
		if (args[0] === "show" && args[1] !== undefined) {
			const [rev, file] = args[1].split(/:(.*)/s);
			const text = revisions[rev ?? ""]?.[file ?? ""];
			return text === undefined || text === null
				? { code: 128, stdout: "", stderr: "fatal: path does not exist in the given revision" }
				: ok(text);
		}
		if (key === "pull --no-rebase --no-edit") return ok();
		return assert.fail(`unexpected git call: ${key}`);
	};
	return { run, calls };
}

interface Revisions {
	base: Record<string, string | null>;
	head: Record<string, string | null>;
	upstream: Record<string, string | null>;
}

const ledger = (file: string) => file.startsWith("graph/") && file.endsWith(".jsonl");
const stageEntry = (stage: number, file: string) => `100644 aaa${stage} ${stage}\t${file}\0`;

/**
 * What git leaves unmerged for these revisions: a path both sides changed stays conflicted, except a graph ledger,
 * which the documented `merge=union` attribute merges cleanly.
 */
function unmergedStages(versions: Revisions): string {
	const files = new Set([...Object.keys(versions.head), ...Object.keys(versions.upstream)]);
	const entries: string[] = [];
	for (const file of files) {
		const local = versions.head[file] ?? null;
		const remote = versions.upstream[file] ?? null;
		if (local === remote || ledger(file) || (local === null && remote === null)) continue;
		entries.push(stageEntry(1, file));
		if (local !== null) entries.push(stageEntry(2, file));
		if (remote !== null) entries.push(stageEntry(3, file));
	}
	return entries.join("");
}

/**
 * Fake git for a diverged pull whose upstream changed paths this computer pruned. It applies
 * `merge --no-ff --no-commit` to the working tree the way git does — a union merge for a ledger, a conflict for
 * a modify/delete — and records every spawned command, so tests assert both the calls and the files left behind.
 */
function incoming(
	versions: Revisions,
	options: {
		branchLine?: string;
		mergeFails?: boolean;
		commitFails?: boolean;
		unmergedFails?: boolean;
		/** Paths with an uncommitted working-tree change, reported by `status` as ` M <path>`. */
		dirty?: readonly string[];
	} = {},
) {
	const calls: string[][] = [];
	let unmerged = "";
	let mergeHead = false;
	const pathIn = (cwd: string, file: string) => path.join(cwd, file);
	const write = (cwd: string, file: string, text: string) => {
		mkdirSync(path.dirname(pathIn(cwd, file)), { recursive: true });
		writeFileSync(pathIn(cwd, file), text);
	};
	const lines = (text: string) => text.split("\n").filter((line, i, all) => !(line === "" && i === all.length - 1));
	const revision = (name: string) =>
		name === "HEAD" ? versions.head : name === "@{upstream}" ? versions.upstream : versions.base;
	const mergeResult = (cwd: string) => {
		for (const file of new Set([...Object.keys(versions.head), ...Object.keys(versions.upstream)])) {
			const local = versions.head[file] ?? null;
			const remote = versions.upstream[file] ?? null;
			if (local !== null && remote !== null && ledger(file)) {
				// The union attribute merges both sides line by line, bringing the pruned lines back.
				const merged = lines(local);
				for (const line of lines(remote)) if (!merged.includes(line)) merged.push(line);
				write(cwd, file, merged.length ? `${merged.join("\n")}\n` : "");
			} else if (remote !== null) write(cwd, file, remote);
		}
	};
	const run: GitRunner = async (args, { cwd }) => {
		calls.push([...args]);
		const key = args.join(" ");
		if (key === STATUS.join(" ")) {
			const dirty = (options.dirty ?? []).map((file) => ` M ${file}\0`).join("");
			return ok(`## ${options.branchLine ?? "main...origin/main [ahead 1, behind 1]"}\0${dirty}`);
		}
		if (key === FETCH.join(" ")) return ok();
		if (key === HEAD.join(" ")) return ok(calls.some((call) => call[0] === "pull") ? "merged\n" : "local\n");
		if (key === MERGING.join(" ")) return mergeHead ? ok("merged\n") : { code: 1, stdout: "", stderr: "" };
		if (key.startsWith("rev-parse -q --verify ")) return { code: 1, stdout: "", stderr: "" };
		if (key === REBASE_DIRS.join(" ")) return ok("/nonexistent/rebase-merge\n/nonexistent/rebase-apply\n");
		if (key === UNMERGED.join(" ")) {
			if (options.unmergedFails === true && mergeHead) return { code: 128, stdout: "", stderr: "fatal: index locked" };
			return ok(unmerged);
		}
		if (key === MERGE_BASE.join(" ")) return ok("base\n");
		if (args[0] === "diff" && args[1] === "--name-only") {
			const changed = differing(revision(args.at(-2) ?? ""), revision(args.at(-1) ?? ""));
			return ok(changed.map((file) => `${file}\0`).join(""));
		}
		if (args[0] === "show") {
			const [name, file] = (args[1] ?? "").split(/:(.*)/s);
			const text = revision(name ?? "")[file ?? ""] ?? null;
			return text === null
				? { code: 128, stdout: "", stderr: "fatal: path does not exist in the given revision" }
				: ok(text);
		}
		if (key === MERGE_UPSTREAM.join(" ")) {
			if (options.mergeFails === true) return { code: 128, stdout: "", stderr: "fatal: cannot merge" };
			mergeResult(cwd);
			unmerged = unmergedStages(versions);
			mergeHead = true;
			return { code: unmerged ? 1 : 0, stdout: "Auto-merging\n", stderr: "" };
		}
		if (key === "merge --abort") {
			for (const [file, text] of Object.entries(versions.head)) {
				if (text === null) rmSync(pathIn(cwd, file), { force: true });
				else write(cwd, file, text);
			}
			unmerged = "";
			mergeHead = false;
			return ok();
		}
		if (args[0] === LIT && args[1] === "add") return ok();
		if (args[0] === LIT && args[1] === "rm") {
			rmSync(pathIn(cwd, args.at(-1) ?? ""), { force: true });
			return ok();
		}
		if (key === COMMIT_MERGE.join(" ")) {
			if (options.commitFails === true) return { code: 1, stdout: "", stderr: "fatal: cannot commit" };
			unmerged = "";
			mergeHead = false;
			return ok();
		}
		// An ordinary pull: the merge changes nothing in the working tree, so an uncommitted edit stays.
		if (key === "pull --no-rebase --no-edit") return ok("Merge made by the 'ort' strategy.\n");
		return assert.fail(`unexpected git call: ${key}`);
	};
	return { run, calls };
}

const sequence = (git: { calls: string[][] }) => git.calls.map((call) => call.join(" "));

describe("pull", () => {
	test("S1 an incoming ledger change does not resurrect the records this computer removed", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-s1-"));
		try {
			const file = "graph/nodes.jsonl";
			const base = '{"id":1}\n{"id":2}\n';
			const head = '{"id":2}\n';
			const upstream = '{"id":1}\n{"id":2}\n{"id":3}\n';
			await fs.mkdir(path.join(tmp, "graph"));
			await fs.writeFile(path.join(tmp, file), head);
			const git = incoming({ base: { [file]: base }, head: { [file]: head }, upstream: { [file]: upstream } });
			assert.equal(await createGit(git.run, tmp).pull({ mode: "auto", now: NOW }), "pulled");
			// The record this computer deleted stays gone, the remote's new record is kept, in one merge commit.
			assert.equal(await fs.readFile(path.join(tmp, file), "utf8"), '{"id":2}\n{"id":3}\n');
			assert.deepEqual(sequence(git), [
				"status --porcelain=v1 --branch -z -uall",
				"rev-parse -q --verify MERGE_HEAD",
				"rev-parse -q --verify CHERRY_PICK_HEAD",
				"rev-parse -q --verify REVERT_HEAD",
				"rev-parse --git-path rebase-merge --git-path rebase-apply",
				"ls-files -u -z",
				"rev-parse -q --verify HEAD",
				"fetch",
				"status --porcelain=v1 --branch -z -uall",
				"merge-base HEAD @{upstream}",
				"diff --name-only -z base HEAD",
				"diff --name-only -z base @{upstream}",
				`show base:${file}`,
				`show HEAD:${file}`,
				`show @{upstream}:${file}`,
				"merge --no-ff --no-commit @{upstream}",
				"ls-files -u -z",
				`--literal-pathspecs add -- ${file}`,
				"commit --no-edit -q",
			]);
			// The upstream version this repair replaced is kept aside, outside the repository.
			assert.equal(await fs.readFile(path.join(tmp, BACKUP, file), "utf8"), upstream);
			assert.equal(await fs.readFile(path.join(tmp, ".git", "info", "exclude"), "utf8"), ".learnharness-git-backup/\n");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
	test("S1 a chat this computer deleted stays deleted when the remote edited it", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-s1-"));
		try {
			const file = "chats/linear-algebra.json";
			const base = '{"updatedAt":"2026-11-11T21:00:00.000Z","messages":[]}';
			const upstream = '{"updatedAt":"2026-11-12T21:00:00.000Z","messages":["remote"]}';
			const git = incoming({ base: { [file]: base }, head: {}, upstream: { [file]: upstream } });
			assert.equal(await createGit(git.run, tmp).pull({ mode: "auto", now: NOW }), "pulled");
			assert.equal(await fs.stat(path.join(tmp, file)).catch(() => null), null);
			assert.equal(await fs.readFile(path.join(tmp, BACKUP, file), "utf8"), upstream);
			const spawned = sequence(git);
			assert.deepEqual(spawned.slice(-5), [
				"merge --no-ff --no-commit @{upstream}",
				"rev-parse -q --verify MERGE_HEAD",
				"ls-files -u -z",
				`--literal-pathspecs rm -q -- ${file}`,
				"commit --no-edit -q",
			]);
			assert.equal(
				spawned.some((call) => call.startsWith("pull") || call.startsWith("push")),
				false,
			);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
	test("S1 a repair that cannot complete aborts the merge, leaves the files alone and commits nothing", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-s1-"));
		try {
			const file = "graph/nodes.jsonl";
			const notes = "notes.md";
			const head = { [file]: '{"id":2}\n', [notes]: "local notes\n" };
			await fs.mkdir(path.join(tmp, "graph"));
			await fs.writeFile(path.join(tmp, file), head[file]);
			await fs.writeFile(path.join(tmp, notes), head[notes]);
			const git = incoming({
				base: { [file]: '{"id":1}\n{"id":2}\n', [notes]: "base notes\n" },
				head,
				upstream: { [file]: '{"id":1}\n{"id":2}\n{"id":3}\n', [notes]: "remote notes\n" },
			});
			const result = await createGit(git.run, tmp)
				.pull({ mode: "auto", now: NOW })
				.catch((error: unknown) => error);
			assert.ok(result instanceof ConflictError);
			assert.equal(result.message, "Merge conflict with origin/main. Pull aborted; no files changed.");
			assert.deepEqual(result.files, [notes]);
			assert.equal(await fs.readFile(path.join(tmp, file), "utf8"), head[file]);
			assert.equal(await fs.readFile(path.join(tmp, notes), "utf8"), head[notes]);
			const spawned = sequence(git);
			assert.equal(spawned.includes("merge --abort"), true);
			assert.equal(
				spawned.some((call) => call.startsWith("commit") || call.startsWith("pull") || call.startsWith("push")),
				false,
			);
			assert.equal(await fs.stat(path.join(tmp, ".learnharness-git-backup")).catch(() => null), null);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
	test("S1 a merge that cannot start reports git's error and changes nothing", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-s1-"));
		try {
			const file = "graph/nodes.jsonl";
			const head = '{"id":2}\n';
			await fs.mkdir(path.join(tmp, "graph"));
			await fs.writeFile(path.join(tmp, file), head);
			const git = incoming(
				{
					base: { [file]: '{"id":1}\n{"id":2}\n' },
					head: { [file]: head },
					upstream: { [file]: '{"id":1}\n{"id":2}\n{"id":3}\n' },
				},
				{ mergeFails: true },
			);
			await assert.rejects(createGit(git.run, tmp).pull({ mode: "auto", now: NOW }), {
				name: "GitError",
				message: "git merge failed: fatal: cannot merge",
			});
			assert.equal(await fs.readFile(path.join(tmp, file), "utf8"), head);
			assert.equal(
				sequence(git).some((call) => call.startsWith("commit") || call.startsWith("pull")),
				false,
			);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
	test("S1 a repair whose commit fails aborts the merge and reports git's error", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-s1-"));
		try {
			const file = "graph/nodes.jsonl";
			const head = '{"id":2}\n';
			await fs.mkdir(path.join(tmp, "graph"));
			await fs.writeFile(path.join(tmp, file), head);
			const git = incoming(
				{
					base: { [file]: '{"id":1}\n{"id":2}\n' },
					head: { [file]: head },
					upstream: { [file]: '{"id":1}\n{"id":2}\n{"id":3}\n' },
				},
				{ commitFails: true },
			);
			await assert.rejects(createGit(git.run, tmp).pull({ mode: "auto", now: NOW }), {
				name: "GitError",
				message: "git commit failed: fatal: cannot commit",
			});
			// The merge is aborted: the ledger is back to what this computer had and no commit was made.
			assert.equal(await fs.readFile(path.join(tmp, file), "utf8"), head);
			const spawned = sequence(git);
			assert.deepEqual(spawned.slice(-2), ["commit --no-edit -q", "merge --abort"]);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
	test("S1 a repair that cannot read the merge state aborts it and reports git's error", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-s1-"));
		try {
			const file = "graph/nodes.jsonl";
			const head = '{"id":2}\n';
			await fs.mkdir(path.join(tmp, "graph"));
			await fs.writeFile(path.join(tmp, file), head);
			const git = incoming(
				{
					base: { [file]: '{"id":1}\n{"id":2}\n' },
					head: { [file]: head },
					upstream: { [file]: '{"id":1}\n{"id":2}\n{"id":3}\n' },
				},
				{ unmergedFails: true },
			);
			await assert.rejects(createGit(git.run, tmp).pull({ mode: "auto", now: NOW }), {
				name: "GitError",
				message: "git ls-files failed: fatal: index locked",
			});
			assert.equal(await fs.readFile(path.join(tmp, file), "utf8"), head);
			assert.equal(sequence(git).at(-1), "merge --abort");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
	test("a graph deletion the remote did not touch pulls normally", async () => {
		const git = diverged({ base: graph('"a"\n"b"\n'), head: graph('"a"\n'), upstream: graph('"a"\n"b"\n') });
		assert.equal(await createGit(git.run, dir).pull(), "pulled");
		assert.deepEqual(
			git.calls.filter((call) => ["pull", "merge", "commit", "push"].includes(call[0] ?? "")),
			[["pull", "--no-rebase", "--no-edit"]],
		);
	});
	test("a ledger both sides only added to pulls normally", async () => {
		const git = diverged({ base: graph('"a"\n'), head: graph('"a"\n"local"\n'), upstream: graph('"a"\n"remote"\n') });
		assert.equal(await createGit(git.run, dir).pull(), "pulled");
		assert.deepEqual(
			git.calls.filter((call) => ["pull", "merge", "commit", "push"].includes(call[0] ?? "")),
			[["pull", "--no-rebase", "--no-edit"]],
		);
	});
	test("S1 a whole ledger file deleted here and edited upstream keeps the ordinary pull", async () => {
		const git = diverged({ base: graph('"a"\n'), head: {}, upstream: graph('"a"\n"edited"\n') });
		assert.equal(await createGit(git.run, dir).pull({ mode: "auto" }), "pulled");
		assert.deepEqual(
			git.calls.filter((call) => ["pull", "merge", "commit", "push"].includes(call[0] ?? "")),
			[["pull", "--no-rebase", "--no-edit"]],
		);
	});
	test("S1 repairs only the paths whose local lines were pruned, keeping both sides' additions", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-s1-"));
		try {
			const pruned = "graph/nodes.jsonl";
			const added = "graph/edges.jsonl";
			await fs.mkdir(path.join(tmp, "graph"));
			await fs.writeFile(path.join(tmp, pruned), '"n2"\n');
			await fs.writeFile(path.join(tmp, added), '"e1"\n"local"\n');
			const git = incoming({
				base: { [pruned]: '"n1"\n"n2"\n', [added]: '"e1"\n' },
				head: { [pruned]: '"n2"\n', [added]: '"e1"\n"local"\n' },
				upstream: { [pruned]: '"n1"\n"n2"\n"n3"\n', [added]: '"e1"\n"remote"\n' },
			});
			assert.equal(await createGit(git.run, tmp).pull({ mode: "auto", now: NOW }), "pulled");
			assert.equal(await fs.readFile(path.join(tmp, pruned), "utf8"), '"n2"\n"n3"\n');
			assert.equal(await fs.readFile(path.join(tmp, added), "utf8"), '"e1"\n"local"\n"remote"\n');
			assert.deepEqual(
				sequence(git).filter((call) => call.startsWith("show @{upstream}")),
				[`show @{upstream}:${pruned}`],
			);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
	test("a path outside the ledgers and chats keeps the ordinary pull", async () => {
		const git = diverged({
			base: { "notes.md": "base\n" },
			head: { "notes.md": "local\n" },
			upstream: { "notes.md": "remote\n" },
		});
		assert.equal(await createGit(git.run, dir).pull({ mode: "auto" }), "pulled");
		assert.deepEqual(
			git.calls.filter((call) => call[0] === "show" || call[0] === "merge"),
			[],
		);
	});
	test("a chat untouched here and edited upstream pulls normally", async () => {
		const file = "chats/a.json";
		const base = '{"updatedAt":"2026-11-11T21:00:00.000Z"}';
		const git = diverged({
			base: { [file]: base },
			head: { [file]: base },
			upstream: { [file]: '{"updatedAt":"2026-11-12T21:00:00.000Z"}' },
		});
		assert.equal(await createGit(git.run, dir).pull({ mode: "auto" }), "pulled");
		assert.deepEqual(
			git.calls.filter((call) => ["pull", "merge", "commit", "push"].includes(call[0] ?? "")),
			[["pull", "--no-rebase", "--no-edit"]],
		);
	});
	test("local additions only pull normally", async () => {
		const git = diverged({
			base: graph('"a"\n'),
			head: graph('"a"\n"local"\n'),
			upstream: graph('"a"\n'),
		});
		assert.equal(await createGit(git.run, dir).pull({ mode: "auto" }), "pulled");
		assert.deepEqual(
			git.calls.filter((call) => ["pull", "merge", "commit", "push"].includes(call[0] ?? "")),
			[["pull", "--no-rebase", "--no-edit"]],
		);
	});
	test("unrelated histories keep the ordinary pull", async () => {
		const git = diverged({ base: graph('"a"\n'), head: {}, upstream: graph('"a"\n"edited"\n') }, { mergeBase: false });
		assert.equal(await createGit(git.run, dir).pull(), "pulled");
		assert.deepEqual(
			git.calls.filter((call) => call[0] === "show"),
			[],
		);
	});
	test("a fast-forward is not inspected before pulling", async () => {
		const git = diverged(
			{ base: graph('"a"\n'), head: {}, upstream: graph('"a"\n"edited"\n') },
			{ branchLine: "main...origin/main [behind 2]" },
		);
		assert.equal(await createGit(git.run, dir).pull(), "pulled");
		assert.deepEqual(
			git.calls.filter((call) => call[0] === "merge-base" || call[0] === "show"),
			[],
		);
	});
	test("S1 the documented merge=union attribute does not bring a deleted record back", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-s1-"));
		try {
			const attributes = "graph/*.jsonl merge=union\n";
			const file = "graph/nodes.jsonl";
			await fs.mkdir(path.join(tmp, "graph"));
			await fs.writeFile(path.join(tmp, ".gitattributes"), attributes);
			await fs.writeFile(path.join(tmp, file), '"b"\n');
			const git = incoming({
				base: { [file]: '"a"\n"b"\n' },
				head: { [file]: '"b"\n' },
				upstream: { [file]: '"a"\n"b"\n"c"\n' },
			});
			assert.equal(await createGit(git.run, tmp).pull({ mode: "auto", now: NOW }), "pulled");
			assert.equal(await fs.readFile(path.join(tmp, file), "utf8"), '"b"\n"c"\n');
			// The plugin reads the ledgers itself and never rewrites the attribute file.
			assert.equal(await fs.readFile(path.join(tmp, ".gitattributes"), "utf8"), attributes);
			assert.deepEqual(
				sequence(git).filter((call) => call.includes("check-attr") || call.includes("config")),
				[],
			);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
	test("S1 a record the upstream deleted stays deleted next to the one this computer deleted", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-s1-"));
		try {
			const file = "graph/nodes.jsonl";
			const base = '{"id":"A"}\n{"id":"B"}\n{"id":"C"}\n{"id":"D"}\n{"id":"E"}\n';
			// This computer deleted C; the upstream deleted B and added F.
			const head = '{"id":"A"}\n{"id":"B"}\n{"id":"D"}\n{"id":"E"}\n';
			const upstream = '{"id":"A"}\n{"id":"C"}\n{"id":"D"}\n{"id":"E"}\n{"id":"F"}\n';
			const merged = '{"id":"A"}\n{"id":"D"}\n{"id":"E"}\n{"id":"F"}\n';
			await fs.mkdir(path.join(tmp, "graph"));
			await fs.writeFile(path.join(tmp, file), head);
			const git = incoming({ base: { [file]: base }, head: { [file]: head }, upstream: { [file]: upstream } });
			assert.equal(await createGit(git.run, tmp).pull({ mode: "auto", now: NOW }), "pulled");
			// Neither deletion is undone and the upstream's new record is kept.
			assert.equal(await fs.readFile(path.join(tmp, file), "utf8"), merged);
			const spawned = sequence(git);
			assert.deepEqual(
				spawned.filter((call) => call.startsWith("commit")),
				["commit --no-edit -q"],
			);
			// The union attribute would have brought B and C back, so the repair never runs a pull.
			assert.equal(
				spawned.some((call) => call.startsWith("pull")),
				false,
			);
			// The discarded upstream version is kept, so nothing the remote wrote is lost.
			assert.equal(await fs.readFile(path.join(tmp, BACKUP, file), "utf8"), upstream);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
	test("S1 a repair that would overwrite an uncommitted ledger edit refuses before any merge", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-s1-"));
		try {
			const file = "graph/nodes.jsonl";
			const head = '{"id":"A"}\n{"id":"B"}\n';
			const edited = '{"id":"A"}\n{"id":"B"}\n{"id":"draft"}\n';
			await fs.mkdir(path.join(tmp, "graph"));
			await fs.writeFile(path.join(tmp, file), edited);
			const git = incoming(
				{
					base: { [file]: '{"id":"A"}\n{"id":"B"}\n{"id":"C"}\n' },
					head: { [file]: head },
					upstream: { [file]: '{"id":"A"}\n{"id":"B"}\n{"id":"C"}\n{"id":"D"}\n' },
				},
				{ dirty: [file] },
			);
			await assert.rejects(createGit(git.run, tmp).pull({ mode: "auto", now: NOW }), {
				name: "Error",
				message: `Sync needs to rewrite ${file}, which has uncommitted changes. Commit or discard them, then pull again.`,
			});
			// The uncommitted edit is byte-identical: nothing was merged, staged, committed or pulled.
			assert.equal(await fs.readFile(path.join(tmp, file), "utf8"), edited);
			assert.deepEqual(sequence(git), [
				"status --porcelain=v1 --branch -z -uall",
				"rev-parse -q --verify MERGE_HEAD",
				"rev-parse -q --verify CHERRY_PICK_HEAD",
				"rev-parse -q --verify REVERT_HEAD",
				"rev-parse --git-path rebase-merge --git-path rebase-apply",
				"ls-files -u -z",
				"rev-parse -q --verify HEAD",
				"fetch",
				"status --porcelain=v1 --branch -z -uall",
				"merge-base HEAD @{upstream}",
				"diff --name-only -z base HEAD",
				"diff --name-only -z base @{upstream}",
				`show base:${file}`,
				`show HEAD:${file}`,
				`show @{upstream}:${file}`,
			]);
			assert.equal(await fs.stat(path.join(tmp, ".learnharness-git-backup")).catch(() => null), null);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
	test("S1 a ledger both sides already settled keeps the ordinary pull and an uncommitted edit", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-s1-"));
		try {
			const file = "graph/nodes.jsonl";
			// Both tips removed the same record, so the repair would write exactly the committed content.
			const settled = '{"id":"A"}\n{"id":"B"}\n';
			const edited = '{"id":"A"}\n{"id":"B"}\n{"id":"draft"}\n';
			await fs.mkdir(path.join(tmp, "graph"));
			await fs.writeFile(path.join(tmp, file), edited);
			const git = incoming(
				{
					base: { [file]: '{"id":"A"}\n{"id":"B"}\n{"id":"C"}\n' },
					head: { [file]: settled },
					upstream: { [file]: settled },
				},
				{ dirty: [file] },
			);
			assert.equal(await createGit(git.run, tmp).pull({ mode: "auto", now: NOW }), "pulled");
			// No repair is needed, so git is left to pull and the uncommitted edit survives untouched.
			assert.equal(await fs.readFile(path.join(tmp, file), "utf8"), edited);
			const spawned = sequence(git);
			assert.equal(spawned.at(-2), "pull --no-rebase --no-edit");
			// `merge-base` is read-only; no merge, commit or staging rewrote the file.
			assert.equal(
				spawned.some((call) => call.startsWith("merge --no-ff") || call.startsWith("commit") || call.includes(" add ")),
				false,
			);
			assert.equal(await fs.stat(path.join(tmp, ".learnharness-git-backup")).catch(() => null), null);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
	test("skips without an upstream", async () => {
		const fake = fakeGit([clean("main")]);
		assert.equal(await createGit(fake.run, dir).pull(), "no-upstream");
		fake.done();
	});
	test("reports pulled when HEAD moves", async () => {
		const fake = fakeGit([
			clean("main...origin/main [behind 1]"),
			...noMerge,
			{ args: HEAD, result: { stdout: "aaa\n" } },
			{ args: FETCH },
			clean("main...origin/main [behind 1]"),
			{ args: ["pull", "--no-rebase", "--no-edit"] },
			{ args: HEAD, result: { stdout: "bbb\n" } },
		]);
		assert.equal(await createGit(fake.run, dir).pull(), "pulled");
		fake.done();
	});
	test("fetches first so the divergence is read from the current upstream", async () => {
		const fake = fakeGit([
			clean("main...origin/main"),
			...noMerge,
			{ args: HEAD, result: { stdout: "aaa\n" } },
			{ args: FETCH },
			clean("main...origin/main [ahead 1, behind 1]"),
			{ args: MERGE_BASE, result: { code: 1 } },
			{ args: ["pull", "--no-rebase", "--no-edit"] },
			{ args: HEAD, result: { stdout: "bbb\n" } },
		]);
		assert.equal(await createGit(fake.run, dir).pull(), "pulled");
		fake.done();
	});
	test("reports up-to-date when HEAD stays", async () => {
		const fake = fakeGit([
			clean("main...origin/main"),
			...noMerge,
			{ args: HEAD, result: { stdout: "aaa\n" } },
			{ args: FETCH },
			clean("main...origin/main"),
			{ args: ["pull", "--no-rebase", "--no-edit"] },
			{ args: HEAD, result: { stdout: "aaa\n" } },
		]);
		assert.equal(await createGit(fake.run, dir).pull(), "up-to-date");
		fake.done();
	});
	test("leaves a merge the user started untouched and pulls nothing", async () => {
		const fake = fakeGit([clean("main...origin/main"), { args: MERGING, result: { stdout: "ccc\n" } }]);
		await assert.rejects(createGit(fake.run, dir).pull(), { name: "MergeInProgressError" });
		fake.done();
	});
	test("aborts a conflicting merge and throws ConflictError", async () => {
		const fake = fakeGit([
			clean("main...origin/main"),
			...noMerge,
			{ args: HEAD, result: { stdout: "aaa\n" } },
			{ args: FETCH },
			clean("main...origin/main"),
			{ args: ["pull", "--no-rebase", "--no-edit"], result: { code: 1, stdout: "CONFLICT (content)" } },
			{ args: ["rev-parse", "-q", "--verify", "MERGE_HEAD"], result: { stdout: "ccc\n" } },
			{
				args: UNMERGED,
				result: { stdout: "100644 a 1\tx.json\u0000100644 b 2\tx.json\u0000100644 c 3\tx.json\u0000" },
			},
			{ args: ["merge", "--abort"] },
		]);
		const error = await createGit(fake.run, dir)
			.pull()
			.catch((e: unknown) => e);
		assert.ok(error instanceof ConflictError);
		assert.equal(error.message, "Merge conflict with origin/main. Pull aborted; no files changed.");
		assert.equal(error.upstream, "origin/main");
		assert.deepEqual(error.files, ["x.json"]);
		fake.done();
	});
	test("throws GitError on other pull failures", async () => {
		const fake = fakeGit([
			clean("main...origin/main"),
			...noMerge,
			{ args: HEAD, result: { stdout: "aaa\n" } },
			{ args: FETCH },
			clean("main...origin/main"),
			{
				args: ["pull", "--no-rebase", "--no-edit"],
				result: { code: 1, stderr: "fatal: Could not read from remote repository." },
			},
			{ args: ["rev-parse", "-q", "--verify", "MERGE_HEAD"], result: { code: 1 } },
		]);
		await assert.rejects(createGit(fake.run, dir).pull(), {
			name: "GitError",
			message: "git pull failed: fatal: Could not read from remote repository.",
		});
		fake.done();
	});
});

describe("push", () => {
	test("skips without an upstream", async () => {
		const fake = fakeGit([clean("main")]);
		assert.equal(await createGit(fake.run, dir).push(), "no-upstream");
	});
	test("skips when nothing is ahead", async () => {
		const fake = fakeGit([clean("main...origin/main")]);
		assert.equal(await createGit(fake.run, dir).push(), "up-to-date");
	});
	test("pushes when the upstream branch is gone from the remote", async () => {
		const fake = fakeGit([clean("main...origin/main [gone]"), { args: ["push"] }]);
		assert.equal(await createGit(fake.run, dir).push(), "pushed");
		fake.done();
	});
	test("pushes commits that are ahead", async () => {
		const fake = fakeGit([clean("main...origin/main [ahead 3]"), { args: ["push"] }]);
		assert.equal(await createGit(fake.run, dir).push(), "pushed");
		fake.done();
	});
});

describe("log", () => {
	const LOG = [
		"-c",
		"core.quotePath=false",
		"log",
		"-n50",
		"--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s",
		"--name-status",
		"--diff-merges=first-parent",
	];
	test("returns no commits on an unborn branch", async () => {
		const fake = fakeGit([{ args: HEAD, result: { code: 1 } }]);
		assert.deepEqual(await createGit(fake.run, dir).log(50), []);
		fake.done();
	});
	test("parses commits with the files each one touched", async () => {
		const stdout =
			"\x1eaaaa1111\x1faaaa\x1fAda\x1f2026-11-12T10:00:00-03:00\x1fsecond\n\nM\tgraph.json\nR100\told.json\tnew.json\n" +
			"\x1ebbbb2222\x1fbbbb\x1fAda\x1f2026-11-11T09:00:00-03:00\x1fmerge\n\nM\tsettings.json\nA\tchats/b.json\n" +
			"\x1ecccc3333\x1fcccc\x1fAda\x1f2026-11-10T08:00:00-03:00\x1fempty merge\n";
		const fake = fakeGit([
			{ args: HEAD, result: { stdout: "aaaa1111\n" } },
			{ args: LOG, result: { stdout } },
		]);
		assert.deepEqual(await createGit(fake.run, dir).log(50), [
			{
				hash: "aaaa1111",
				shortHash: "aaaa",
				author: "Ada",
				date: "2026-11-12T10:00:00-03:00",
				subject: "second",
				files: [
					{ path: "graph.json", code: "M" },
					{ path: "new.json", from: "old.json", code: "R" },
				],
			},
			{
				hash: "bbbb2222",
				shortHash: "bbbb",
				author: "Ada",
				date: "2026-11-11T09:00:00-03:00",
				subject: "merge",
				files: [
					{ path: "settings.json", code: "M" },
					{ path: "chats/b.json", code: "A" },
				],
			},
			{
				hash: "cccc3333",
				shortHash: "cccc",
				author: "Ada",
				date: "2026-11-10T08:00:00-03:00",
				subject: "empty merge",
				files: [],
			},
		]);
		fake.done();
	});
});

describe("userName", () => {
	const CONFIG = ["config", "user.name"];
	test("returns the configured user name", async () => {
		const fake = fakeGit([{ args: CONFIG, result: { stdout: "Ada Lovelace\n" } }]);
		assert.equal(await createGit(fake.run, dir).userName(), "Ada Lovelace");
		assert.deepEqual(fake.calls, [{ args: CONFIG, cwd: dir }]);
		fake.done();
	});
	test("returns null when no user name is set or git fails", async () => {
		for (const result of [{ code: 1 }, { code: 0, stdout: "  \n" }, { code: 128, stderr: "fatal: bad config" }]) {
			const fake = fakeGit([{ args: CONFIG, result }]);
			assert.equal(await createGit(fake.run, dir).userName(), null);
			fake.done();
		}
	});
});

describe("remote", () => {
	const GET_URL = ["remote", "get-url", "origin"];
	const GET_PUSH = ["config", "--get-all", "remote.origin.pushurl"];
	const UNSET_PUSH = ["config", "--unset-all", "remote.origin.pushurl"];
	test("remoteUrl returns origin's URL, or null without origin", async () => {
		const fake = fakeGit([
			{ args: GET_URL, result: { stdout: "git@host:me/data.git\n" } },
			{ args: GET_URL, result: { code: 2, stderr: "error: No such remote 'origin'" } },
		]);
		const git = createGit(fake.run, dir);
		assert.equal(await git.remoteUrl(), "git@host:me/data.git");
		assert.equal(await git.remoteUrl(), null);
	});
	test("setRemote adds origin, or changes its URL, and drops any push URL", async () => {
		const fake = fakeGit([
			{ args: GET_URL, result: { code: 2 } },
			{ args: ["remote", "add", "origin", "git@host:me/data.git"] },
			{ args: UNSET_PUSH, result: { code: 5 } },
			{ args: GET_URL, result: { stdout: "old\n" } },
			{ args: ["remote", "set-url", "origin", "git@host:me/data.git"] },
			{ args: UNSET_PUSH },
		]);
		const git = createGit(fake.run, dir);
		await git.setRemote("git@host:me/data.git");
		await git.setRemote("git@host:me/data.git");
		fake.done();
	});
	test("pushUrls lists origin's push URLs, none when unset, and restorePushUrls adds them back", async () => {
		const fake = fakeGit([
			{ args: GET_PUSH, result: { code: 1 } },
			{ args: GET_PUSH, result: { stdout: "a\nb\n" } },
			{ args: ["config", "--add", "remote.origin.pushurl", "a"] },
			{ args: ["config", "--add", "remote.origin.pushurl", "b"] },
		]);
		const git = createGit(fake.run, dir);
		assert.deepEqual(await git.pushUrls(), []);
		assert.deepEqual(await git.pushUrls(), ["a", "b"]);
		await git.restorePushUrls(["a", "b"]);
		fake.done();
	});
	test("publish pushes the branch and sets its upstream", async () => {
		const fake = fakeGit([{ args: ["push", "-u", "origin", "main"] }]);
		await createGit(fake.run, dir).publish("main");
		fake.done();
	});
	test("listFiles lists tracked and untracked, non-ignored files", async () => {
		const fake = fakeGit([
			{
				args: ["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
				result: { stdout: "settings.json\0graph/nodes.jsonl\0" },
			},
		]);
		assert.deepEqual(await createGit(fake.run, dir).listFiles(), ["settings.json", "graph/nodes.jsonl"]);
	});
	const HISTORY = ["-c", "core.quotePath=false", "log", "main", "--name-only", "--format=", "-z"];
	test("historyFiles lists every path the branch history touched, once", async () => {
		const fake = fakeGit([
			{ args: ["rev-parse", "-q", "--verify", "main"], result: { stdout: "aaa\n" } },
			{ args: HISTORY, result: { stdout: "settings.json\0a.json\0\n\na.json\0b c.json\0" } },
		]);
		assert.deepEqual(await createGit(fake.run, dir).historyFiles("main"), ["settings.json", "a.json", "b c.json"]);
	});
	test("historyFiles is empty for a branch without commits", async () => {
		const fake = fakeGit([{ args: ["rev-parse", "-q", "--verify", "main"], result: { code: 1 } }]);
		assert.deepEqual(await createGit(fake.run, dir).historyFiles("main"), []);
		fake.done();
	});
	test("removeRemote removes origin", async () => {
		const fake = fakeGit([{ args: ["remote", "remove", "origin"] }]);
		await createGit(fake.run, dir).removeRemote();
		fake.done();
	});
});

describe("authentication failures", () => {
	const GET_URL = ["remote", "get-url", "origin"];
	const PULL = ["pull", "--no-rebase", "--no-edit"];
	const hint = (host: string, ssh: string) =>
		`Git authentication failed. No credentials for ${host}. Set up one, then retry: gh auth login && gh auth setup-git, or use an SSH URL (${ssh}).`;
	const UNKNOWN =
		"Git authentication failed. No credentials for the remote. Set up one, then retry: gh auth login && gh auth setup-git, or use an SSH URL.";
	const pullFailing = (stderr: string, url: { code?: number; stdout?: string }) =>
		fakeGit([
			clean("main...origin/main"),
			...noMerge,
			{ args: HEAD, result: { stdout: "aaa\n" } },
			{ args: FETCH },
			clean("main...origin/main"),
			{ args: PULL, result: { code: 1, stderr } },
			{ args: MERGING, result: { code: 1 } },
			{ args: GET_URL, result: url },
		]);
	const cases: [string, string, string][] = [
		[
			"fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
			"https://github.com/me/data.git\n",
			hint("github.com", "git@github.com:me/data.git"),
		],
		[
			"remote: Invalid username or password.\nfatal: Authentication failed for 'https://gitlab.com/me/data/'\n",
			"https://gitlab.com/me/data\n",
			hint("gitlab.com", "git@gitlab.com:me/data"),
		],
		[
			"git@github.com: Permission denied (publickey).\n",
			"git@github.com:me/data.git\n",
			hint("github.com", "git@github.com:me/data.git"),
		],
		[
			"fatal: Authentication failed\n",
			"ssh://git@codeberg.org/me/data.git\n",
			hint("codeberg.org", "git@codeberg.org:me/data.git"),
		],
		["fatal: Authentication failed\n", "/srv/git/data.git\n", UNKNOWN],
	];
	for (const [stderr, url, message] of cases) {
		test(`pull maps ${JSON.stringify(stderr.slice(0, 40))} from ${url.trim()} to an authentication hint`, async () => {
			const fake = pullFailing(stderr, { stdout: url });
			const error = await createGit(fake.run, dir)
				.pull()
				.catch((e: unknown) => e);
			assert.ok(error instanceof AuthError);
			assert.equal(error.message, message);
			assert.equal(error.detail, stderr.trim());
			fake.done();
		});
	}
	test("pull without origin still gives the hint", async () => {
		const fake = pullFailing("fatal: Authentication failed\n", { code: 2 });
		await assert.rejects(createGit(fake.run, dir).pull(), { name: "AuthError", message: UNKNOWN });
		fake.done();
	});
	test("push maps an authentication failure", async () => {
		const fake = fakeGit([
			clean("main...origin/main [ahead 1]"),
			{ args: ["push"], result: { code: 128, stderr: "fatal: could not read Username: terminal prompts disabled" } },
			{ args: GET_URL, result: { stdout: "https://github.com/me/data.git\n" } },
		]);
		await assert.rejects(createGit(fake.run, dir).push(), {
			name: "AuthError",
			message: hint("github.com", "git@github.com:me/data.git"),
		});
		fake.done();
	});
	test("publish (connect remote) maps an authentication failure", async () => {
		const fake = fakeGit([
			{ args: ["push", "-u", "origin", "main"], result: { code: 128, stderr: "Permission denied (publickey)." } },
			{ args: GET_URL, result: { stdout: "git@github.com:me/data.git\n" } },
		]);
		await assert.rejects(createGit(fake.run, dir).publish("main"), {
			name: "AuthError",
			message: hint("github.com", "git@github.com:me/data.git"),
		});
		fake.done();
	});
	test("other failures keep git's message", async () => {
		const fake = fakeGit([
			clean("main...origin/main [ahead 1]"),
			{ args: ["push"], result: { code: 1, stderr: "! [rejected] main -> main (fetch first)" } },
		]);
		await assert.rejects(createGit(fake.run, dir).push(), {
			name: "GitError",
			message: "git push failed: ! [rejected] main -> main (fetch first)",
		});
		fake.done();
	});
});

describe("plugins installed with git clone (nested repositories)", () => {
	const GIT_PATH = ["rev-parse", "--git-path", "info/exclude"];
	const EXCLUDE = ".git/info/exclude";
	const block = (...ids: string[]) =>
		`# learnharness-git: plugins installed with git clone\n${ids.map((id) => `/plugins/${id}/\n`).join("")}# end learnharness-git\n`;
	let tmp = "";
	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-nested-"));
	});
	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});
	const read = (file: string) => fs.readFile(path.join(tmp, file), "utf8");
	const exists = (file: string) =>
		fs.lstat(path.join(tmp, file)).then(
			() => true,
			() => false,
		);
	/** plugins/<id>/ with a `.git` folder (a clone) or a `.git` file (a worktree or submodule). */
	async function plugin(id: string, git: "dir" | "file" | null): Promise<void> {
		await fs.mkdir(path.join(tmp, "plugins", id, "data"), { recursive: true });
		await fs.writeFile(path.join(tmp, "plugins", id, "data", "s.json"), "{}");
		if (git === "dir") await fs.mkdir(path.join(tmp, "plugins", id, ".git"));
		if (git === "file") await fs.writeFile(path.join(tmp, "plugins", id, ".git"), "gitdir: /elsewhere\n");
	}
	const commitAll = (gitPath: string) => [
		...noMerge,
		{ args: GIT_PATH, result: { stdout: `${gitPath}\n` } },
		{ args: ["add", "-A"] },
		{ args: ["diff", "--cached", "--quiet"], result: { code: 1 } },
		{ args: ["commit", "-q", "-m", "msg"] },
	];

	test("commit excludes every plugin folder holding a .git folder or file, before staging", async () => {
		await plugin("learnharness-git", "dir");
		await plugin("worktree", "file");
		await plugin("a[1]*?", "dir");
		await plugin("plain", null);
		// A symlinked plugin folder is stored by git as a symlink, never as an embedded repository.
		await fs.mkdir(path.join(tmp, "outside", ".git"), { recursive: true });
		await fs.symlink(path.join(tmp, "outside"), path.join(tmp, "plugins", "linked"));
		await fs.writeFile(path.join(tmp, "plugins", "notes.txt"), "");
		const fake = fakeGit(commitAll(EXCLUDE));
		assert.deepEqual(await createGit(fake.run, tmp).commit("msg", { all: true }), { committed: true });
		fake.done();
		assert.deepEqual(
			fake.calls.map((c) => c.args),
			commitAll(EXCLUDE).map((c) => c.args),
		);
		assert.equal(await read(EXCLUDE), block("a\\[1]\\*\\?", "learnharness-git", "worktree"));
		assert.equal(await read(".gitignore").catch(() => null), null);
	});
	test("keeps existing exclude content byte-identical and writes the block once across commits", async () => {
		await plugin("learnharness-git", "dir");
		await plugin("other", "dir");
		await fs.mkdir(path.join(tmp, ".git", "info"), { recursive: true });
		await fs.writeFile(path.join(tmp, EXCLUDE), "# mine\r\n/plugins/other/\n.learnharness-git-backup/");
		const fake = fakeGit([...commitAll(EXCLUDE), ...commitAll(EXCLUDE)]);
		const git = createGit(fake.run, tmp);
		await git.commit("msg", { all: true });
		const once = await read(EXCLUDE);
		await fs.chmod(path.join(tmp, EXCLUDE), 0o444); // an unchanged block is not rewritten
		await git.commit("msg", { all: true });
		fake.done();
		assert.equal(once, `# mine\r\n/plugins/other/\n.learnharness-git-backup/\n${block("learnharness-git", "other")}`);
		assert.equal(await read(EXCLUDE), once);
	});
	test("drops the block once no plugin is a nested repository, keeping the user's lines", async () => {
		await plugin("learnharness-git", "dir");
		await fs.mkdir(path.join(tmp, ".git", "info"), { recursive: true });
		await fs.writeFile(path.join(tmp, EXCLUDE), "# mine\r\n.learnharness-git-backup/");
		const fake = fakeGit([...commitAll(EXCLUDE), ...commitAll(EXCLUDE).filter((c) => c.args !== GIT_PATH)]);
		const git = createGit(fake.run, tmp);
		await git.commit("msg", { all: true });
		// Reinstalled normally under the same name: an ordinary folder that must be backed up again.
		await fs.rm(path.join(tmp, "plugins", "learnharness-git", ".git"), { recursive: true });
		await git.commit("msg", { all: true });
		fake.done();
		assert.equal(await read(EXCLUDE), "# mine\r\n.learnharness-git-backup/\n");
	});
	test("in a worktree (.git file) git is asked where the stale block is", async () => {
		await fs.writeFile(path.join(tmp, ".git"), "gitdir: common\n");
		await fs.writeFile(path.join(tmp, "exclude"), `x\n${block("old")}`);
		const gitPath = { args: GIT_PATH, result: { stdout: "exclude\n" } };
		const fake = fakeGit([gitPath, { args: ["--literal-pathspecs", "add", "-A"] }]);
		await createGit(fake.run, tmp).stage([]);
		fake.done();
		assert.equal(await read("exclude"), "x\n");
	});
	test("a plugin name with a line break stops before the exclude file or git is touched", async () => {
		await plugin("a\nconfig.json\nb", "dir");
		await fs.mkdir(path.join(tmp, ".git", "info"), { recursive: true });
		await fs.writeFile(path.join(tmp, EXCLUDE), "# mine\n");
		const fake = fakeGit(noMerge);
		await assert.rejects(createGit(fake.run, tmp).commit("msg", { all: true }), {
			message:
				'Could not keep "plugins/a\\nconfig.json\\nb/" (its own Git repository) out of the backup: its name has a line break. Rename the folder.',
		});
		fake.done();
		assert.equal(await read(EXCLUDE), "# mine\n");
	});
	test("uses the exclude file git reports (worktree git dir), creating its folder", async () => {
		await plugin("learnharness-git", "dir");
		const elsewhere = path.join(tmp, "common", "info", "exclude");
		const fake = fakeGit(commitAll(elsewhere));
		await createGit(fake.run, tmp).commit("msg", { all: true });
		fake.done();
		assert.equal(await fs.readFile(elsewhere, "utf8"), block("learnharness-git"));
		assert.equal(await exists(".git"), false);
	});
	test("without a nested repository nothing is excluded and git is not asked", async () => {
		await plugin("plain", null);
		const fake = fakeGit([
			...noMerge,
			{ args: ["add", "-A"] },
			{ args: ["diff", "--cached", "--quiet"], result: { code: 1 } },
			{ args: ["commit", "-q", "-m", "msg"] },
		]);
		await createGit(fake.run, tmp).commit("msg", { all: true });
		fake.done();
		assert.equal(await exists(".git"), false);
	});
	test("a failed exclude write stops before anything is staged or committed", async () => {
		await plugin("learnharness-git", "dir");
		await plugin("other", "file");
		// The exclude path is a folder, so it cannot be read or appended to.
		await fs.mkdir(path.join(tmp, EXCLUDE), { recursive: true });
		const fake = fakeGit([...noMerge, { args: GIT_PATH, result: { stdout: `${EXCLUDE}\n` } }]);
		await assert.rejects(createGit(fake.run, tmp).commit("msg", { all: true }), {
			message:
				"Could not keep plugins/learnharness-git/, plugins/other/ (each its own Git repository) out of the backup: .git/info/exclude could not be written (EISDIR).",
		});
		fake.done();
	});
	test("Initialize excludes them right after creating the repository", async () => {
		await plugin("learnharness-git", "dir");
		const fake = fakeGit([{ args: ["init", "-b", "main"] }, { args: GIT_PATH, result: { stdout: `${EXCLUDE}\n` } }]);
		await createGit(fake.run, tmp).init();
		fake.done();
		assert.equal(await read(EXCLUDE), block("learnharness-git"));
		assert.equal((await read(".gitignore")).includes("learnharness-git"), false);
	});
	test("S1 a ledger the app emptied here keeps only the upstream's new records", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-s1-"));
		try {
			const file = "graph/nodes.jsonl";
			await fs.mkdir(path.join(tmp, "graph"));
			await fs.writeFile(path.join(tmp, file), "");
			const git = incoming({
				base: { [file]: '{"id":1}\n{"id":2}\n' },
				head: { [file]: "" },
				upstream: { [file]: '{"id":1}\n{"id":2}\n{"id":3}\n' },
			});
			assert.equal(await createGit(git.run, tmp).pull({ mode: "auto", now: NOW }), "pulled");
			assert.equal(await fs.readFile(path.join(tmp, file), "utf8"), '{"id":3}\n');
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
	test("status, stage and listFiles exclude them first, so they are never listed or staged", async () => {
		await plugin("learnharness-git", "dir");
		const LS = ["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"];
		const gitPath = { args: GIT_PATH, result: { stdout: `${EXCLUDE}\n` } };
		const fake = fakeGit([
			gitPath,
			{ args: STATUS, result: { stdout: "## main\0" } },
			gitPath,
			{ args: ["--literal-pathspecs", "add", "-A", "--", "plugins"] },
			gitPath,
			{ args: LS, result: { stdout: "settings.json\0" } },
		]);
		const git = createGit(fake.run, tmp);
		assert.deepEqual((await git.status()).unstaged, []);
		await git.stage(["plugins"]);
		assert.deepEqual(await git.listFiles(), ["settings.json"]);
		fake.done();
		assert.equal(await read(EXCLUDE), block("learnharness-git"));
	});
});
