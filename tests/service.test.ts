import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ConflictError, type Git, type RepoState } from "../src/git.ts";
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
		assert.deepEqual(s.calls, ["repoState", "pull"]);
	});
	test("schedules nothing with interval 0 and does not pull without pullOnStart", async () => {
		const s = setup();
		await s.service.start();
		assert.deepEqual(s.timers, []);
		assert.deepEqual(s.calls, []);
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
