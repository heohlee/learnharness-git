import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createGit, type GitRunner } from "../src/git.ts";
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

/** The fake git plus the one effect of `git init` the clone relies on: a `.git` directory. */
function scripted(script: ScriptedCall[]) {
	const fake = fakeGit(script);
	const run: GitRunner = async (args, options) => {
		const result = await fake.run(args, options);
		if (args[0] === "init" && result.code === 0)
			await fs.mkdir(path.join(options.cwd, ".git", "info"), { recursive: true });
		return result;
	};
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
		const { fake, git } = scripted([...remoteSetup("main", ["settings.json"]), { args: checkout("main") }]);
		assert.deepEqual(await git.clone(URL, NOW), { branch: "main", backupDir: null, backedUp: [] });
		fake.done();
	});
	test("chats as a plain file is not a sessions folder", async () => {
		await write("chats", "x");
		const { fake, git } = scripted([...remoteSetup("main", ["notes.md"]), { args: checkout("main") }]);
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
		const { fake, git } = scripted([...remoteSetup("trunk", remote), { args: checkout("trunk") }]);

		assert.deepEqual(await git.clone(URL, NOW), {
			branch: "trunk",
			backupDir: STAMP,
			backedUp: ["graph/format.json", "notes", "plugins-state.json", "settings.json"],
		});
		fake.done();
		assert.deepEqual(
			fake.calls.map((call) => call.args),
			[INIT, ADD, FETCH, SYMREF, verify("trunk"), lsTree("trunk"), checkout("trunk")],
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
		const { fake, git } = scripted([...remoteSetup("main", ["a.md"]), { args: checkout("main") }]);
		await git.clone(URL, NOW);
		fake.done();
		assert.deepEqual(await snapshot(), [".git/", ".git/info/", ".git/info/exclude: .learnharness-git-backup/\n"]);
	});
	test("appends the exclude line after existing exclude rules", async () => {
		const { fake, git } = scripted([...remoteSetup("main", ["a.md"]), { args: checkout("main") }]);
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
		const { fake, git } = scripted([...script, { args: checkout("main") }]);
		assert.deepEqual(await git.clone(URL, NOW), { branch: "main", backupDir: null, backedUp: [] });
		fake.done();
	});
	test("never reuses an existing backup folder of the same second", async () => {
		await write(`${STAMP}/settings.json`, "older backup");
		await write("settings.json", "local");
		const { fake, git } = scripted([...remoteSetup("main", ["settings.json"]), { args: checkout("main") }]);
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
