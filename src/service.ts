/** Plugin backend logic: serialized git operations, automatic sync and JSON handlers. */
import { ConflictError, type Git, type RepoState } from "./git.ts";
import { DEFAULT_SETTINGS, formatCommitMessage, mergeSettings, type Settings, type SettingsStore } from "./settings.ts";

export interface Clock {
	now(): Date;
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

export interface State {
	repo: RepoState;
	/** Name of the running operation, or null when idle. */
	busy: string | null;
	/** Automation stopped after a merge conflict; cleared by a successful pull. */
	paused: boolean;
	lastSync: string | null;
	lastError: string | null;
	settings: Settings;
}

export type Handler = (input: unknown) => Promise<unknown>;

const NOT_A_REPO = "The learning data folder is not a Git repository yet. Run “Initialize repository” first.";

function record(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

function paths(input: unknown): string[] {
	const value = record(input).paths;
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
		throw new Error("paths must be a list of file paths.");
	}
	return value;
}

function filePath(input: unknown): string {
	const value = record(input).path;
	if (typeof value !== "string" || value.length === 0) throw new Error("path must be a non-empty string.");
	return value;
}

export function createService(deps: {
	git: Git;
	store: SettingsStore;
	clock: Clock;
	emit: (topic: string, data: unknown) => void;
}) {
	const { git, store, clock, emit } = deps;
	const state: State = {
		repo: { kind: "none" },
		busy: null,
		paused: false,
		lastSync: null,
		lastError: null,
		settings: { ...DEFAULT_SETTINGS },
	};
	let loaded: Promise<void> | null = null;
	let timer: unknown = null;
	let tail: Promise<unknown> = Promise.resolve();

	const snapshot = (): State => structuredClone(state);
	const ensureLoaded = () => {
		loaded ??= store.load().then((settings) => {
			state.settings = settings;
		});
		return loaded;
	};

	/** Runs `task` after every earlier operation, so git never races with itself. */
	function exclusive<T>(name: string, task: () => Promise<T>, options: { read?: boolean } = {}): Promise<T> {
		const run = async () => {
			await ensureLoaded();
			// Reads stay silent so views can refresh on "state" without looping.
			if (options.read) return task();
			state.busy = name;
			emit("state", snapshot());
			try {
				const result = await task();
				state.lastError = null;
				return result;
			} catch (error) {
				state.lastError = error instanceof Error ? error.message : String(error);
				if (error instanceof ConflictError) state.paused = true;
				throw error;
			} finally {
				state.busy = null;
				emit("state", snapshot());
			}
		};
		const result = tail.then(run, run);
		tail = result.catch(() => {});
		return result;
	}

	async function requireRepo(): Promise<void> {
		state.repo = await git.repoState();
		if (state.repo.kind !== "repo") throw new Error(NOT_A_REPO);
	}

	async function pull() {
		const result = await git.pull();
		state.paused = false;
		return result;
	}

	const message = () => formatCommitMessage(state.settings.commitMessage, clock.now());

	function schedule(): void {
		if (timer !== null) clock.clearInterval(timer);
		timer = null;
		const minutes = state.settings.autoSyncMinutes;
		if (minutes > 0) timer = clock.setInterval(() => void tick(), minutes * 60_000);
	}

	/** One automatic sync: commit everything, then pull and push when enabled. */
	async function tick(): Promise<void> {
		await ensureLoaded();
		if (state.paused || state.busy) return;
		await exclusive("auto sync", async () => {
			state.repo = await git.repoState();
			if (state.repo.kind !== "repo") return;
			await git.commit(message(), { all: true });
			if (state.settings.autoPush) {
				await pull();
				await git.push();
			}
			state.lastSync = clock.now().toISOString();
		}).catch(() => {
			// recorded in state.lastError and emitted
		});
	}

	const inRepo =
		<T>(name: string, task: (input: unknown) => Promise<T>, options: { read?: boolean } = {}): Handler =>
		(input) =>
			exclusive(
				name,
				async () => {
					await requireRepo();
					return task(input);
				},
				options,
			);
	const read = { read: true };

	const handlers: Record<string, Handler> = {
		state: async () => {
			await ensureLoaded();
			return snapshot();
		},
		saveSettings: (input) =>
			exclusive("settings", async () => {
				const next = mergeSettings(state.settings, input);
				await store.save(next);
				state.settings = next;
				schedule();
				return snapshot();
			}),
		init: () =>
			exclusive("init", async () => {
				state.repo = await git.repoState();
				if (state.repo.kind === "repo") throw new Error("The learning data folder is already a Git repository.");
				await git.init();
				state.repo = { kind: "repo" };
			}),
		status: inRepo("status", () => git.status(), read),
		stage: inRepo("stage", (input) => git.stage(paths(input))),
		unstage: inRepo("unstage", (input) => git.unstage(paths(input))),
		diff: inRepo(
			"diff",
			(input) => {
				const options = record(input);
				return git.diff(filePath(input), { staged: options.staged === true, untracked: options.untracked === true });
			},
			read,
		),
		commit: inRepo("commit", (input) => {
			const options = record(input);
			const text = typeof options.message === "string" && options.message.trim() ? options.message : message();
			return git.commit(text, { all: options.all === true });
		}),
		pull: inRepo("pull", () => pull()),
		push: inRepo("push", () => git.push()),
		sync: inRepo("sync", async () => {
			const { committed } = await git.commit(message(), { all: true });
			const pullResult = await pull();
			const pushResult = await git.push();
			state.lastSync = clock.now().toISOString();
			return { committed, pull: pullResult, push: pushResult };
		}),
		log: inRepo(
			"log",
			(input) => {
				const limit = record(input).limit;
				const value = typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : 100;
				return git.log(Math.min(1000, Math.max(1, value)));
			},
			read,
		),
	};

	return {
		handlers,
		tick,
		async start(): Promise<void> {
			await ensureLoaded();
			schedule();
			if (state.settings.pullOnStart) await handlers.pull?.(undefined).catch(() => {});
		},
		stop(): void {
			if (timer !== null) clock.clearInterval(timer);
			timer = null;
		},
	};
}

export type Service = ReturnType<typeof createService>;
