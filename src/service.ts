/** Plugin backend logic: serialized git operations, automatic sync and JSON handlers. */

import { sensitiveFiles } from "./format.ts";
import { ConflictError, type Git, type RepoState, type Resolution, type Side } from "./git.ts";
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
	/** When the next automatic sync fires, or null when automation is off. */
	nextSync: string | null;
	lastError: string | null;
	/** URL of origin, or null when no remote is configured. */
	remote: string | null;
	/** A clone replaced the learning data; LearnHarness must restart to load it. */
	restartRequired: boolean;
	/** Where the last clone moved colliding local files, or null. */
	cloneBackupDir: string | null;
	/** Branch the last clone checked out, or null. */
	cloneBranch: string | null;
	/**
	 * Conflicted files waiting for the user's choice after an aborted pull, or null. `notes` has one line per file
	 * whose chosen side was rejected because it is not valid JSON.
	 */
	pendingConflicts: { upstream: string; files: { path: string }[]; notes: string[] } | null;
	/** Report of the last automatic or chosen conflict resolution, until dismissed. */
	lastResolution: Resolution | null;
	settings: Settings;
}

export type Handler = (input: unknown) => Promise<unknown>;

const NOT_A_REPO = "No Git repository yet.";

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

/** A remote URL safe to hand to git: no options, no spaces, no embedded password or token. */
function remoteUrl(input: unknown): string {
	const raw = record(input).url;
	const url = typeof raw === "string" ? raw.trim() : "";
	if (!url) throw new Error("Remote URL must not be empty.");
	if (/\s/.test(url)) throw new Error("Remote URL must not contain spaces.");
	if (url.startsWith("-")) throw new Error("Remote URL must not start with “-”.");
	const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^/@]*)@/i.exec(url)?.[1] ?? "";
	const looksLikeToken = /^(ghp_|gho_|ghu_|ghs_|github_pat_|glpat-)/i.test(userinfo);
	if (userinfo.includes(":") || looksLikeToken || /[?&][^=]*token=/i.test(url)) {
		throw new Error("Do not put a password or token in the remote URL. Use SSH or a Git credential helper.");
	}
	return url;
}

/** `{ choices: { "<path>": "local" | "remote" } }` from the conflict screen. */
function choices(input: unknown): Record<string, Side> {
	const value = record(input).choices;
	const valid =
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length > 0 &&
		Object.entries(value).every(([file, side]) => file.length > 0 && (side === "local" || side === "remote"));
	if (!valid) throw new Error("choices must map each file to local or remote.");
	return { ...(value as Record<string, Side>) };
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
		nextSync: null,
		lastError: null,
		remote: null,
		restartRequired: false,
		cloneBackupDir: null,
		cloneBranch: null,
		pendingConflicts: null,
		lastResolution: null,
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
				if (error instanceof ConflictError) {
					state.paused = true;
					state.pendingConflicts = {
						upstream: error.upstream,
						files: error.files.map((file) => ({ path: file })),
						notes: [...error.notes],
					};
				}
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

	/** init and clone create a repository; one that already exists stays untouched. */
	async function refuseRepo(): Promise<void> {
		state.repo = await git.repoState();
		if (state.repo.kind === "repo") throw new Error("Already a Git repository.");
	}

	async function pull(chosen: Record<string, Side> = {}) {
		const result = await git.pull({
			mode: state.settings.conflictMode,
			now: clock.now(),
			choices: chosen,
			onResolved: (resolution) => {
				state.lastResolution = resolution;
			},
		});
		state.paused = false;
		state.pendingConflicts = null;
		return result;
	}

	/** Commit, pull (with the user's conflict choices) and push. */
	async function sync(chosen: Record<string, Side> = {}) {
		const { committed } = await git.commit(message(), { all: true });
		const pullResult = await pull(chosen);
		const pushResult = await git.push();
		state.lastSync = clock.now().toISOString();
		return { committed, pull: pullResult, push: pushResult };
	}

	const message = () => formatCommitMessage(state.settings.commitMessage, clock.now());

	function schedule(): void {
		if (timer !== null) clock.clearInterval(timer);
		timer = null;
		const interval = state.settings.autoSyncMinutes * 60_000;
		const plan = () => {
			state.nextSync = interval > 0 ? new Date(clock.now().getTime() + interval).toISOString() : null;
		};
		plan();
		if (interval > 0)
			timer = clock.setInterval(() => {
				plan();
				void tick();
			}, interval);
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
			// rev-parse is read-only; refresh so views see a repository created or removed outside the plugin.
			if (!state.busy) {
				state.repo = await git.repoState();
				state.remote = state.repo.kind === "repo" ? await git.remoteUrl() : null;
			}
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
				await refuseRepo();
				await git.init();
				state.repo = { kind: "repo" };
			}),
		clone: async (input) => {
			const url = remoteUrl(input);
			return exclusive("clone", async () => {
				await refuseRepo();
				const result = await git.clone(url, clock.now());
				state.repo = { kind: "repo" };
				state.remote = url;
				state.restartRequired = true;
				state.cloneBackupDir = result.backupDir;
				state.cloneBranch = result.branch;
				return result;
			});
		},
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
		sync: inRepo("sync", () => sync()),
		conflictDiff: inRepo("conflict diff", (input) => git.conflictDiff(filePath(input)), read),
		resolveConflicts: async (input) => {
			const chosen = choices(input);
			return exclusive("resolve conflicts", async () => {
				await requireRepo();
				return sync(chosen);
			});
		},
		dismissResolution: () =>
			exclusive("dismiss", async () => {
				state.lastResolution = null;
				return snapshot();
			}),
		previewRemote: async (input) => {
			const url = remoteUrl(input);
			return exclusive(
				"preview remote",
				async () => {
					await requireRepo();
					const files = await git.listFiles();
					// The first push uploads the branch's whole history, not only the current files.
					const { branch } = await git.status();
					const history = branch === null ? [] : await git.historyFiles(branch);
					const everything = [...new Set([...files, ...history])];
					return { url, files: files.length, sensitive: sensitiveFiles(everything) };
				},
				read,
			);
		},
		connectRemote: async (input) => {
			const url = remoteUrl(input);
			return exclusive("connect remote", async () => {
				await requireRepo();
				const { branch } = await git.status();
				if (branch === null) throw new Error("Check out a branch before connecting a remote.");
				await git.commit(message(), { all: true });
				const previous = await git.remoteUrl();
				const previousPush = await git.pushUrls();
				await git.setRemote(url);
				try {
					await git.publish(branch);
				} catch (error) {
					// Leave origin as it was, so Sync keeps using the remote that worked.
					if (previous === null) await git.removeRemote();
					else {
						if (previous !== url) await git.setRemote(previous);
						await git.restorePushUrls(previousPush);
					}
					throw error;
				}
				state.remote = url;
				return { remote: url };
			});
		},
		userName: inRepo("user name", () => git.userName(), read),
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
			state.repo = await git.repoState();
			schedule();
			if (state.settings.pullOnStart) await handlers.pull?.(undefined).catch(() => {});
		},
		stop(): void {
			if (timer !== null) clock.clearInterval(timer);
			timer = null;
			state.nextSync = null;
		},
	};
}

export type Service = ReturnType<typeof createService>;
