import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ConflictError, type Git, MergeInProgressError, type RepoState } from "../src/git.ts";
import { type Clock, createService } from "../src/service.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/settings.ts";

function setup(options: { settings?: Partial<Settings>; repo?: RepoState; git?: Partial<Git> } = {}) {
	const calls: string[] = [];
	const events: { topic: string; data: unknown }[] = [];
	const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
	let saved: Settings | null = null;
	const clock: Clock = {
		now: () => new Date(2026, 10, 12, 9, 30),
		setInterval(fn, ms) {
			const timer = { fn, ms, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearInterval(handle) {
			(handle as { cleared: boolean }).cleared = true;
		},
	};
	const record =
		<T>(name: string, value: T) =>
		async (...args: unknown[]) => {
			calls.push(args.length ? `${name} ${JSON.stringify(args)}` : name);
			return value;
		};
	const git = {
		repoState: record("repoState", options.repo ?? { kind: "repo" }),
		init: record("init", undefined),
		status: record("status", { branch: "main" }),
		stage: record("stage", undefined),
		unstage: record("unstage", undefined),
		diff: record("diff", "DIFF"),
		commit: record("commit", { committed: true }),
		pull: record("pull", "pulled"),
		push: record("push", "pushed"),
		log: record("log", []),
		userName: record("userName", "Ada"),
		remoteUrl: record("remoteUrl", null),
		setRemote: record("setRemote", undefined),
		publish: record("publish", undefined),
		listFiles: record("listFiles", ["settings.json", "graph/nodes.jsonl"]),
		historyFiles: record("historyFiles", []),
		removeRemote: record("removeRemote", undefined),
		pushUrls: record("pushUrls", []),
		restorePushUrls: record("restorePushUrls", undefined),
		clone: record("clone", { branch: "main", backupDir: ".learnharness-git-backup/x", backedUp: ["settings.json"] }),
		...options.git,
	} as Git;
	const service = createService({
		git,
		clock,
		store: {
			load: async () => ({ ...DEFAULT_SETTINGS, ...options.settings }),
			save: async (settings) => {
				saved = settings;
			},
		},
		emit: (topic, data) => events.push({ topic, data }),
	});
	return { service, calls, events, timers, saved: () => saved };
}

const call = (s: ReturnType<typeof setup>, name: string, input?: unknown) => {
	const handler = s.service.handlers[name];
	assert.ok(handler, `missing handler ${name}`);
	return handler(input);
};

describe("start", () => {
	test("schedules auto sync every N minutes and pulls on start", async () => {
		const s = setup({ settings: { autoSyncMinutes: 5, pullOnStart: true } });
		await s.service.start();
		assert.deepEqual(
			s.timers.map((t) => t.ms),
			[300_000],
		);
		assert.deepEqual(s.calls, ["repoState", "repoState", "pull"]);
	});
	test("schedules nothing with interval 0 and does not pull without pullOnStart", async () => {
		const s = setup();
		await s.service.start();
		assert.deepEqual(s.timers, []);
		assert.deepEqual(s.calls, ["repoState"]);
	});
	test("exposes the next automatic sync time, or null when automation is off", async () => {
		const s = setup({ settings: { autoSyncMinutes: 5 } });
		await s.service.start();
		assert.equal(
			((await call(s, "state")) as { nextSync: string }).nextSync,
			new Date(2026, 10, 12, 9, 35).toISOString(),
		);
		await call(s, "saveSettings", { autoSyncMinutes: 0 });
		assert.equal(((await call(s, "state")) as { nextSync: null }).nextSync, null);
	});
	test("discovers an existing repository so views can render it", async () => {
		for (const repo of [{ kind: "repo" }, { kind: "nested", topLevel: "/home" }] as RepoState[]) {
			const s = setup({ repo });
			await s.service.start();
			assert.deepEqual(((await call(s, "state")) as { repo: RepoState }).repo, repo);
		}
	});
	test("stop clears the timer", async () => {
		const s = setup({ settings: { autoSyncMinutes: 1 } });
		await s.service.start();
		s.service.stop();
		assert.equal(s.timers[0]?.cleared, true);
	});
});

describe("auto sync tick", () => {
	test("commits everything with the template message", async () => {
		const s = setup({ settings: { autoSyncMinutes: 1 } });
		await s.service.start();
		await s.service.tick();
		assert.deepEqual(s.calls, [
			"repoState",
			"repoState",
			`commit ${JSON.stringify(["learnharness backup: 2026-11-12 09:30", { all: true }])}`,
		]);
		assert.equal(
			((await call(s, "state")) as { lastSync: string }).lastSync,
			new Date(2026, 10, 12, 9, 30).toISOString(),
		);
	});
	test("pulls then pushes when autoPush is on", async () => {
		const s = setup({ settings: { autoSyncMinutes: 1, autoPush: true } });
		await s.service.tick();
		assert.deepEqual(s.calls.slice(2), ["pull", "push"]);
	});
	test("skips when the folder is not a repository", async () => {
		const s = setup({ repo: { kind: "none" } });
		await s.service.tick();
		assert.deepEqual(s.calls, ["repoState"]);
	});
	test("a conflict pauses automation until a pull succeeds", async () => {
		let conflict = true;
		const s = setup({
			settings: { autoPush: true },
			git: {
				pull: async () => {
					if (conflict) throw new ConflictError();
					return "pulled";
				},
			},
		});
		await s.service.tick();
		const paused = (await call(s, "state")) as { paused: boolean; lastError: string };
		assert.equal(paused.paused, true);
		assert.equal(paused.lastError, new ConflictError().message);
		s.calls.length = 0;
		await s.service.tick();
		assert.deepEqual(s.calls, []);
		conflict = false;
		await call(s, "pull");
		assert.equal(((await call(s, "state")) as { paused: boolean; lastError: null }).paused, false);
	});
	test("records other errors without pausing", async () => {
		const s = setup({ git: { commit: async () => Promise.reject(new Error("boom")) } });
		await s.service.tick();
		const state = (await call(s, "state")) as { paused: boolean; lastError: string };
		assert.deepEqual([state.paused, state.lastError], [false, "boom"]);
	});
});

describe("handlers", () => {
	test("operations are serialized", async () => {
		const order: string[] = [];
		let release = () => {};
		const s = setup({
			git: {
				pull: () =>
					new Promise((resolve) => {
						order.push("pull start");
						release = () => {
							order.push("pull end");
							resolve("pulled");
						};
					}),
				push: async () => {
					order.push("push");
					return "pushed";
				},
			},
		});
		const pull = call(s, "pull");
		const push = call(s, "push");
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(order, ["pull start"]);
		release();
		await Promise.all([pull, push]);
		assert.deepEqual(order, ["pull start", "pull end", "push"]);
	});
	test("refuse to run outside a repository", async () => {
		const s = setup({ repo: { kind: "none" } });
		await assert.rejects(call(s, "status"), {
			message: "The learning data folder is not a Git repository yet. Run “Initialize repository” first.",
		});
		assert.deepEqual(s.calls, ["repoState"]);
	});
	test("init runs only when no repository exists at the folder", async () => {
		const s = setup({ repo: { kind: "nested", topLevel: "/home" } });
		await call(s, "init");
		assert.deepEqual(s.calls, ["repoState", "init"]);
		const t = setup();
		await assert.rejects(call(t, "init"), { message: "The learning data folder is already a Git repository." });
		assert.deepEqual(t.calls, ["repoState"]);
	});
	test("commit uses the given message or the template", async () => {
		const s = setup();
		assert.deepEqual(await call(s, "commit", { message: "mine", all: false }), { committed: true });
		await call(s, "commit", { message: "  ", all: true });
		assert.deepEqual(
			s.calls.filter((c) => c.startsWith("commit")),
			[
				`commit ${JSON.stringify(["mine", { all: false }])}`,
				`commit ${JSON.stringify(["learnharness backup: 2026-11-12 09:30", { all: true }])}`,
			],
		);
	});
	test("sync commits, pulls and pushes", async () => {
		const s = setup();
		assert.deepEqual(await call(s, "sync"), { committed: true, pull: "pulled", push: "pushed" });
	});
	test("stage, unstage and diff validate their input", async () => {
		const s = setup();
		await call(s, "stage", { paths: ["a.json"] });
		await call(s, "unstage", { paths: [] });
		assert.equal(await call(s, "diff", { path: "a.json", staged: true, untracked: false }), "DIFF");
		await assert.rejects(call(s, "stage", { paths: [3] }), { message: "paths must be a list of file paths." });
		await assert.rejects(call(s, "diff", { path: "" }), { message: "path must be a non-empty string." });
		assert.deepEqual(
			s.calls.filter((c) => c !== "repoState"),
			[
				`stage ${JSON.stringify([["a.json"]])}`,
				`unstage ${JSON.stringify([[]])}`,
				`diff ${JSON.stringify(["a.json", { staged: true, untracked: false }])}`,
			],
		);
	});
	test("log clamps its limit to 1..1000 with default 100", async () => {
		const s = setup();
		await call(s, "log");
		await call(s, "log", { limit: 5000 });
		assert.deepEqual(
			s.calls.filter((c) => c.startsWith("log")),
			["log [100]", "log [1000]"],
		);
	});
	test("userName reads the configured git user without emitting state", async () => {
		const s = setup();
		assert.equal(await call(s, "userName"), "Ada");
		assert.deepEqual(
			s.calls.filter((c) => c !== "repoState"),
			["userName"],
		);
		assert.deepEqual(s.events, []);
	});
	test("saveSettings validates, saves, reschedules and emits state", async () => {
		const s = setup({ settings: { autoSyncMinutes: 1 } });
		await s.service.start();
		await call(s, "saveSettings", { autoSyncMinutes: 2 });
		assert.equal(s.saved()?.autoSyncMinutes, 2);
		assert.deepEqual(
			s.timers.map((t) => [t.ms, t.cleared]),
			[
				[60_000, true],
				[120_000, false],
			],
		);
		assert.equal(s.events.at(-1)?.topic, "state");
		await assert.rejects(call(s, "saveSettings", { autoSyncMinutes: -1 }), {
			message: "Auto sync interval must be a whole number of minutes between 0 and 1440.",
		});
		assert.equal(s.saved()?.autoSyncMinutes, 2);
		assert.equal(s.timers.length, 2);
	});
	test("every finished operation emits state", async () => {
		const s = setup();
		await call(s, "push");
		const last = s.events.at(-1) as { topic: string; data: { busy: string | null } };
		assert.deepEqual([last.topic, last.data.busy], ["state", null]);
	});
	test("reads never emit state or change lastError", async () => {
		const s = setup({ git: { status: async () => Promise.reject(new Error("locked")) } });
		await call(s, "log");
		await call(s, "diff", { path: "a.json" });
		await assert.rejects(call(s, "status"), { message: "locked" });
		assert.deepEqual(s.events, []);
		assert.equal(((await call(s, "state")) as { lastError: null }).lastError, null);
	});
});

describe("remote", () => {
	const URL = "git@github.com:me/learning-data.git";
	test("state reports origin's URL", async () => {
		const s = setup({ git: { remoteUrl: async () => URL } });
		assert.equal(((await call(s, "state")) as { remote: string }).remote, URL);
	});
	test("previewRemote counts the files to push and lists the sensitive ones, without writing", async () => {
		const s = setup();
		assert.deepEqual(await call(s, "previewRemote", { url: URL }), {
			url: URL,
			files: 2,
			sensitive: ["settings.json"],
		});
		assert.deepEqual(s.calls, ["repoState", "listFiles", "status", `historyFiles ${JSON.stringify(["main"])}`]);
		assert.deepEqual(s.events, []);
	});
	const invalid: [unknown, string][] = [
		["", "Remote URL must not be empty."],
		["  ", "Remote URL must not be empty."],
		["git@host:a b.git", "Remote URL must not contain spaces."],
		["--upload-pack=x", "Remote URL must not start with “-”."],
		[
			"https://me:abc123@github.com/me/data.git",
			"Do not put a password or token in the remote URL. Use SSH or a Git credential helper.",
		],
		[3, "Remote URL must not be empty."],
		["git@h:a\nb.git", "Remote URL must not contain spaces."],
		[
			"https://ghp_abcdef123456@github.com/me/data.git",
			"Do not put a password or token in the remote URL. Use SSH or a Git credential helper.",
		],
		[
			"https://github.com/me/data.git?access_token=abc",
			"Do not put a password or token in the remote URL. Use SSH or a Git credential helper.",
		],
	];
	for (const [url, message] of invalid) {
		test(`rejects remote URL ${JSON.stringify(url)} without running git`, async () => {
			const s = setup();
			await assert.rejects(call(s, "previewRemote", { url }), { message });
			await assert.rejects(call(s, "connectRemote", { url }), { message });
			await assert.rejects(call(s, "clone", { url }), { message });
			assert.deepEqual(s.calls, []);
		});
	}
	test("accepts a user name without a password", async () => {
		const s = setup();
		const url = "https://me@github.com/me/data.git";
		assert.equal(((await call(s, "previewRemote", { url })) as { url: string }).url, url);
	});
	test("connectRemote commits pending changes, sets origin and pushes with upstream", async () => {
		const s = setup();
		assert.deepEqual(await call(s, "connectRemote", { url: ` ${URL} ` }), { remote: URL });
		assert.deepEqual(s.calls, [
			"repoState",
			"status",
			`commit ${JSON.stringify(["learnharness backup: 2026-11-12 09:30", { all: true }])}`,
			"remoteUrl",
			"pushUrls",
			`setRemote ${JSON.stringify([URL])}`,
			`publish ${JSON.stringify(["main"])}`,
		]);
		assert.equal(s.events.at(-1)?.topic, "state");
	});
	test("connectRemote refuses a detached HEAD before writing", async () => {
		const s = setup({ git: { status: async () => ({ branch: null }) as never } });
		await assert.rejects(call(s, "connectRemote", { url: URL }), {
			message: "Check out a branch before connecting a remote.",
		});
	});
	test("previewRemote flags sensitive files that exist only in history", async () => {
		const s = setup({
			git: { listFiles: async () => ["a.json"], historyFiles: async () => ["settings.json", "a.json"] },
		});
		assert.deepEqual(await call(s, "previewRemote", { url: URL }), {
			url: URL,
			files: 1,
			sensitive: ["settings.json"],
		});
	});
	test("connectRemote stops before setRemote and publish when the commit refuses an unfinished operation", async () => {
		const s = setup({
			git: {
				commit: async () => {
					throw new MergeInProgressError();
				},
			},
		});
		await assert.rejects(call(s, "connectRemote", { url: URL }), MergeInProgressError);
		assert.deepEqual(s.calls, ["repoState", "status"]);
	});
	test("a failed push restores the previous origin and push URLs", async () => {
		const s = setup({
			git: {
				remoteUrl: async () => "git@old:me/data.git",
				pushUrls: async () => ["git@push:me/data.git"],
				publish: async () => Promise.reject(new Error("git push failed: rejected")),
			},
		});
		await assert.rejects(call(s, "connectRemote", { url: URL }), { message: "git push failed: rejected" });
		assert.deepEqual(s.calls.slice(-3), [
			`setRemote ${JSON.stringify([URL])}`,
			`setRemote ${JSON.stringify(["git@old:me/data.git"])}`,
			`restorePushUrls ${JSON.stringify([["git@push:me/data.git"]])}`,
		]);
	});
	test("a failed push removes an origin that did not exist before", async () => {
		const s = setup({ git: { publish: async () => Promise.reject(new Error("git push failed: rejected")) } });
		await assert.rejects(call(s, "connectRemote", { url: URL }));
		assert.deepEqual(s.calls.slice(-2), [`setRemote ${JSON.stringify([URL])}`, "removeRemote"]);
	});
});

describe("clone", () => {
	const URL = "git@github.com:me/learning-data.git";
	type CloneState = { repo: RepoState; remote: string | null; restartRequired: boolean; cloneBackupDir: string | null };
	test("state starts without a pending restart", async () => {
		const state = (await call(setup(), "state")) as CloneState;
		assert.equal(state.restartRequired, false);
		assert.equal(state.cloneBackupDir, null);
	});
	test("clones into a folder that is not a repository and asks for a restart", async () => {
		const s = setup({ repo: { kind: "none" } });
		assert.deepEqual(await call(s, "clone", { url: ` ${URL} ` }), {
			branch: "main",
			backupDir: ".learnharness-git-backup/x",
			backedUp: ["settings.json"],
		});
		assert.deepEqual(s.calls, ["repoState", `clone ${JSON.stringify([URL, new Date(2026, 10, 12, 9, 30)])}`]);
		const last = s.events.at(-1)?.data as CloneState & { busy: string | null };
		assert.deepEqual(
			s.events.map((event) => [event.topic, (event.data as { busy: string | null }).busy]),
			[
				["state", "clone"],
				["state", null],
			],
		);
		assert.deepEqual(
			{ repo: last.repo, remote: last.remote, restartRequired: last.restartRequired, backup: last.cloneBackupDir },
			{ repo: { kind: "repo" }, remote: URL, restartRequired: true, backup: ".learnharness-git-backup/x" },
		);
	});
	test("clones into a folder nested inside another repository", async () => {
		const s = setup({ repo: { kind: "nested", topLevel: "/home" } });
		await call(s, "clone", { url: URL });
		assert.deepEqual(s.calls, ["repoState", `clone ${JSON.stringify([URL, new Date(2026, 10, 12, 9, 30)])}`]);
	});
	test("refuses a folder that already is a repository before cloning", async () => {
		const s = setup();
		await assert.rejects(call(s, "clone", { url: URL }), {
			message: "The learning data folder is already a Git repository.",
		});
		assert.deepEqual(s.calls, ["repoState"]);
		const state = (await call(s, "state")) as CloneState;
		assert.equal(state.restartRequired, false);
	});
	test("a failed clone records the error and asks for no restart", async () => {
		const s = setup({
			repo: { kind: "none" },
			git: { clone: async () => Promise.reject(new Error("git fetch failed: denied")) },
		});
		await assert.rejects(call(s, "clone", { url: URL }), { message: "git fetch failed: denied" });
		const last = s.events.at(-1)?.data as CloneState & { lastError: string };
		assert.deepEqual(
			{ restartRequired: last.restartRequired, lastError: last.lastError, repo: last.repo, remote: last.remote },
			{ restartRequired: false, lastError: "git fetch failed: denied", repo: { kind: "none" }, remote: null },
		);
	});
});
