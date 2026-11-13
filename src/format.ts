/** Pure presentation helpers shared by the views. */
import type { Commit, ResolvedFile, Status } from "./git.ts";

export function describeBranch(status: Status): string {
	if (status.branch === null) return "Detached HEAD";
	if (!status.hasCommits) return `${status.branch} (no commits yet)`;
	if (!status.upstream) return `${status.branch} (no upstream)`;
	const divergence = [status.ahead ? `↑${status.ahead}` : "", status.behind ? `↓${status.behind}` : ""]
		.filter(Boolean)
		.join(" ");
	return `${status.branch} → ${status.upstream} · ${divergence || "up to date"}`;
}

const MAX_DIFF = 200_000;

/** Markdown for a diff, fenced safely so its content can never close the fence. */
export function diffMarkdown(diff: string): string {
	if (!diff) return "_No changes to show._";
	const body = diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) : diff;
	const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	const text = `${fence}diff\n${body.replace(/\n$/, "")}\n${fence}`;
	return diff.length > MAX_DIFF ? `${text}\n\n_Diff truncated at ${MAX_DIFF} characters._` : text;
}

const LABELS: Record<string, string> = {
	M: "Modified",
	A: "Added",
	D: "Deleted",
	R: "Renamed",
	C: "Copied",
	T: "Type changed",
	U: "Conflict",
	"?": "Untracked",
};

export function changeLabel(code: string): string {
	return LABELS[code] ?? code;
}

export function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function relativeTime(iso: string, now: Date): string {
	const seconds = Math.floor((now.getTime() - new Date(iso).getTime()) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${plural(minutes, "minute")} ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${plural(hours, "hour")} ago`;
	return `${plural(Math.floor(hours / 24), "day")} ago`;
}

const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const pad = (n: number) => String(n).padStart(2, "0");

/** Compact local time for lists: today as HH:mm, yesterday labelled, older with the date. */
export function shortTime(iso: string, now: Date): string {
	const date = new Date(iso);
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	if (day(date) === day(now)) return time;
	const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
	if (day(date) === day(yesterday)) return `Yesterday ${time}`;
	return `${day(date)} ${time}`;
}

/**
 * The facts of one history row: file count, short local time and the author only when it is not the configured
 * user (`null` when the user cannot be read, so no row names an author).
 */
export function commitCells(
	commit: Commit,
	user: string | null,
	now: Date,
): { files: string; time: string; author: string | null } {
	return {
		files: plural(commit.files.length, "file"),
		time: shortTime(commit.date, now),
		author: user !== null && commit.author !== user ? commit.author : null,
	};
}

export function backupHeadline(
	input: {
		repo: boolean;
		lastCommit: string | null;
		busy: string | null;
		paused: boolean;
		restartRequired?: boolean;
		cloneBranch?: string | null;
		/** Conflicted files waiting for a choice while paused. */
		conflicts?: number;
	},
	now: Date,
): string {
	if (input.busy) return `Running ${input.busy}…`;
	if (input.restartRequired) return `Cloned origin/${input.cloneBranch ?? "main"}. Restart LearnHarness.`;
	if (input.paused)
		return input.conflicts
			? `Sync paused: ${conflictHeadline(input.conflicts).toLowerCase()}`
			: "Sync paused: merge conflict";
	if (!input.repo || input.lastCommit === null) return "Not backed up yet";
	return `Backed up ${relativeTime(input.lastCommit, now)}`;
}

/** Text under the restart headline after a clone: where replaced local files went, if any. */
export function cloneDetails(backupDir: string | null): string {
	return backupDir === null ? "" : `Replaced local files moved to ${backupDir}.`;
}

/** Secondary facts under the headline: pending changes, next sync and branch. */
export function backupDetails(
	input: { changes: number; nextSync: string | null; status: Status | null },
	now: Date,
): string[] {
	const parts = [input.changes ? plural(input.changes, "change") : "No changes"];
	if (input.nextSync === null) parts.push("auto sync off");
	else {
		const minutes = Math.max(1, Math.ceil((new Date(input.nextSync).getTime() - now.getTime()) / 60_000));
		parts.push(`next sync in ${minutes} min`);
	}
	if (input.status) parts.push(describeBranch(input.status));
	return parts;
}

/**
 * Files worth a second look before pushing: the app's root settings (model configuration)
 * and any file whose name mentions a token or an API key.
 */
export function sensitiveFiles(paths: readonly string[]): string[] {
	return paths.filter((file) => {
		const name = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
		return file === "settings.json" || name.includes("token") || name.replace(/[-_]/g, "").includes("apikey");
	});
}

/** Headline of the conflict screen. */
export function conflictHeadline(files: number): string {
	return `Merge conflict in ${plural(files, "file")}`;
}

/** Why "Resolve and sync" is disabled. */
export function filesLeft(files: number): string {
	return `${plural(files, "file")} left.`;
}

/** One-line notice after a resolution; "newest kept" only when no file was the user's choice. */
export function resolvedNotice(files: readonly ResolvedFile[]): string {
	const text = `Merge conflict in ${plural(files.length, "file")} resolved`;
	return files.some((file) => file.rule === "your choice") ? `${text}.` : `${text}: newest kept.`;
}

/** Message of a pull aborted on conflicts. */
export function conflictMessage(upstream: string): string {
	return `Merge conflict with ${upstream}. Pull aborted; no files changed.`;
}

/**
 * Why the user's choice of a JSON file's side was rejected (S17): that side is not valid JSON. `otherValid` says
 * whether the other side can be picked instead; when it cannot, only a fix by hand with git is left.
 */
export function invalidJsonNote(file: string, side: "local" | "remote", otherValid: boolean): string {
	if (!otherValid) return `${file}: both versions are not valid JSON. Fix it by hand with git.`;
	return side === "local"
		? `${file}: the Local version is not valid JSON. Pick Remote.`
		: `${file}: the Remote version is not valid JSON. Pick Local.`;
}

/** Whether an error only repeats an aborted pull's conflict, which the conflict screen already shows. */
export function isConflictMessage(message: string): boolean {
	return /^Merge conflict with \S+\. Pull aborted; no files changed\.$/.test(message);
}

/**
 * The one error the dashboard's error box shows: the failure of the user's last action in this view, otherwise the
 * backend's current error. While git runs the backend error is stale and hidden; while paused the headline and its
 * details already carry it. An aborted pull's conflict is never repeated, since the conflict screen shows it.
 */
export function visibleError(input: {
	localError: string | null;
	lastError: string | null;
	busy: string | null;
	paused: boolean;
}): string | null {
	const shown = input.localError ?? (input.busy || input.paused ? null : input.lastError);
	return shown && !isConflictMessage(shown) ? shown : null;
}

/** Line above a conflict diff: `-` lines are local (HEAD), `+` lines are the upstream. */
export const CONFLICT_DIFF_LEGEND = "− Local · + Remote";

export function keptLabel(kept: ResolvedFile["kept"]): string {
	return kept === "local" ? "Local" : kept === "remote" ? "Remote" : "Both";
}

const AUTH =
	/^Git authentication failed\. (No credentials for .+?\. Set up one, then retry:) (gh auth login && gh auth setup-git), or use an SSH URL(?: \((.+)\))?\.$/;

/** The parts of an authentication failure message, so a view can show each fix on its own line. */
export function authHint(message: string): { headline: string; sub: string; gh: string; ssh: string | null } | null {
	const match = AUTH.exec(message);
	if (!match) return null;
	return {
		headline: "Git authentication failed",
		sub: match[1] as string,
		gh: match[2] as string,
		ssh: match[3] ?? null,
	};
}
