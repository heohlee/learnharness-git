import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createFileSettingsStore, DEFAULT_SETTINGS, formatCommitMessage, mergeSettings } from "../src/settings.ts";

describe("mergeSettings", () => {
	test("applies valid partial changes", () => {
		assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, { autoSyncMinutes: 10, autoPush: true }), {
			...DEFAULT_SETTINGS,
			autoSyncMinutes: 10,
			autoPush: true,
		});
	});
	test("resolves conflicts automatically by default and accepts manual", () => {
		assert.equal(DEFAULT_SETTINGS.conflictMode, "auto");
		assert.equal(mergeSettings(DEFAULT_SETTINGS, { conflictMode: "manual" }).conflictMode, "manual");
		assert.equal(
			mergeSettings({ ...DEFAULT_SETTINGS, conflictMode: "manual" }, { conflictMode: "auto" }).conflictMode,
			"auto",
		);
	});
	test("ignores unknown keys", () => {
		assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, { other: 1 }), DEFAULT_SETTINGS);
	});
	const invalid: [string, unknown, string][] = [
		["autoSyncMinutes", -1, "Auto sync interval must be a whole number of minutes between 0 and 1440."],
		["autoSyncMinutes", 1441, "Auto sync interval must be a whole number of minutes between 0 and 1440."],
		["autoSyncMinutes", 1.5, "Auto sync interval must be a whole number of minutes between 0 and 1440."],
		["pullOnStart", "yes", "Pull on start must be true or false."],
		["autoPush", 1, "Push after auto commit must be true or false."],
		["commitMessage", "   ", "Commit message template must not be empty."],
		["commitMessage", "x".repeat(201), "Commit message template must be at most 200 characters."],
		["conflictMode", "newest", "Conflicts must be automatic or manual."],
		["conflictMode", 1, "Conflicts must be automatic or manual."],
	];
	for (const [key, value, message] of invalid) {
		test(`rejects ${key}=${JSON.stringify(value).slice(0, 20)}`, () => {
			assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { [key]: value }), { message });
		});
	}
	test("accepts the boundaries 0 and 1440", () => {
		assert.equal(mergeSettings(DEFAULT_SETTINGS, { autoSyncMinutes: 0 }).autoSyncMinutes, 0);
		assert.equal(mergeSettings(DEFAULT_SETTINGS, { autoSyncMinutes: 1440 }).autoSyncMinutes, 1440);
	});
	test("rejects a non-object", () => {
		assert.throws(() => mergeSettings(DEFAULT_SETTINGS, null), { message: "Settings must be an object." });
	});
});

test("formatCommitMessage replaces {{date}} with local YYYY-MM-DD HH:mm", () => {
	assert.equal(
		formatCommitMessage("backup {{date}} / {{date}}", new Date(2026, 0, 5, 7, 3)),
		"backup 2026-01-05 07:03 / 2026-01-05 07:03",
	);
});

describe("file settings store", () => {
	let dir = "";
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "learnharness-git-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});
	test("loads defaults when no file exists", async () => {
		assert.deepEqual(await createFileSettingsStore(path.join(dir, "data")).load(), DEFAULT_SETTINGS);
	});
	test("saves, creating the directory, and loads back", async () => {
		const store = createFileSettingsStore(path.join(dir, "data"));
		const settings = { ...DEFAULT_SETTINGS, autoSyncMinutes: 5 };
		await store.save(settings);
		assert.deepEqual(await store.load(), settings);
		assert.deepEqual(await fs.readdir(path.join(dir, "data")), ["settings.json"]);
	});
	test("falls back to defaults for invalid stored values", async () => {
		await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ autoSyncMinutes: -3, autoPush: true }));
		assert.deepEqual(await createFileSettingsStore(dir).load(), { ...DEFAULT_SETTINGS, autoPush: true });
	});
	test("falls back to defaults for unreadable JSON", async () => {
		await fs.writeFile(path.join(dir, "settings.json"), "{");
		assert.deepEqual(await createFileSettingsStore(dir).load(), DEFAULT_SETTINGS);
	});
});
