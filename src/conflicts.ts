/**
 * Resolution of a pull that stopped on merge conflicts (S13). Every conflicted file gets a side, from the
 * user's choice or (in automatic mode) a per-file rule; the discarded version is copied to a dated backup
 * folder first. A file nobody can decide for leaves the merge to be aborted by the caller.
 */
import fs from "node:fs";
import path from "node:path";
import { BACKUP_ROOT, excludeBackups, freshBackupDir, stamp } from "./clone.ts";
import { invalidJsonNote } from "./format.ts";
import type { GitResult } from "./git.ts";
import type { ConflictMode } from "./settings.ts";

export type Side = "local" | "remote";

export interface ResolvedFile {
	path: string;
	kept: Side | "both";
	/** Why that side was kept, shown in the Details table. */
	rule: string;
}

export interface Resolution {
	/** Folder (relative to the learning data) holding the discarded versions, or null when nothing was discarded. */
	backupDir: string | null;
	files: ResolvedFile[];
}

export interface ConflictPolicy {
	mode: ConflictMode;
	/** The user's pick per conflicted path; it overrides any rule. */
	choices?: Readonly<Record<string, Side>>;
}

type Exec = (args: string[]) => Promise<GitResult>;

interface Decision extends ResolvedFile {
	/** Content per side; null when that side deleted the file. */
	local: string | null;
	remote: string | null;
	/** Merged content written for "both". */
	merged?: string;
	/** Upstream content this decision replaces, saved in the backup folder before it is dropped. */
	dropped?: string;
}

const LITERAL = "--literal-pathspecs";

/** The graph ledgers the plugin merges line by line: one file per graph, graph/*.jsonl. */
export function isGraphLedger(file: string): boolean {
	return /^graph\/[^/]+\.jsonl$/.test(file);
}

/** The session files the app deletes outright when a chat is removed: chats/<id>.json. */
export function isChatFile(file: string): boolean {
	return /^chats\/[^/]+\.json$/.test(file);
}

/** The lines of a ledger, without the empty line a trailing newline leaves. */
export function ledgerLines(text: string): string[] {
	return text.split("\n").filter((line, i, all) => !(line === "" && i === all.length - 1));
}

/**
 * Merges a graph ledger so a record deleted on either computer never comes back: a line base had that this side
 * removed stays removed, a line base had that the upstream removed is dropped here too, and every line either side
 * added is kept.
 */
export function deletionSafeUnion(
	base: readonly string[],
	local: readonly string[],
	remote: readonly string[],
): string {
	const original = new Set(base);
	const upstreamKept = new Set(remote);
	// Deletion wins on both sides: a base line survives only when neither side removed it.
	const merged = local.filter((line) => !original.has(line) || upstreamKept.has(line));
	const seen = new Set(merged);
	for (const line of remote) {
		if (original.has(line) || seen.has(line)) continue;
		merged.push(line);
		seen.add(line);
	}
	return merged.length ? `${merged.join("\n")}\n` : "";
}

/** One path a diverged merge must repair, with its content at the three revisions; null: absent there. */
export interface Repair {
	path: string;
	base: string | null;
	local: string | null;
	remote: string | null;
}

/**
 * Decides one repair so the merge never undoes a removal this computer made: a ledger keeps its local lines plus
 * the upstream ones base did not have, and a chat deleted here stays deleted. Null when the path needs no repair.
 */
export function deletionDecision(repair: Repair): Decision | null {
	const { path: file, base, local, remote } = repair;
	if (isGraphLedger(file)) {
		if (base === null || local === null || remote === null) return null;
		const merged = deletionSafeUnion(ledgerLines(base), ledgerLines(local), ledgerLines(remote));
		// Nothing to repair when the committed ledger already holds the answer: git leaves the file (and any
		// uncommitted edit to it) alone, so writing it here would only risk that edit.
		if (merged === local) return null;
		return { path: file, kept: "both", rule: "union merge, deletions kept", local, remote, merged, dropped: remote };
	}
	// Deletion wins: the app rewrites the ledgers wholesale, so a chat it removed must not come back.
	if (isChatFile(file) && local === null && remote !== null) {
		return { path: file, kept: "local", rule: "deletion kept", local: null, remote: null, dropped: remote };
	}
	return null;
}

/** Conflicted paths, in git's order, with the stages each one has (1 base, 2 local, 3 remote). */
export function parseUnmerged(stdout: string): Map<string, Set<number>> {
	const files = new Map<string, Set<number>>();
	for (const record of stdout.split("\0")) {
		const tab = record.indexOf("\t");
		if (tab < 0) continue;
		const stage = Number(record.slice(0, tab).split(" ")[2]);
		const file = record.slice(tab + 1);
		files.set(file, (files.get(file) ?? new Set()).add(stage));
	}
	return files;
}

type Rule = "session" | "commit" | "version" | "union";

function ruleFor(file: string): Rule | null {
	if (isGraphLedger(file)) return "union";
	if (file === "graph/format.json") return "version";
	if (file.startsWith("chats/") && file.endsWith(".json")) return "session";
	if (
		file === "settings.json" ||
		file === "plugins-state.json" ||
		/^graph\/[^/]+\.json$/.test(file) ||
		file.startsWith("core-plugin-data/")
	) {
		return "commit";
	}
	return null;
}

function parse(text: string | null): unknown {
	if (text === null) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function field(text: string | null, key: string): unknown {
	const value = parse(text);
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function time(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function createResolver(exec: Exec, cwd: string) {
	async function sides(file: string, stages: Set<number>) {
		const show = async (stage: number) =>
			stages.has(stage) ? (await exec(["show", `:${stage}:${file}`])).stdout : null;
		const local = await show(2);
		const remote = await show(3);
		return { local, remote };
	}

	async function commitTime(rev: string, file: string): Promise<number> {
		return Number((await exec([LITERAL, "log", "-1", "--format=%ct", rev, "--", file])).stdout.trim()) || 0;
	}

	/**
	 * The side to keep for one file, null when neither a choice nor a rule decides it safely, or a note when the
	 * user chose a side of a JSON file that is not valid JSON (that choice is rejected, never committed).
	 */
	async function decide(
		file: string,
		stages: Set<number>,
		policy: ConflictPolicy,
	): Promise<Decision | { note: string } | null> {
		const choice = policy.choices?.[file];
		if (choice) {
			const versions = await sides(file, stages);
			const kept = choice === "local" ? versions.local : versions.remote;
			const other = choice === "local" ? versions.remote : versions.local;
			// A deleted side is a valid choice (modify/delete); only existing content must parse.
			if (file.endsWith(".json") && kept !== null && parse(kept) === undefined) {
				return { note: invalidJsonNote(file, choice, other === null || parse(other) !== undefined) };
			}
			return { path: file, kept: choice, rule: "your choice", ...versions };
		}
		if (policy.mode === "manual") return null;
		const rule = ruleFor(file);
		const modifyDelete = stages.has(2) !== stages.has(3);
		if (!modifyDelete && rule === null) return null;
		// A union merge needs the base lines to tell a deletion from an addition.
		const base = !modifyDelete && rule === "union" && stages.has(1) ? (await exec(["show", `:1:${file}`])).stdout : "";
		const versions = await sides(file, stages);
		const pick = (remoteWins: boolean, why: string): Decision => ({
			path: file,
			kept: remoteWins ? "remote" : "local",
			rule: why,
			...versions,
		});
		/** Newer (or higher) side wins; equal values keep local and say so. */
		const compare = (local: number, remote: number, why: string): Decision =>
			pick(remote > local, local === remote ? "tie, local kept" : why);
		let decision: Decision;
		if (modifyDelete) {
			// A graph ledger or a session deleted on one side wins by deletion: an edited copy would resurrect it.
			decision =
				rule === "union" || rule === "session"
					? pick(versions.local !== null, "deletion kept")
					: pick(versions.local === null, "modified kept");
		} else if (rule === "union") {
			const original = ledgerLines(base);
			const local = ledgerLines(versions.local ?? "");
			const remote = ledgerLines(versions.remote ?? "");
			if ([original, local, remote].some((items) => new Set(items).size !== items.length)) return null;
			const merged = deletionSafeUnion(original, local, remote);
			decision = { path: file, kept: "both", rule: "union merge, deletions kept", ...versions, merged };
		} else if (rule === "session") {
			const local = time(field(versions.local, "updatedAt"));
			const remote = time(field(versions.remote, "updatedAt"));
			if (local === null || remote === null) return null;
			decision = compare(local, remote, "newer session");
		} else if (rule === "version") {
			const local = number(field(versions.local, "version"));
			const remote = number(field(versions.remote, "version"));
			if (local === null || remote === null) return null;
			decision = compare(local, remote, "higher version");
		} else {
			const local = await commitTime("HEAD", file);
			decision = compare(local, await commitTime("MERGE_HEAD", file), "newer commit");
		}
		// A JSON file that would not parse breaks LearnHarness: leave it to the user.
		const kept = decision.kept === "local" ? decision.local : decision.remote;
		if (file.endsWith(".json") && kept !== null && parse(kept) === undefined) return null;
		return decision;
	}

	return {
		/**
		 * Decides every conflicted file; returns the decisions, the paths nothing could decide and, in conflict
		 * order, why a rejected choice could not be applied.
		 */
		async plan(
			conflicts: Map<string, Set<number>>,
			policy: ConflictPolicy,
		): Promise<{ decisions: Decision[]; undecided: string[]; notes: string[] }> {
			const decisions: Decision[] = [];
			const undecided: string[] = [];
			const notes: string[] = [];
			for (const [file, stages] of conflicts) {
				const decision = await decide(file, stages, policy);
				if (decision === null) undecided.push(file);
				else if ("note" in decision) {
					undecided.push(file);
					notes.push(decision.note);
				} else decisions.push(decision);
			}
			return { decisions, undecided, notes };
		},

		/** Backs up each discarded version, stages the kept one and commits the merge. */
		async apply(decisions: readonly Decision[], now: Date): Promise<Resolution> {
			const discarded = decisions.flatMap((d) => {
				if (d.kept === "both") return [];
				const loser = d.kept === "local" ? d.remote : d.local;
				return loser === null ? [] : [{ file: d.path, stage: d.kept === "local" ? 3 : 2 }];
			});
			const replaced = decisions.some((d) => d.dropped !== undefined);
			let backupDir: string | null = null;
			if (discarded.length || replaced) {
				backupDir = freshBackupDir(cwd, `${BACKUP_ROOT}/conflicts/${stamp(now)}`);
				for (const { file, stage } of discarded) {
					const target = path.join(cwd, backupDir, file);
					fs.mkdirSync(path.dirname(target), { recursive: true });
					// git writes the blob itself, so a binary version is kept byte for byte.
					const out = await exec(["checkout-index", `--stage=${stage}`, "--temp", "--", file]);
					fs.renameSync(path.join(cwd, out.stdout.slice(0, out.stdout.indexOf("\t"))), target);
				}
				// Content read from the upstream revision (a repaired ledger, a chat deleted here): kept first.
				for (const d of decisions) {
					if (d.dropped === undefined) continue;
					const target = path.join(cwd, backupDir, d.path);
					fs.mkdirSync(path.dirname(target), { recursive: true });
					fs.writeFileSync(target, d.dropped);
				}
				excludeBackups(cwd);
			}
			for (const d of decisions) {
				if (d.merged !== undefined) {
					fs.writeFileSync(path.join(cwd, d.path), d.merged);
					await exec([LITERAL, "add", "--", d.path]);
				} else if ((d.kept === "local" ? d.local : d.remote) === null) {
					await exec([LITERAL, "rm", "-q", "--", d.path]);
				} else {
					await exec([LITERAL, "checkout", d.kept === "local" ? "--ours" : "--theirs", "--", d.path]);
					await exec([LITERAL, "add", "--", d.path]);
				}
			}
			await exec(["commit", "--no-edit", "-q"]);
			return { backupDir, files: decisions.map(({ path: file, kept, rule }) => ({ path: file, kept, rule })) };
		},
	};
}
