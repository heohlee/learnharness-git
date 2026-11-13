import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	backupDetails,
	backupHeadline,
	changeLabel,
	cloneDetails,
	commitCells,
	describeBranch,
	diffMarkdown,
	plural,
	relativeTime,
	sensitiveFiles,
	shortTime,
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
		assert.equal(backupHeadline({ ...base, paused: true }, now), "Automatic sync paused");
		assert.equal(backupHeadline({ ...base, paused: true, busy: "sync" }, now), "Running sync…");
	});
	test("asks for a restart after a clone, unless an operation is running", () => {
		const restart = { ...base, paused: true, restartRequired: true };
		assert.equal(backupHeadline(restart, now), "Restart LearnHarness to finish cloning");
		assert.equal(backupHeadline({ ...restart, busy: "sync" }, now), "Running sync…");
	});
});

describe("cloneDetails", () => {
	test("names the backup folder when local files were moved", () => {
		assert.equal(
			cloneDetails(".learnharness-git-backup/2026-11-12_09-05-07"),
			"LearnHarness loads the cloned learning data after a restart. Local files the backup replaced were moved to .learnharness-git-backup/2026-11-12_09-05-07.",
		);
	});
	test("explains the restart alone when nothing was moved", () => {
		assert.equal(cloneDetails(null), "LearnHarness loads the cloned learning data after a restart.");
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
			["6 changes since then", "next automatic sync in 6 min", "main → origin/main · up to date"],
		);
	});
	test("says when nothing changed and automation is off", () => {
		assert.deepEqual(backupDetails({ changes: 0, nextSync: null, status: null }, now), [
			"No changes since then",
			"automatic sync off",
		]);
	});
	test("never promises a sync in less than 1 minute", () => {
		assert.equal(
			backupDetails({ changes: 1, nextSync: ago(1000), status: null }, now)[1],
			"next automatic sync in 1 min",
		);
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
