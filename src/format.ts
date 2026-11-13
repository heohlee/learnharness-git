/** Pure presentation helpers shared by the views. */
import type { Commit, Status } from "./git.ts";

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
	input: { repo: boolean; lastCommit: string | null; busy: string | null; paused: boolean },
	now: Date,
): string {
	if (input.busy) return `Running ${input.busy}…`;
	if (input.paused) return "Automatic sync paused";
	if (!input.repo || input.lastCommit === null) return "Not backed up yet";
	return `Backed up ${relativeTime(input.lastCommit, now)}`;
}

/** Secondary facts under the headline: pending changes, next sync and branch. */
export function backupDetails(
	input: { changes: number; nextSync: string | null; status: Status | null },
	now: Date,
): string[] {
	const parts = [input.changes ? `${plural(input.changes, "change")} since then` : "No changes since then"];
	if (input.nextSync === null) parts.push("automatic sync off");
	else {
		const minutes = Math.max(1, Math.ceil((new Date(input.nextSync).getTime() - now.getTime()) / 60_000));
		parts.push(`next automatic sync in ${minutes} min`);
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
