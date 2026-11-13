import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { ConflictError, createGit, GitError } from "../src/git.ts";
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
	test("init creates a repository on branch main", async () => {
		const fake = fakeGit([{ args: ["init", "-b", "main"] }]);
		await createGit(fake.run, dir).init();
		fake.done();
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
			message:
				"A merge or unresolved conflict is in progress in the learning data folder. Finish or abort it with git; the plugin will not commit or pull until then.",
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
			message:
				"A merge or unresolved conflict is in progress in the learning data folder. Finish or abort it with git; the plugin will not commit or pull until then.",
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

describe("pull", () => {
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
			{ args: ["pull", "--no-rebase", "--no-edit"] },
			{ args: HEAD, result: { stdout: "aaa\n" } },
		]);
		assert.equal(await createGit(fake.run, dir).pull(), "up-to-date");
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
			{ args: ["pull", "--no-rebase", "--no-edit"], result: { code: 1, stdout: "CONFLICT (content)" } },
			{ args: ["rev-parse", "-q", "--verify", "MERGE_HEAD"], result: { stdout: "ccc\n" } },
			{ args: ["merge", "--abort"] },
		]);
		const error = await createGit(fake.run, dir)
			.pull()
			.catch((e: unknown) => e);
		assert.ok(error instanceof ConflictError);
		assert.equal(
			error.message,
			"Pull stopped by a merge conflict. The merge was aborted and your files are unchanged; resolve it manually with git.",
		);
		fake.done();
	});
	test("throws GitError on other pull failures", async () => {
		const fake = fakeGit([
			clean("main...origin/main"),
			...noMerge,
			{ args: HEAD, result: { stdout: "aaa\n" } },
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
	];
	test("returns no commits on an unborn branch", async () => {
		const fake = fakeGit([{ args: HEAD, result: { code: 1 } }]);
		assert.deepEqual(await createGit(fake.run, dir).log(50), []);
		fake.done();
	});
	test("parses commits with the files each one touched", async () => {
		const stdout =
			"\x1eaaaa1111\x1faaaa\x1fAda\x1f2026-11-12T10:00:00-03:00\x1fsecond\n\nM\tgraph.json\nR100\told.json\tnew.json\n" +
			"\x1ebbbb2222\x1fbbbb\x1fAda\x1f2026-11-11T09:00:00-03:00\x1fmerge\n";
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
				files: [],
			},
		]);
	});
});
