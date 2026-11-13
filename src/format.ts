/** Pure presentation helpers shared by the views. */
import type { Status } from "./git.ts";

export function describeBranch(status: Status): string {
	if (status.branch === null) return "Detached HEAD";
	if (!status.hasCommits) return `${status.branch} (no commits yet)`;
	if (!status.upstream) return `${status.branch} (no upstream)`;
	const divergence = [status.ahead ? `↑${status.ahead}` : "", status.behind ? `↓${status.behind}` : ""]
		.filter(Boolean)
		.join(" ");
	return `${status.branch} → ${status.upstream}${divergence ? ` · ${divergence}` : ""}`;
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
