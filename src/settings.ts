/** Plugin settings: defaults, validation and an atomic JSON file store. */
import fs from "node:fs/promises";
import path from "node:path";

/** How a pull that stops on merge conflicts is resolved: by per-file rules, or by the user. */
export type ConflictMode = "auto" | "manual";

export interface Settings {
	/** Minutes between automatic commits; 0 disables automation. */
	autoSyncMinutes: number;
	pullOnStart: boolean;
	/** After an automatic commit, pull and then push. */
	autoPush: boolean;
	/** Template for automatic and default commit messages; `{{date}}` is replaced. */
	commitMessage: string;
	conflictMode: ConflictMode;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
	autoSyncMinutes: 0,
	pullOnStart: false,
	autoPush: false,
	commitMessage: "learnharness backup: {{date}}",
	conflictMode: "auto",
});

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`);
	return value;
}

/** Returns `current` with the recognized keys of `changes` applied; throws on the first invalid value. */
export function mergeSettings(current: Readonly<Settings>, changes: unknown): Settings {
	if (typeof changes !== "object" || changes === null || Array.isArray(changes)) {
		throw new Error("Settings must be an object.");
	}
	const input = changes as Record<string, unknown>;
	const next: Settings = { ...current };
	if ("autoSyncMinutes" in input) {
		const value = input.autoSyncMinutes;
		if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1440) {
			throw new Error("Auto sync interval must be a whole number of minutes between 0 and 1440.");
		}
		next.autoSyncMinutes = value;
	}
	if ("pullOnStart" in input) next.pullOnStart = boolean(input.pullOnStart, "Pull on start");
	if ("autoPush" in input) next.autoPush = boolean(input.autoPush, "Push after auto commit");
	if ("commitMessage" in input) {
		const value = input.commitMessage;
		if (typeof value !== "string" || !value.trim()) throw new Error("Commit message template must not be empty.");
		if (value.length > 200) throw new Error("Commit message template must be at most 200 characters.");
		next.commitMessage = value;
	}
	if ("conflictMode" in input) {
		const value = input.conflictMode;
		if (value !== "auto" && value !== "manual") throw new Error("Conflicts must be automatic or manual.");
		next.conflictMode = value;
	}
	return next;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatCommitMessage(template: string, date: Date): string {
	const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return template.replaceAll("{{date}}", stamp);
}

export interface SettingsStore {
	load(): Promise<Settings>;
	save(settings: Settings): Promise<void>;
}

export function createFileSettingsStore(directory: string): SettingsStore {
	const file = path.join(directory, "settings.json");
	return {
		async load() {
			let stored: unknown;
			try {
				stored = JSON.parse(await fs.readFile(file, "utf8"));
			} catch {
				return { ...DEFAULT_SETTINGS };
			}
			// Keep each valid stored value; an invalid one falls back to its default.
			let settings: Settings = { ...DEFAULT_SETTINGS };
			if (typeof stored !== "object" || stored === null) return settings;
			for (const [key, value] of Object.entries(stored)) {
				try {
					settings = mergeSettings(settings, { [key]: value });
				} catch {
					// ignore the invalid value
				}
			}
			return settings;
		},
		async save(settings) {
			await fs.mkdir(directory, { recursive: true });
			const temporary = `${file}.${process.pid}.tmp`;
			await fs.writeFile(temporary, `${JSON.stringify(settings, null, "\t")}\n`);
			await fs.rename(temporary, file);
		},
	};
}
