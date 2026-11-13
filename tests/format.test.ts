import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	authHint,
	backupDetails,
	backupHeadline,
	CONFLICT_DIFF_LEGEND,
	changeLabel,
	cloneDetails,
	commitCells,
	conflictHeadline,
	conflictMessage,
	describeBranch,
	diffMarkdown,
	filesLeft,
	invalidJsonNote,
	isConflictMessage,
	keptLabel,
	plural,
	relativeTime,
	resolvedNotice,
	sensitiveFiles,
	shortTime,
	visibleError,
} from "../src/format.ts";
import type { Status } from "../src/git.ts";

const status = (over: Partial<Status>): Status => ({
	branch: "main",
	upstream: null,
	hasCommits: true,
	ahead: 0,
	behind: 0,
	staged: [],
	unstaged: [],
	...over,
});

describe("describeBranch", () => {
	test("shows upstream and divergence", () => {
		assert.equal(
			describeBranch(status({ upstream: "origin/main", ahead: 2, behind: 1 })),
			"main → origin/main · ↑2 ↓1",
		);
		assert.equal(describeBranch(status({ upstream: "origin/main" })), "main → origin/main · up to date");
	});
	test("names branches without upstream, unborn branches and detached heads", () => {
		assert.equal(describeBranch(status({})), "main (no upstream)");
		assert.equal(describeBranch(status({ hasCommits: false })), "main (no commits yet)");
		assert.equal(describeBranch(status({ branch: null })), "Detached HEAD");
	});
});

describe("diffMarkdown", () => {
	test("wraps a diff in a diff fence", () => {
		assert.equal(diffMarkdown("+a\n"), "```diff\n+a\n```");
	});
	test("uses a fence longer than any backtick run inside", () => {
		assert.equal(diffMarkdown("+````x"), "`````diff\n+````x\n`````");
	});
	test("says when there is nothing to show", () => {
		assert.equal(diffMarkdown(""), "_No changes to show._");
	});
	test("truncates very large diffs", () => {
		const text = diffMarkdown("x".repeat(200_001));
		assert.equal(text, `\`\`\`diff\n${"x".repeat(200_000)}\n\`\`\`\n\n_Diff truncated at 200000 characters._`);
	});
});

test("changeLabel names every status code", () => {
	assert.deepEqual(["M", "A", "D", "R", "C", "T", "U", "?", "X"].map(changeLabel), [
		"Modified",
		"Added",
		"Deleted",
		"Renamed",
		"Copied",
		"Type changed",
		"Conflict",
		"Untracked",
		"X",
	]);
});

const now = new Date(2026, 10, 12, 9, 34, 30);
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

test("plural picks singular for exactly one", () => {
	assert.deepEqual([plural(0, "file"), plural(1, "file"), plural(2, "change")], ["0 files", "1 file", "2 changes"]);
});

test("relativeTime covers seconds, minutes, hours and days", () => {
	assert.deepEqual(
		[
			ago(30_000),
			ago(60_000),
			ago(4 * 60_000),
			ago(3_600_000),
			ago(5 * 3_600_000),
			ago(86_400_000),
			ago(3 * 86_400_000),
		].map((iso) => relativeTime(iso, now)),
		["just now", "1 minute ago", "4 minutes ago", "1 hour ago", "5 hours ago", "1 day ago", "3 days ago"],
	);
});

test("shortTime shows today as HH:mm, yesterday with a label, older as a date", () => {
	assert.deepEqual(
		[new Date(2026, 10, 12, 9, 30), new Date(2026, 10, 11, 21, 14), new Date(2026, 10, 3, 8, 5)].map((d) =>
			shortTime(d.toISOString(), now),
		),
		["09:30", "Yesterday 21:14", "2026-11-03 08:05"],
	);
});

describe("commitCells", () => {
	const commit = (files: number, author: string) => ({
		hash: "aaaa1111",
		shortHash: "aaaa111",
		author,
		date: new Date(2026, 10, 12, 9, 5).toISOString(),
		subject: "backup",
		files: Array.from({ length: files }, (_, i) => ({ path: `f${i}.json`, code: "M" })),
	});
	test("shows the file count and the short local time", () => {
		assert.deepEqual(commitCells(commit(1, "Ada"), "Ada", now), { files: "1 file", time: "09:05", author: null });
		assert.deepEqual(commitCells(commit(29, "Ada"), "Ada", now), { files: "29 files", time: "09:05", author: null });
		assert.deepEqual(commitCells(commit(0, "Ada"), "Ada", now), { files: "0 files", time: "09:05", author: null });
	});
	test("names the author only when it is not the configured user", () => {
		assert.equal(commitCells(commit(1, "GitHub"), "Ada", now).author, "GitHub");
		assert.equal(commitCells(commit(1, "Ada"), "Ada", now).author, null);
	});
	test("names no author when the configured user cannot be read", () => {
		assert.equal(commitCells(commit(1, "GitHub"), null, now).author, null);
	});
});

describe("backupHeadline", () => {
	const base = { repo: true, lastCommit: ago(4 * 60_000), busy: null, paused: false };
	test("says when the last backup happened", () => {
		assert.equal(backupHeadline(base, now), "Backed up 4 minutes ago");
	});
	test("names the states that override it, in priority order", () => {
		assert.equal(backupHeadline({ ...base, repo: false }, now), "Not backed up yet");
		assert.equal(backupHeadline({ ...base, lastCommit: null }, now), "Not backed up yet");
		assert.equal(backupHeadline({ ...base, paused: true }, now), "Sync paused: merge conflict");
		assert.equal(backupHeadline({ ...base, paused: true, busy: "sync" }, now), "Running sync…");
	});
	test("counts the pending conflicted files while paused, singular for one", () => {
		assert.deepEqual(
			[1, 2].map((conflicts) => backupHeadline({ ...base, paused: true, conflicts }, now)),
			["Sync paused: merge conflict in 1 file", "Sync paused: merge conflict in 2 files"],
		);
		assert.equal(backupHeadline({ ...base, paused: true, conflicts: 0 }, now), "Sync paused: merge conflict");
	});
	test("asks for a restart after a clone, unless an operation is running", () => {
		const restart = { ...base, paused: true, restartRequired: true, cloneBranch: "trunk" };
		assert.equal(backupHeadline(restart, now), "Cloned origin/trunk. Restart LearnHarness.");
		assert.equal(backupHeadline({ ...restart, cloneBranch: null }, now), "Cloned origin/main. Restart LearnHarness.");
		assert.equal(backupHeadline({ ...restart, busy: "sync" }, now), "Running sync…");
	});
});

describe("cloneDetails", () => {
	test("names the backup folder when local files were moved", () => {
		assert.equal(
			cloneDetails(".learnharness-git-backup/2026-11-12_09-05-07"),
			"Replaced local files moved to .learnharness-git-backup/2026-11-12_09-05-07.",
		);
	});
	test("is empty when nothing was moved", () => {
		assert.equal(cloneDetails(null), "");
	});
});

describe("backupDetails", () => {
	test("lists pending changes, next sync and branch", () => {
		assert.deepEqual(
			backupDetails(
				{
					changes: 6,
					nextSync: new Date(now.getTime() + 5 * 60_000 + 1).toISOString(),
					status: status({ upstream: "origin/main" }),
				},
				now,
			),
			["6 changes", "next sync in 6 min", "main → origin/main · up to date"],
		);
	});
	test("says when nothing changed and automation is off", () => {
		assert.deepEqual(backupDetails({ changes: 0, nextSync: null, status: null }, now), ["No changes", "auto sync off"]);
	});
	test("never promises a sync in less than 1 minute", () => {
		assert.equal(backupDetails({ changes: 1, nextSync: ago(1000), status: null }, now)[1], "next sync in 1 min");
	});
});

describe("conflict texts", () => {
	test("conflictHeadline counts files, singular for one", () => {
		assert.deepEqual(
			[conflictHeadline(1), conflictHeadline(3)],
			["Merge conflict in 1 file", "Merge conflict in 3 files"],
		);
	});
	test("filesLeft names how many files still need a version", () => {
		assert.deepEqual([filesLeft(1), filesLeft(2)], ["1 file left.", "2 files left."]);
	});
	test("resolvedNotice says the newest version was kept when every file followed a rule", () => {
		const auto = (file: string) => ({ path: file, kept: "local" as const, rule: "newer commit" });
		assert.deepEqual(
			[
				resolvedNotice([auto("a.json")]),
				resolvedNotice([auto("a.json"), { ...auto("b.jsonl"), kept: "both", rule: "union merge" }]),
			],
			["Merge conflict in 1 file resolved: newest kept.", "Merge conflict in 2 files resolved: newest kept."],
		);
	});
	test("resolvedNotice drops 'newest kept' when any file was the user's choice", () => {
		const chosen = (file: string) => ({ path: file, kept: "remote" as const, rule: "your choice" });
		assert.deepEqual(
			[
				resolvedNotice([chosen("a.json")]),
				resolvedNotice([chosen("a.json"), { path: "b.json", kept: "local", rule: "newer commit" }]),
			],
			["Merge conflict in 1 file resolved.", "Merge conflict in 2 files resolved."],
		);
	});
	test("conflictMessage names the upstream and isConflictMessage recognizes only it", () => {
		const message = conflictMessage("origin/main");
		assert.equal(message, "Merge conflict with origin/main. Pull aborted; no files changed.");
		assert.deepEqual(
			[message, conflictMessage("upstream/trunk"), "git pull failed: boom", `${message} extra`, ""].map(
				isConflictMessage,
			),
			[true, true, false, false, false],
		);
	});
	test("invalidJsonNote names the rejected side, the side to pick, or a fix with git; it is not the conflict message", () => {
		const notes = [
			invalidJsonNote("settings.json", "local", true),
			invalidJsonNote("chats/a.json", "remote", true),
			invalidJsonNote("settings.json", "local", false),
		];
		assert.deepEqual(notes, [
			"settings.json: the Local version is not valid JSON. Pick Remote.",
			"chats/a.json: the Remote version is not valid JSON. Pick Local.",
			"settings.json: both versions are not valid JSON. Fix it by hand with git.",
		]);
		assert.deepEqual(notes.map(isConflictMessage), [false, false, false]);
	});
	test("the conflict diff legend names each side", () => {
		assert.equal(CONFLICT_DIFF_LEGEND, "− Local · + Remote");
	});
	test("keptLabel names the kept side", () => {
		assert.deepEqual([keptLabel("local"), keptLabel("remote"), keptLabel("both")], ["Local", "Remote", "Both"]);
	});
});

describe("authHint", () => {
	test("splits the authentication message into its fixes", () => {
		assert.deepEqual(
			authHint(
				"Git authentication failed. No credentials for github.com. Set up one, then retry: gh auth login && gh auth setup-git, or use an SSH URL (git@github.com:me/data.git).",
			),
			{
				headline: "Git authentication failed",
				sub: "No credentials for github.com. Set up one, then retry:",
				gh: "gh auth login && gh auth setup-git",
				ssh: "git@github.com:me/data.git",
			},
		);
	});
	test("has no SSH URL when the host is unknown", () => {
		assert.deepEqual(
			authHint(
				"Git authentication failed. No credentials for the remote. Set up one, then retry: gh auth login && gh auth setup-git, or use an SSH URL.",
			),
			{
				headline: "Git authentication failed",
				sub: "No credentials for the remote. Set up one, then retry:",
				gh: "gh auth login && gh auth setup-git",
				ssh: null,
			},
		);
	});
	test("is null for other errors", () => {
		assert.equal(authHint("git push failed: rejected"), null);
	});
});

test("sensitiveFiles flags the app's root settings and token or API key files", () => {
	assert.deepEqual(
		sensitiveFiles([
			"settings.json",
			"graph/nodes.jsonl",
			"plugins/x/data/settings.json",
			"notes/auth-token.json",
			"MyApiKey.txt",
			"chats/chat_1.json",
		]),
		["settings.json", "notes/auth-token.json", "MyApiKey.txt"],
	);
});

describe("visibleError", () => {
	const auth =
		"Git authentication failed. No credentials for 127.0.0.1. Set up one, then retry: gh auth login && gh auth setup-git, or use an SSH URL (git@127.0.0.1:lab.git).";
	const idle = { localError: null, lastError: null, busy: null, paused: false };
	test("a stale backend error is gone while git runs and after the action succeeds", () => {
		const unfinished = "Unfinished merge in the repository. Finish or abort it with git, then retry.";
		assert.deepEqual(
			[
				visibleError({ ...idle, lastError: unfinished }),
				visibleError({ ...idle, lastError: unfinished, busy: "sync" }),
				visibleError(idle),
			],
			[unfinished, null, null],
		);
	});
	test("the user's failed action in this view is shown, even while paused or while git runs", () => {
		assert.deepEqual(
			[
				visibleError({ ...idle, localError: "Nothing to commit." }),
				visibleError({ ...idle, localError: "boom", lastError: "older", busy: "auto sync" }),
				visibleError({
					...idle,
					localError: "settings.json: the Local version is not valid JSON. Pick Remote.",
					paused: true,
				}),
			],
			["Nothing to commit.", "boom", "settings.json: the Local version is not valid JSON. Pick Remote."],
		);
	});
	test("the aborted pull's conflict message is hidden; a paused backend error is left to the headline", () => {
		const conflict = conflictMessage("origin/main");
		assert.deepEqual(
			[
				visibleError({ ...idle, lastError: conflict }),
				visibleError({ ...idle, localError: conflict }),
				visibleError({ ...idle, lastError: "git pull failed: boom", paused: true }),
			],
			[null, null, null],
		);
	});
	test("an authentication error stays until a later success", () => {
		assert.deepEqual(
			[
				visibleError({ ...idle, lastError: auth }),
				visibleError({ ...idle, lastError: auth, busy: "clone" }),
				visibleError({ ...idle, lastError: null }),
			],
			[auth, null, null],
		);
	});
});
