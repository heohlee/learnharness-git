import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { BACKUP_ROOT, cloneInPlace, type Move } from "../src/clone.ts";
import { createGit, GitError, type GitResult, type GitRunner } from "../src/git.ts";
import { fakeGit, type ScriptedCall } from "./fake-git.ts";

const URL = "git@github.com:me/learning-data.git";
const NOW = new Date(2026, 10, 12, 9, 5, 7);
const STAMP = ".learnharness-git-backup/2026-11-12_09-05-07";
const OWN_DATA = "This folder has sessions or a graph. Clone only into a new data folder.";

const INIT = ["init", "-b", "main"];
const ADD = ["remote", "add", "origin", URL];
const FETCH = ["fetch", "origin"];
const SYMREF = ["ls-remote", "--symref", "origin", "HEAD"];
const verify = (branch: string) => ["rev-parse", "-q", "--verify", `refs/remotes/origin/${branch}`];
const lsTree = (branch: string) => [
	"-c",
	"core.quotePath=false",
	"ls-tree",
	"-r",
	"-z",
	"--name-only",
	`origin/${branch}`,
];
const checkout = (branch: string) => ["checkout", "-b", branch, "--track", `origin/${branch}`];
const VERIFY = ["diff", "--name-only", "-z", "HEAD"];

/** On-disk effects of a scripted git call, keyed by its arguments, run when the fake answers it. */
type Effects = Record<string, () => Promise<void> | void>;

let dir = "";
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-clone-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

async function write(file: string, text = "x"): Promise<void> {
	await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
	await fs.writeFile(path.join(dir, file), text);
}

/** Every file under the temp dir as "path: content", so a test can assert nothing changed. */
async function snapshot(root = dir, prefix = ""): Promise<string[]> {
	const out: string[] = [];
	for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const rel = prefix + entry.name;
		if (entry.isDirectory()) out.push(`${rel}/`, ...(await snapshot(path.join(root, entry.name), `${rel}/`)));
		else out.push(`${rel}: ${await fs.readFile(path.join(root, entry.name), "utf8")}`);
	}
	return out;
}

/**
 * The fake git, the effect `git init` really has on disk (a `.git` folder) and the files a scripted checkout writes,
 * exposed as the `CloneGit` pair `cloneInPlace` takes so a test can substitute the recovery rename.
 */
function fakeClone(script: ScriptedCall[], effects: Effects = {}) {
	const fake = fakeGit(script);
	const run: GitRunner = async (args, options) => {
		const result = await fake.run(args, options);
		if (args[0] === "init" && result.code === 0)
			await fs.mkdir(path.join(options.cwd, ".git", "info"), { recursive: true });
		await effects[args.join(" ")]?.();
		return result;
	};
	const exec = async (args: string[]): Promise<GitResult> => {
		const result = await run(args, { cwd: dir });
		if (result.code !== 0) throw new GitError(args, result);
		return result;
	};
	return { fake, run, git: { exec, run: (args: string[]) => run(args, { cwd: dir }) } };
}

/** `createGit` over the fake, so tests drive the public `clone` entry point. */
function scripted(script: ScriptedCall[], effects: Effects = {}) {
	const { fake, run } = fakeClone(script, effects);
	return { fake, git: createGit(run, dir) };
}

const remoteSetup = (branch: string, files: string[]): ScriptedCall[] => [
	{ args: INIT },
	{ args: ADD },
	{ args: FETCH },
	{ args: SYMREF, result: { stdout: `ref: refs/heads/${branch}\tHEAD\n0123abcd\tHEAD\n` } },
	{ args: verify(branch), result: { stdout: "0123abcd\n" } },
	{ args: lsTree(branch), result: { stdout: `${files.join("\0")}\0` } },
];

describe("clone preconditions", () => {
	const ownData: [string, string, string][] = [
		["a session in chats/", "chats/2026/one.json", "{}"],
		["a file directly in chats/", "chats/index.json", ""],
		["a non-empty graph ledger", "graph/nodes.jsonl", '{"id":1}\n'],
	];
	for (const [name, file, text] of ownData) {
		test(`refuses ${name} without running git or touching files`, async () => {
			await write(file, text);
			await write("settings.json", "{}");
			const before = await snapshot();
			const { fake, git } = scripted([]);
			await assert.rejects(git.clone(URL, NOW), { message: OWN_DATA });
			assert.deepEqual(fake.calls, []);
			assert.deepEqual(await snapshot(), before);
		});
	}
	test("refuses a symlink in chats/ without running git", async () => {
		await fs.mkdir(path.join(dir, "chats"), { recursive: true });
		await fs.symlink("/nonexistent/session.json", path.join(dir, "chats", "linked.json"));
		const { fake, git } = scripted([]);
		await assert.rejects(git.clone(URL, NOW), { message: OWN_DATA });
		assert.deepEqual(fake.calls, []);
	});
	test("an empty graph ledger, other graph files and empty chat folders are not own data", async () => {
		await write("graph/nodes.jsonl", "");
		await write("graph/format.json", '{"version":1}');
		await fs.mkdir(path.join(dir, "chats", "2026"), { recursive: true });
		await write("chats.jsonl", "x");
		const { fake, git } = scripted([
			...remoteSetup("main", ["settings.json"]),
			{ args: checkout("main") },
			{ args: VERIFY },
		]);
		assert.deepEqual(await git.clone(URL, NOW), { branch: "main", backupDir: null, backedUp: [] });
		fake.done();
	});
	test("chats as a plain file is not a sessions folder", async () => {
		await write("chats", "x");
		const { fake, git } = scripted([
			...remoteSetup("main", ["notes.md"]),
			{ args: checkout("main") },
			{ args: VERIFY },
		]);
		assert.deepEqual(await git.clone(URL, NOW), { branch: "main", backupDir: null, backedUp: [] });
		fake.done();
	});
});

describe("clone in place", () => {
	test("moves colliding local files to a dated backup, excludes it and checks out the remote branch", async () => {
		await write("settings.json", "local settings");
		await write("plugins-state.json", "local plugins");
		await write("plugins/learnharness-git/dist/x.js", "code");
		await write("notes", "a local file where the remote has a folder");
		await write("sources", "x");
		await fs.mkdir(path.join(dir, "graph", "format.json"), { recursive: true });
		await write("graph/format.json/inner", "a local folder where the remote has a file");
		const remote = ["settings.json", "plugins-state.json", "notes/a.md", "graph/format.json", "graph/nodes.jsonl"];
		const { fake, git } = scripted([...remoteSetup("trunk", remote), { args: checkout("trunk") }, { args: VERIFY }]);

		assert.deepEqual(await git.clone(URL, NOW), {
			branch: "trunk",
			backupDir: STAMP,
			backedUp: ["graph/format.json", "notes", "plugins-state.json", "settings.json"],
		});
		fake.done();
		assert.deepEqual(
			fake.calls.map((call) => call.args),
			[INIT, ADD, FETCH, SYMREF, verify("trunk"), lsTree("trunk"), checkout("trunk"), VERIFY],
		);
		assert.ok(fake.calls.every((call) => call.cwd === dir));
		assert.deepEqual(await snapshot(), [
			".git/",
			".git/info/",
			".git/info/exclude: .learnharness-git-backup/\n",
			".learnharness-git-backup/",
			".learnharness-git-backup/2026-11-12_09-05-07/",
			".learnharness-git-backup/2026-11-12_09-05-07/graph/",
			".learnharness-git-backup/2026-11-12_09-05-07/graph/format.json/",
			".learnharness-git-backup/2026-11-12_09-05-07/graph/format.json/inner: a local folder where the remote has a file",
			".learnharness-git-backup/2026-11-12_09-05-07/notes: a local file where the remote has a folder",
			".learnharness-git-backup/2026-11-12_09-05-07/plugins-state.json: local plugins",
			".learnharness-git-backup/2026-11-12_09-05-07/settings.json: local settings",
			"graph/",
			"plugins/",
			"plugins/learnharness-git/",
			"plugins/learnharness-git/dist/",
			"plugins/learnharness-git/dist/x.js: code",
			"sources: x",
		]);
	});
	test("does not write a default .gitignore or .gitattributes", async () => {
		const { fake, git } = scripted([...remoteSetup("main", ["a.md"]), { args: checkout("main") }, { args: VERIFY }]);
		await git.clone(URL, NOW);
		fake.done();
		assert.deepEqual(await snapshot(), [".git/", ".git/info/", ".git/info/exclude: .learnharness-git-backup/\n"]);
	});
	test("appends the exclude line after existing exclude rules", async () => {
		const { fake, git } = scripted([...remoteSetup("main", ["a.md"]), { args: checkout("main") }, { args: VERIFY }]);
		await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
		await fs.writeFile(
			path.join(dir, ".git", "info", "exclude"),
			"# git ls-files --others --exclude-from=.git/info/exclude",
		);
		await git.clone(URL, NOW);
		fake.done();
		assert.equal(
			await fs.readFile(path.join(dir, ".git", "info", "exclude"), "utf8"),
			"# git ls-files --others --exclude-from=.git/info/exclude\n.learnharness-git-backup/\n",
		);
	});
	test("falls back to main when the remote does not report its default branch", async () => {
		const script = remoteSetup("main", ["a.md"]);
		script[3] = { args: SYMREF, result: { stdout: "0123abcd\tHEAD\n" } };
		const { fake, git } = scripted([...script, { args: checkout("main") }, { args: VERIFY }]);
		assert.deepEqual(await git.clone(URL, NOW), { branch: "main", backupDir: null, backedUp: [] });
		fake.done();
	});
	test("never reuses an existing backup folder of the same second", async () => {
		await write(`${STAMP}/settings.json`, "older backup");
		await write("settings.json", "local");
		const { fake, git } = scripted([
			...remoteSetup("main", ["settings.json"]),
			{ args: checkout("main") },
			{ args: VERIFY },
		]);
		assert.deepEqual(await git.clone(URL, NOW), {
			branch: "main",
			backupDir: `${STAMP}-2`,
			backedUp: ["settings.json"],
		});
		fake.done();
		assert.equal(await fs.readFile(path.join(dir, STAMP, "settings.json"), "utf8"), "older backup");
		assert.equal(await fs.readFile(path.join(dir, `${STAMP}-2`, "settings.json"), "utf8"), "local");
	});
});

describe("clone failures", () => {
	test("a failed clone keeps empty folders of earlier backups", async () => {
		await fs.mkdir(path.join(dir, ".learnharness-git-backup", "older"), { recursive: true });
		await write("settings.json", "local");
		const { git } = scripted([
			...remoteSetup("main", ["settings.json"]),
			{ args: checkout("main"), result: { code: 1, stderr: "error: boom\n" } },
		]);
		await assert.rejects(git.clone(URL, NOW));
		assert.deepEqual(await fs.readdir(path.join(dir, ".learnharness-git-backup")), ["older"]);
		assert.equal(await fs.readFile(path.join(dir, "settings.json"), "utf8"), "local");
	});
	test("an empty remote stops before moving anything and removes the created repository", async () => {
		await write("settings.json", "local");
		const before = await snapshot();
		const { fake, git } = scripted([
			{ args: INIT },
			{ args: ADD },
			{ args: FETCH },
			{ args: SYMREF, result: { stdout: "" } },
			{ args: verify("main"), result: { code: 1 } },
		]);
		await assert.rejects(git.clone(URL, NOW), {
			message: "Remote is empty. Use Initialize, then connect it in Settings.",
		});
		fake.done();
		assert.deepEqual(await snapshot(), before);
	});
	test("a failed fetch reports git's error and leaves the folder as it was", async () => {
		await write("settings.json", "local");
		const before = await snapshot();
		const { fake, git } = scripted([
			{ args: INIT },
			{ args: ADD },
			{ args: FETCH, result: { code: 128, stderr: "fatal: Could not read from remote repository.\n" } },
		]);
		await assert.rejects(git.clone(URL, NOW), {
			message: "git fetch failed: fatal: Could not read from remote repository.",
		});
		fake.done();
		assert.deepEqual(await snapshot(), before);
	});
	test("a fetch without credentials gives the authentication hint and leaves the folder as it was", async () => {
		await write("settings.json", "local");
		const before = await snapshot();
		const { fake, git } = scripted([
			{ args: INIT },
			{ args: ADD },
			{
				args: FETCH,
				result: {
					code: 128,
					stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
				},
			},
			{ args: ["remote", "get-url", "origin"], result: { stdout: `${URL}\n` } },
		]);
		await assert.rejects(git.clone(URL, NOW), {
			name: "AuthError",
			message:
				"Git authentication failed. No credentials for github.com. Set up one, then retry: gh auth login && gh auth setup-git, or use an SSH URL (git@github.com:me/learning-data.git).",
		});
		fake.done();
		assert.deepEqual(await snapshot(), before);
	});
	test("a failed checkout restores every backed-up file and removes the created repository", async () => {
		await write("settings.json", "local settings");
		await write("notes", "local notes");
		await write("keep.md", "untouched");
		const before = await snapshot();
		const { fake, git } = scripted([
			...remoteSetup("main", ["settings.json", "notes/a.md"]),
			{ args: checkout("main"), result: { code: 1, stderr: "error: boom\n" } },
		]);
		await assert.rejects(git.clone(URL, NOW), { message: "git checkout failed: error: boom" });
		fake.done();
		assert.deepEqual(await snapshot(), before);
	});
	test("keeps a .git directory that existed before the clone", async () => {
		await fs.mkdir(path.join(dir, ".git"));
		await write(".git/HEAD", "broken");
		const before = await snapshot();
		const { fake, git } = scripted([{ args: INIT, result: { code: 1, stderr: "fatal: nope" } }]);
		await assert.rejects(git.clone(URL, NOW), { message: "git init failed: fatal: nope" });
		fake.done();
		assert.deepEqual(await snapshot(), before);
	});
});

describe("clone rollback", () => {
	const INCOMPLETE = (file: string) => `Clone incomplete: git did not write ${file} from the remote. Retry the clone.`;
	test("a checkout that exits 0 without every file fails and puts the folder back", async () => {
		await write("settings.json", "local settings");
		await write("keep/notes.md", "mine");
		await write("sources", "a local file where the remote has a folder");
		const before = await snapshot();
		const { fake, git } = scripted(
			[
				...remoteSetup("main", ["chats/one.json", "graph/nodes.jsonl", "settings.json", "sources/a.md"]),
				{
					args: checkout("main"),
					result: { stderr: "warning: unable to create file chats/one.json: Invalid argument\n" },
				},
				{ args: VERIFY, result: { stdout: "chats/one.json\0" } },
			],
			{
				[checkout("main").join(" ")]: async () => {
					await write("graph/nodes.jsonl", '{"id":1}\n');
					await write("settings.json", "remote settings");
					await write("sources/a.md", "remote");
				},
			},
		);
		await assert.rejects(git.clone(URL, NOW), { message: INCOMPLETE("chats/one.json") });
		fake.done();
		assert.deepEqual(await snapshot(), before);
	});
	test("a partial checkout leaves no remote file behind, so a retry is not refused for own data", async () => {
		const remote = ["chats/one.json", "graph/nodes.jsonl"];
		const partial = scripted(
			[
				...remoteSetup("main", remote),
				{ args: checkout("main") },
				{ args: VERIFY, result: { stdout: "graph/nodes.jsonl\0" } },
			],
			{ [checkout("main").join(" ")]: () => write("chats/one.json", '{"id":"a"}') },
		);
		await assert.rejects(partial.git.clone(URL, NOW), { message: INCOMPLETE("graph/nodes.jsonl") });
		assert.deepEqual(await fs.readdir(dir), []);
		const full = scripted([...remoteSetup("main", remote), { args: checkout("main") }, { args: VERIFY }], {
			[checkout("main").join(" ")]: async () => {
				await write("chats/one.json", '{"id":"a"}');
				await write("graph/nodes.jsonl", '{"id":1}\n');
			},
		});
		assert.deepEqual(await full.git.clone(URL, NOW), { branch: "main", backupDir: null, backedUp: [] });
		full.fake.done();
		assert.deepEqual(await snapshot(), [
			".git/",
			".git/info/",
			".git/info/exclude: .learnharness-git-backup/\n",
			"chats/",
			'chats/one.json: {"id":"a"}',
			"graph/",
			'graph/nodes.jsonl: {"id":1}\n',
		]);
	});
	test("a folder it cannot read neither aborts the clone nor is deleted by a rollback", async () => {
		await write("keep/locked/notes.md", "locked notes");
		await write("keep/open.md", "open");
		const before = await snapshot();
		const locked = path.join(dir, "keep", "locked");
		await fs.chmod(locked, 0o000);
		try {
			const { fake, git } = scripted(
				[
					...remoteSetup("main", ["keep/open.md", "a.md"]),
					{ args: checkout("main") },
					{ args: VERIFY, result: { stdout: "missing.md\0" } },
				],
				{
					[checkout("main").join(" ")]: async () => {
						await write("keep/open.md", "remote");
						await write("a.md", "remote");
					},
				},
			);
			// The clone still reaches git: a folder it cannot list is never a raw filesystem error for the user.
			await assert.rejects(git.clone(URL, NOW), { message: INCOMPLETE("missing.md") });
			fake.done();
		} finally {
			await fs.chmod(locked, 0o755);
		}
		assert.deepEqual(await snapshot(), before);
		assert.equal(await fs.readFile(path.join(locked, "notes.md"), "utf8"), "locked notes");
		// The same folder clones once the folder is readable again.
		const retry = scripted([...remoteSetup("main", ["a.md"]), { args: checkout("main") }, { args: VERIFY }]);
		assert.deepEqual(await retry.git.clone(URL, NOW), { branch: "main", backupDir: null, backedUp: [] });
		retry.fake.done();
	});
	test("a local file that cannot be moved back stays in the backup folder, named in the error", async () => {
		await write("settings.json", "local settings");
		await write("keep/notes.md", "mine");
		const clone = fakeClone([
			...remoteSetup("main", ["settings.json"]),
			{ args: checkout("main"), result: { code: 1, stderr: "error: boom\n" } },
		]);
		const move: Move = (from, to) => {
			if (from.startsWith(`${path.join(dir, BACKUP_ROOT)}/`)) throw new Error("EPERM");
			fsSync.renameSync(from, to);
		};
		await assert.rejects(cloneInPlace(clone.git, dir, URL, NOW, move), {
			message: `git checkout failed: error: boom. Cleanup was incomplete: settings.json could not be moved back and stays in ${STAMP}/settings.json.`,
		});
		clone.fake.done();
		assert.deepEqual(await snapshot(), [
			`${BACKUP_ROOT}/`,
			`${STAMP}/`,
			`${STAMP}/settings.json: local settings`,
			"keep/",
			"keep/notes.md: mine",
		]);
	});
});

describe("clone rollback durability (S2)", () => {
	const INCOMPLETE = (files: string) =>
		`Clone incomplete: git did not write ${files} from the remote. Retry the clone.`;

	test("three failed attempts in a row leave the folder byte-identical each time", async () => {
		await write("settings.json", "local settings");
		await write("keep/sub/deep.txt", "deep");
		const before = await snapshot();
		const remote = ["settings.json", "graph/nodes.jsonl", "keep/sub/new.txt"];
		for (let attempt = 0; attempt < 3; attempt++) {
			const { fake, git } = scripted(
				[
					...remoteSetup("main", remote),
					{ args: checkout("main") },
					{ args: VERIFY, result: { stdout: "graph/nodes.jsonl\0" } },
				],
				{
					[checkout("main").join(" ")]: async () => {
						await write("settings.json", `attempt ${attempt}`);
						await write("keep/sub/new.txt", "remote");
					},
				},
			);
			await assert.rejects(git.clone(URL, NOW), { message: INCOMPLETE("graph/nodes.jsonl") });
			fake.done();
			assert.deepEqual(await snapshot(), before);
		}
	});

	test("an earlier backup folder survives a failed attempt and the new one is removed", async () => {
		await write(`${BACKUP_ROOT}/2020-01-01_00-00-00/old.json`, "older backup");
		await write("settings.json", "local");
		const before = await snapshot();
		const { fake, git } = scripted(
			[
				...remoteSetup("main", ["settings.json", "x.md"]),
				{ args: checkout("main") },
				{ args: VERIFY, result: { stdout: "y.md\0" } },
			],
			{
				[checkout("main").join(" ")]: async () => {
					await write("settings.json", "remote settings");
					await write("x.md", "remote");
				},
			},
		);
		await assert.rejects(git.clone(URL, NOW), { message: INCOMPLETE("y.md") });
		fake.done();
		assert.deepEqual(await snapshot(), before);
	});

	test("a symlink in the way is put back as a link, not as a file", async () => {
		await write("keep/notes.md", "mine");
		await fs.symlink(path.join(dir, "keep/notes.md"), path.join(dir, "alias.md"));
		const before = await snapshot();
		const { fake, git } = scripted(
			[
				...remoteSetup("main", ["alias.md", "a.md"]),
				{ args: checkout("main") },
				{ args: VERIFY, result: { stdout: "missing.md\0" } },
			],
			{
				[checkout("main").join(" ")]: async () => {
					await fs.rm(path.join(dir, "alias.md"), { force: true });
					await write("alias.md", "remote file where a link was");
					await write("a.md", "remote");
				},
			},
		);
		await assert.rejects(git.clone(URL, NOW), { message: INCOMPLETE("missing.md") });
		fake.done();
		assert.equal(fsSync.lstatSync(path.join(dir, "alias.md")).isSymbolicLink(), true);
		assert.equal(await fs.readlink(path.join(dir, "alias.md")), path.join(dir, "keep/notes.md"));
		assert.deepEqual(await snapshot(), before);
	});

	test("a partial checkout of a graph ledger does not make the retry look like own data", async () => {
		const remote = ["chats/one.json", "graph/nodes.jsonl"];
		const first = scripted(
			[
				...remoteSetup("main", remote),
				{ args: checkout("main") },
				{ args: VERIFY, result: { stdout: "chats/one.json\0" } },
			],
			{ [checkout("main").join(" ")]: () => write("graph/nodes.jsonl", '{"id":1}\n') },
		);
		await assert.rejects(first.git.clone(URL, NOW), { message: INCOMPLETE("chats/one.json") });
		first.fake.done();
		assert.deepEqual(await fs.readdir(dir), []);
		const second = scripted([...remoteSetup("main", remote), { args: checkout("main") }, { args: VERIFY }], {
			[checkout("main").join(" ")]: async () => {
				await write("chats/one.json", '{"id":"a"}');
				await write("graph/nodes.jsonl", '{"id":1}\n');
			},
		});
		assert.deepEqual(await second.git.clone(URL, NOW), { branch: "main", backupDir: null, backedUp: [] });
		second.fake.done();
	});

	test("a folder original the checkout replaced keeps every byte", async () => {
		const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13]);
		await write("sources/keep.json", '{"keep":true}');
		await write("sources/nested/deep.txt", "deep");
		await fs.writeFile(path.join(dir, "sources/blob.bin"), bytes);
		const before = await snapshot();
		const { fake, git } = scripted(
			[
				...remoteSetup("main", ["sources", "a.md"]),
				{ args: checkout("main") },
				{ args: VERIFY, result: { stdout: "missing.md\0" } },
			],
			{
				[checkout("main").join(" ")]: async () => {
					await write("sources", "remote file where a local folder was");
					await write("a.md", "remote");
				},
			},
		);
		await assert.rejects(git.clone(URL, NOW), { message: INCOMPLETE("missing.md") });
		fake.done();
		assert.deepEqual(await snapshot(), before);
		assert.deepEqual([...(await fs.readFile(path.join(dir, "sources/blob.bin")))], [...bytes]);
	});

	test("a missing path with spaces and accents is named exactly and odd originals survive", async () => {
		await write("a b.txt", "space");
		await write("new\nline.txt", "newline");
		const before = await snapshot();
		const { fake, git } = scripted(
			[
				...remoteSetup("main", ["a b.txt", "new\nline.txt", "nëw/f i.txt"]),
				{ args: checkout("main") },
				{ args: VERIFY, result: { stdout: "nëw/f i.txt\0" } },
			],
			{
				[checkout("main").join(" ")]: async () => {
					await write("a b.txt", "remote");
					await write("new\nline.txt", "remote");
				},
			},
		);
		await assert.rejects(git.clone(URL, NOW), { message: INCOMPLETE("nëw/f i.txt") });
		fake.done();
		assert.deepEqual(await snapshot(), before);
	});
});
