import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ConflictError, createGit, type PullPolicy, type Resolution } from "../src/git.ts";
import { fakeGit, type ScriptedCall } from "./fake-git.ts";

const NOW = new Date(2026, 10, 12, 22, 40, 5);
const BACKUP = ".learnharness-git-backup/conflicts/2026-11-12_22-40-05";
const LIT = "--literal-pathspecs";
const STATUS = ["status", "--porcelain=v1", "--branch", "-z", "-uall"];
const HEAD = ["rev-parse", "-q", "--verify", "HEAD"];
const MERGING = ["rev-parse", "-q", "--verify", "MERGE_HEAD"];
const UNMERGED = ["ls-files", "-u", "-z"];
const PULL = ["pull", "--no-rebase", "--no-edit"];
const ABORT = ["merge", "--abort"];
const COMMIT = ["commit", "--no-edit", "-q"];

let dir = "";
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-conflicts-"));
	await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const noMerge: ScriptedCall[] = [
	{ args: MERGING, result: { code: 1 } },
	{ args: ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], result: { code: 1 } },
	{ args: ["rev-parse", "-q", "--verify", "REVERT_HEAD"], result: { code: 1 } },
	{
		args: ["rev-parse", "--git-path", "rebase-merge", "--git-path", "rebase-apply"],
		result: { stdout: "/nonexistent/rebase-merge\n/nonexistent/rebase-apply\n" },
	},
	{ args: UNMERGED, result: { stdout: "" } },
];

/** `git ls-files -u -z` output for files and the stages each one has. */
const unmerged = (files: Record<string, number[]>) =>
	Object.entries(files)
		.flatMap(([file, stages]) => stages.map((n) => `100644 ${n}${n}${n} ${n}\t${file}\0`))
		.join("");

/** The pull up to the moment git stops with conflicts. */
const conflicted = (files: Record<string, number[]>): ScriptedCall[] => [
	{ args: STATUS, result: { stdout: "## main...origin/main [ahead 1, behind 1]\0" } },
	...noMerge,
	{ args: HEAD, result: { stdout: "aaa\n" } },
	{ args: PULL, result: { code: 1, stdout: "CONFLICT (content): Merge conflict" } },
	{ args: MERGING, result: { stdout: "ccc\n" } },
	{ args: UNMERGED, result: { stdout: unmerged(files) } },
];
const show = (stage: 2 | 3, file: string, stdout: string): ScriptedCall => ({
	args: ["show", `:${stage}:${file}`],
	result: { stdout },
});
/** git writing the discarded version to a temp file in the data folder, as `checkout-index --temp` does. */
const backup = (stage: 2 | 3, file: string, content: string | Buffer): ScriptedCall => {
	const temp = `.merge_file_${stage}${file.replaceAll("/", "_")}`;
	writeFileSync(path.join(dir, temp), content);
	return {
		args: ["checkout-index", `--stage=${stage}`, "--temp", "--", file],
		result: { stdout: `${temp}\t${file}\n` },
	};
};
const commitTime = (rev: string, file: string, seconds: number): ScriptedCall => ({
	args: [LIT, "log", "-1", "--format=%ct", rev, "--", file],
	result: { stdout: `${seconds}\n` },
});
const take = (side: "ours" | "theirs", file: string): ScriptedCall[] => [
	{ args: [LIT, "checkout", `--${side}`, "--", file] },
	{ args: [LIT, "add", "--", file] },
];

async function pull(script: ScriptedCall[], policy: Partial<PullPolicy> = {}) {
	const fake = fakeGit(script);
	const reports: Resolution[] = [];
	const result = await createGit(fake.run, dir)
		.pull({ mode: "auto", now: NOW, onResolved: (report) => reports.push(report), ...policy })
		.catch((error: unknown) => error);
	fake.done();
	return { result, reports, fake };
}

const read = (file: string) => fs.readFile(path.join(dir, file), "utf8");
const exists = (file: string) =>
	fs.stat(path.join(dir, file)).then(
		() => true,
		() => false,
	);
const chat = (updatedAt: string | number, text: string) => JSON.stringify({ updatedAt, messages: [text] });

describe("automatic conflict resolution", () => {
	test("a chat keeps the side with the newer updatedAt and backs up the other", async () => {
		const file = "chats/2026/linear-algebra.json";
		const local = chat("2026-11-12T21:40:00.000Z", "local");
		const remote = chat("2026-11-12T22:31:00.000Z", "remote");
		const { result, reports } = await pull([
			...conflicted({ [file]: [1, 2, 3] }),
			show(2, file, local),
			show(3, file, remote),
			backup(2, file, local),
			...take("theirs", file),
			{ args: COMMIT },
		]);
		assert.equal(result, "pulled");
		assert.deepEqual(reports, [{ backupDir: BACKUP, files: [{ path: file, kept: "remote", rule: "newer session" }] }]);
		assert.equal(await read(`${BACKUP}/${file}`), local);
		assert.equal(await read(".git/info/exclude"), ".learnharness-git-backup/\n");
	});
	test("a chat updated later locally keeps the local side (numeric timestamps)", async () => {
		const file = "chats/b.json";
		const { result, reports } = await pull([
			...conflicted({ [file]: [1, 2, 3] }),
			show(2, file, chat(2000, "local")),
			show(3, file, chat(1000, "remote")),
			backup(3, file, chat(1000, "remote")),
			...take("ours", file),
			{ args: COMMIT },
		]);
		assert.equal(result, "pulled");
		assert.deepEqual(reports[0]?.files, [{ path: file, kept: "local", rule: "newer session" }]);
		assert.equal(await read(`${BACKUP}/${file}`), chat(1000, "remote"));
	});
	test("settings, plugin state and plugin data keep the side with the newer commit; a tie keeps local", async () => {
		const files = ["core-plugin-data/flashcards/cards.json", "graph/view.json", "plugins-state.json", "settings.json"];
		const { result, reports } = await pull([
			...conflicted(Object.fromEntries(files.map((file) => [file, [1, 2, 3]]))),
			show(2, files[0] as string, '{"l":0}'),
			show(3, files[0] as string, '{"r":0}'),
			commitTime("HEAD", files[0] as string, 100),
			commitTime("MERGE_HEAD", files[0] as string, 100),
			show(2, files[1] as string, '{"l":1}'),
			show(3, files[1] as string, '{"r":1}'),
			commitTime("HEAD", files[1] as string, 100),
			commitTime("MERGE_HEAD", files[1] as string, 50),
			show(2, files[2] as string, '{"l":2}'),
			show(3, files[2] as string, '{"r":2}'),
			commitTime("HEAD", files[2] as string, 300),
			commitTime("MERGE_HEAD", files[2] as string, 100),
			show(2, files[3] as string, '{"l":3}'),
			show(3, files[3] as string, '{"r":3}'),
			commitTime("HEAD", files[3] as string, 100),
			commitTime("MERGE_HEAD", files[3] as string, 200),
			...files.map((file, i) => backup(i < 3 ? 3 : 2, file, i < 3 ? `{"r":${i}}` : '{"l":3}')),
			...take("ours", files[0] as string),
			...take("ours", files[1] as string),
			...take("ours", files[2] as string),
			...take("theirs", files[3] as string),
			{ args: COMMIT },
		]);
		assert.equal(result, "pulled");
		assert.deepEqual(reports[0]?.files, [
			{ path: files[0], kept: "local", rule: "tie, local kept" },
			{ path: files[1], kept: "local", rule: "newer commit" },
			{ path: files[2], kept: "local", rule: "newer commit" },
			{ path: files[3], kept: "remote", rule: "newer commit" },
		]);
		assert.deepEqual(await Promise.all(files.map((file) => read(`${BACKUP}/${file}`))), [
			'{"r":0}',
			'{"r":1}',
			'{"r":2}',
			'{"l":3}',
		]);
	});
	test("a binary plugin file backs up the discarded version byte for byte", async () => {
		const file = "core-plugin-data/images/card.png";
		const lost = Buffer.from([0xff, 0x00, 0xfe]);
		const { result } = await pull([
			...conflicted({ [file]: [1, 2, 3] }),
			show(2, file, lost.toString()),
			show(3, file, "\ufffd"),
			commitTime("HEAD", file, 100),
			commitTime("MERGE_HEAD", file, 200),
			backup(2, file, lost),
			...take("theirs", file),
			{ args: COMMIT },
		]);
		assert.equal(result, "pulled");
		assert.ok((await fs.readFile(path.join(dir, BACKUP, file))).equals(lost));
		assert.deepEqual((await fs.readdir(dir)).sort(), [".git", ".learnharness-git-backup"]);
	});
	test("graph/format.json keeps the higher version", async () => {
		const file = "graph/format.json";
		const { result, reports } = await pull([
			...conflicted({ [file]: [1, 2, 3] }),
			show(2, file, '{"version":2}'),
			show(3, file, '{"version":3}'),
			backup(2, file, '{"version":2}'),
			...take("theirs", file),
			{ args: COMMIT },
		]);
		assert.equal(result, "pulled");
		assert.deepEqual(reports[0]?.files, [{ path: file, kept: "remote", rule: "higher version" }]);
		assert.equal(await read(`${BACKUP}/${file}`), '{"version":2}');
	});
	test("a chat or format.json equal on both sides by the rule keeps local, labelled as a tie", async () => {
		const files = ["chats/tie.json", "graph/format.json"];
		const { result, reports } = await pull([
			...conflicted({ [files[0] as string]: [1, 2, 3], [files[1] as string]: [1, 2, 3] }),
			show(2, files[0] as string, chat(1000, "local")),
			show(3, files[0] as string, chat(1000, "remote")),
			show(2, files[1] as string, '{"version":2,"l":1}'),
			show(3, files[1] as string, '{"version":2,"r":1}'),
			backup(3, files[0] as string, chat(1000, "remote")),
			backup(3, files[1] as string, '{"version":2,"r":1}'),
			...take("ours", files[0] as string),
			...take("ours", files[1] as string),
			{ args: COMMIT },
		]);
		assert.equal(result, "pulled");
		assert.deepEqual(reports[0]?.files, [
			{ path: files[0], kept: "local", rule: "tie, local kept" },
			{ path: files[1], kept: "local", rule: "tie, local kept" },
		]);
		assert.equal(await read(`${BACKUP}/${files[0]}`), chat(1000, "remote"));
	});
	test("a modify/delete conflict keeps the modified file, with nothing to back up", async () => {
		const { result, reports } = await pull([
			...conflicted({ "chats/b.json": [1, 2], "notes.md": [1, 3] }),
			show(2, "chats/b.json", chat(1, "local")),
			show(3, "notes.md", "remote notes"),
			...take("ours", "chats/b.json"),
			...take("theirs", "notes.md"),
			{ args: COMMIT },
		]);
		assert.equal(result, "pulled");
		assert.deepEqual(reports, [
			{
				backupDir: null,
				files: [
					{ path: "chats/b.json", kept: "local", rule: "modified kept" },
					{ path: "notes.md", kept: "remote", rule: "modified kept" },
				],
			},
		]);
		assert.equal(await exists(".learnharness-git-backup"), false);
	});
	test("a graph ledger without the union attribute is merged line by line", async () => {
		const file = "graph/nodes.jsonl";
		await fs.mkdir(path.join(dir, "graph"));
		await fs.writeFile(path.join(dir, file), "<<<<<<< HEAD\n");
		const { result, reports } = await pull([
			...conflicted({ [file]: [1, 2, 3] }),
			show(2, file, '{"id":1}\n{"id":2}\n'),
			show(3, file, '{"id":1}\n{"id":3}'),
			{ args: [LIT, "add", "--", file] },
			{ args: COMMIT },
		]);
		assert.equal(result, "pulled");
		assert.deepEqual(reports, [{ backupDir: null, files: [{ path: file, kept: "both", rule: "union merge" }] }]);
		assert.equal(await read(file), '{"id":1}\n{"id":2}\n{"id":3}\n');
	});
	test("never reuses a backup folder of the same second", async () => {
		await fs.mkdir(path.join(dir, BACKUP), { recursive: true });
		const file = "graph/format.json";
		const { reports } = await pull([
			...conflicted({ [file]: [1, 2, 3] }),
			show(2, file, '{"version":4}'),
			show(3, file, '{"version":3}'),
			backup(3, file, '{"version":3}'),
			...take("ours", file),
			{ args: COMMIT },
		]);
		assert.equal(reports[0]?.backupDir, `${BACKUP}-2`);
		assert.equal(await read(`${BACKUP}-2/${file}`), '{"version":3}');
	});
});

describe("conflicts the rules cannot resolve", () => {
	const message = "Merge conflict with origin/main. Pull aborted; no files changed.";
	const assertAborted = async (outcome: { result: unknown; reports: Resolution[] }, files: string[]) => {
		assert.ok(outcome.result instanceof ConflictError);
		assert.equal(outcome.result.message, message);
		assert.equal(outcome.result.upstream, "origin/main");
		assert.deepEqual(outcome.result.files, files);
		assert.deepEqual(outcome.reports, []);
		assert.equal(await exists(".learnharness-git-backup"), false);
		assert.equal(await exists(".git/info/exclude"), false);
	};
	test("a winner that is not valid JSON aborts the merge", async () => {
		const outcome = await pull([
			...conflicted({ "settings.json": [1, 2, 3] }),
			show(2, "settings.json", '{"theme":"dark"}'),
			show(3, "settings.json", '{"theme":'),
			commitTime("HEAD", "settings.json", 100),
			commitTime("MERGE_HEAD", "settings.json", 200),
			{ args: ABORT },
		]);
		await assertAborted(outcome, ["settings.json"]);
	});
	test("a chat without a readable updatedAt or a format.json without a numeric version aborts", async () => {
		const outcome = await pull([
			...conflicted({ "chats/a.json": [1, 2, 3], "chats/b.json": [1, 2, 3], "graph/format.json": [1, 2, 3] }),
			show(2, "chats/a.json", "{not json"),
			show(3, "chats/a.json", chat(1, "r")),
			show(2, "chats/b.json", JSON.stringify({ messages: [] })),
			show(3, "chats/b.json", chat("yesterday", "r")),
			show(2, "graph/format.json", '{"version":"2"}'),
			show(3, "graph/format.json", '{"version":3}'),
			{ args: ABORT },
		]);
		await assertAborted(outcome, ["chats/a.json", "chats/b.json", "graph/format.json"]);
	});
	test("a file without a rule aborts and is the only one listed", async () => {
		const outcome = await pull([
			...conflicted({ "chats/a.json": [1, 2, 3], "plugins/my-notes/data/state.json": [1, 2, 3] }),
			show(2, "chats/a.json", chat(1, "l")),
			show(3, "chats/a.json", chat(2, "r")),
			{ args: ABORT },
		]);
		await assertAborted(outcome, ["plugins/my-notes/data/state.json"]);
	});
	test("manual mode aborts every conflict without reading any version", async () => {
		const outcome = await pull(
			[...conflicted({ "chats/a.json": [1, 2, 3], "settings.json": [1, 2, 3] }), { args: ABORT }],
			{ mode: "manual" },
		);
		await assertAborted(outcome, ["chats/a.json", "settings.json"]);
	});
	test("a failure while applying the resolution aborts the merge and reports git's error", async () => {
		const file = "graph/format.json";
		const outcome = await pull([
			...conflicted({ [file]: [1, 2, 3] }),
			show(2, file, '{"version":1}'),
			show(3, file, '{"version":3}'),
			backup(2, file, '{"version":1}'),
			...take("theirs", file),
			{ args: COMMIT, result: { code: 1, stderr: "fatal: cannot commit" } },
			{ args: ABORT },
		]);
		assert.equal((outcome.result as Error).message, "git commit failed: fatal: cannot commit");
		assert.deepEqual(outcome.reports, []);
	});
});

describe("choices", () => {
	test("manual choices pick each side and back up the other", async () => {
		const { result, reports } = await pull(
			[
				...conflicted({ "chats/a.json": [1, 2, 3], "notes.md": [1, 2, 3], "old.json": [1, 2] }),
				show(2, "chats/a.json", chat(1, "local")),
				show(3, "chats/a.json", chat(2, "remote")),
				show(2, "notes.md", "local notes"),
				show(3, "notes.md", "remote notes"),
				show(2, "old.json", "{}"),
				backup(3, "chats/a.json", chat(2, "remote")),
				backup(2, "notes.md", "local notes"),
				backup(2, "old.json", "{}"),
				...take("ours", "chats/a.json"),
				...take("theirs", "notes.md"),
				{ args: [LIT, "rm", "-q", "--", "old.json"] },
				{ args: COMMIT },
			],
			{ mode: "manual", choices: { "chats/a.json": "local", "notes.md": "remote", "old.json": "remote" } },
		);
		assert.equal(result, "pulled");
		assert.deepEqual(reports, [
			{
				backupDir: BACKUP,
				files: [
					{ path: "chats/a.json", kept: "local", rule: "your choice" },
					{ path: "notes.md", kept: "remote", rule: "your choice" },
					{ path: "old.json", kept: "remote", rule: "your choice" },
				],
			},
		]);
		assert.deepEqual(
			await Promise.all([read(`${BACKUP}/chats/a.json`), read(`${BACKUP}/notes.md`), read(`${BACKUP}/old.json`)]),
			[chat(2, "remote"), "local notes", "{}"],
		);
	});
	test("in automatic mode a choice covers the file without a rule and the rules cover the rest", async () => {
		const { result, reports } = await pull(
			[
				...conflicted({ "chats/a.json": [1, 2, 3], "notes.md": [1, 2, 3] }),
				show(2, "chats/a.json", chat(1, "local")),
				show(3, "chats/a.json", chat(2, "remote")),
				show(2, "notes.md", "local notes"),
				show(3, "notes.md", "remote notes"),
				backup(2, "chats/a.json", chat(1, "local")),
				backup(3, "notes.md", "remote notes"),
				...take("theirs", "chats/a.json"),
				...take("ours", "notes.md"),
				{ args: COMMIT },
			],
			{ choices: { "notes.md": "local" } },
		);
		assert.equal(result, "pulled");
		assert.deepEqual(reports[0]?.files, [
			{ path: "chats/a.json", kept: "remote", rule: "newer session" },
			{ path: "notes.md", kept: "local", rule: "your choice" },
		]);
	});
	test("a new conflict without a choice aborts again and keeps listing the files already chosen", async () => {
		const outcome = await pull(
			[
				...conflicted({ "notes.md": [1, 2, 3], "todo.md": [1, 2, 3] }),
				show(2, "notes.md", "local notes"),
				show(3, "notes.md", "remote notes"),
				{ args: ABORT },
			],
			{ mode: "manual", choices: { "notes.md": "local" } },
		);
		assert.ok(outcome.result instanceof ConflictError);
		// Listing the chosen file keeps the user's choice on screen, so the next round can converge.
		assert.deepEqual(outcome.result.files, ["notes.md", "todo.md"]);
		assert.equal(await exists(".learnharness-git-backup"), false);
	});
});

describe("choices of a side that is not valid JSON (S17)", () => {
	const assertRejected = async (
		outcome: { result: unknown; reports: Resolution[] },
		files: string[],
		notes: string[],
	) => {
		assert.ok(outcome.result instanceof ConflictError);
		assert.equal(outcome.result.message, "Merge conflict with origin/main. Pull aborted; no files changed.");
		assert.deepEqual(outcome.result.files, files);
		assert.deepEqual(outcome.result.notes, notes);
		assert.deepEqual(outcome.reports, []);
		assert.equal(await exists(".learnharness-git-backup"), false);
		assert.equal(await exists(".git/info/exclude"), false);
	};
	test("choosing a Local side that is not valid JSON aborts and says to pick Remote", async () => {
		const outcome = await pull(
			[
				...conflicted({ "settings.json": [1, 2, 3] }),
				show(2, "settings.json", '{"broken"'),
				show(3, "settings.json", '{"theme":"dark"}'),
				{ args: ABORT },
			],
			{ mode: "manual", choices: { "settings.json": "local" } },
		);
		await assertRejected(
			outcome,
			["settings.json"],
			["settings.json: the Local version is not valid JSON. Pick Remote."],
		);
	});
	test("choosing a Remote side that is not valid JSON aborts and says to pick Local", async () => {
		const outcome = await pull(
			[
				...conflicted({ "chats/a.json": [1, 2, 3] }),
				show(2, "chats/a.json", chat(1, "local")),
				show(3, "chats/a.json", "{not json"),
				{ args: ABORT },
			],
			{ choices: { "chats/a.json": "remote" } },
		);
		await assertRejected(
			outcome,
			["chats/a.json"],
			["chats/a.json: the Remote version is not valid JSON. Pick Local."],
		);
	});
	test("when both sides are not valid JSON either choice aborts and says to fix it with git", async () => {
		for (const side of ["local", "remote"] as const) {
			const outcome = await pull(
				[
					...conflicted({ "settings.json": [1, 2, 3] }),
					show(2, "settings.json", '{"broken"'),
					show(3, "settings.json", "{also broken"),
					{ args: ABORT },
				],
				{ mode: "manual", choices: { "settings.json": side } },
			);
			await assertRejected(
				outcome,
				["settings.json"],
				["settings.json: both versions are not valid JSON. Fix it by hand with git."],
			);
		}
	});
	test("choosing the valid side of a file whose other side is not valid JSON resolves", async () => {
		const { result, reports } = await pull(
			[
				...conflicted({ "settings.json": [1, 2, 3] }),
				show(2, "settings.json", '{"broken"'),
				show(3, "settings.json", '{"theme":"dark"}'),
				backup(2, "settings.json", '{"broken"'),
				...take("theirs", "settings.json"),
				{ args: COMMIT },
			],
			{ mode: "manual", choices: { "settings.json": "remote" } },
		);
		assert.equal(result, "pulled");
		assert.deepEqual(reports, [
			{ backupDir: BACKUP, files: [{ path: "settings.json", kept: "remote", rule: "your choice" }] },
		]);
		assert.equal(await read(`${BACKUP}/settings.json`), '{"broken"');
	});
	test("a bulk choice lists one line per rejected file in conflict order and keeps every file listed", async () => {
		const outcome = await pull(
			[
				...conflicted({
					"chats/a.json": [1, 2, 3],
					"notes.md": [1, 2, 3],
					"plugins-state.json": [1, 2],
					"settings.json": [1, 2, 3],
				}),
				show(2, "chats/a.json", "{not json"),
				show(3, "chats/a.json", chat(2, "remote")),
				show(2, "notes.md", "not json, not a json file"),
				show(3, "notes.md", "remote notes"),
				show(2, "plugins-state.json", "{"),
				show(2, "settings.json", '{"theme":"light"}'),
				show(3, "settings.json", '{"theme":"dark"}'),
				{ args: ABORT },
			],
			{
				mode: "manual",
				choices: {
					"chats/a.json": "local",
					"notes.md": "local",
					"plugins-state.json": "local",
					"settings.json": "local",
				},
			},
		);
		await assertRejected(
			outcome,
			["chats/a.json", "notes.md", "plugins-state.json", "settings.json"],
			[
				"chats/a.json: the Local version is not valid JSON. Pick Remote.",
				"plugins-state.json: the Local version is not valid JSON. Pick Remote.",
			],
		);
	});
	test("a conflict aborted without any rejected choice carries no notes", async () => {
		const outcome = await pull([...conflicted({ "notes.md": [1, 2, 3] }), { args: ABORT }], { mode: "manual" });
		await assertRejected(outcome, ["notes.md"], []);
	});
});

test("conflictDiff compares HEAD with the upstream for one file, read-only", async () => {
	const fake = fakeGit([
		{ args: [LIT, "diff", "--no-color", "HEAD", "@{upstream}", "--", "chats/a.json"], result: { stdout: "DIFF" } },
	]);
	assert.equal(await createGit(fake.run, dir).conflictDiff("chats/a.json"), "DIFF");
	fake.done();
});
