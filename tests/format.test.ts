import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { changeLabel, describeBranch, diffMarkdown } from "../src/format.ts";
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
		assert.equal(describeBranch(status({ upstream: "origin/main" })), "main → origin/main");
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
