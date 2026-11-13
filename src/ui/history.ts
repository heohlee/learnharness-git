/** History view (artboard 04-history): recent commits, each expandable to the files it touched. */
import type { PluginFrontendContext, PluginTreeRow } from "learnharness-plugin-api";
import { changeLabel, commitCells } from "../format.ts";
import type { Commit } from "../git.ts";
import type { State } from "../service.ts";
import { el, errorText, liveRefresh } from "./live.ts";

export function mountHistory(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal): void {
	const root = el("div", "lhgit");
	const note = el("p", "lhgit-note");
	const error = el("div", "lhgit-error");
	error.setAttribute("role", "alert");
	const list = el("div", "lhgit-files");
	root.append(note, error, list);
	container.append(root);

	let commits: Commit[] = [];
	/** The repository's configured user; commits by anyone else name their author. */
	let user: string | null = null;
	let generation = 0;
	const open = new Set<string>();

	const tree = ctx.ui.mountTree(
		list,
		{
			label: "Commit history",
			rows: [],
			columns: [
				{ key: "files", header: "Files", width: 70, align: "right" },
				{ key: "time", header: "Time", width: 130, align: "right" },
			],
		},
		{ signal },
	);

	const row = (commit: Commit, now: Date): PluginTreeRow => {
		const { files, time, author } = commitCells(commit, user, now);
		return {
			key: commit.hash,
			content: (cell) => {
				cell.append(el("code", "lhgit-hash", commit.shortHash), document.createTextNode(` ${commit.subject}`));
				if (author !== null) cell.append(el("span", "lhgit-author", ` · ${author}`));
			},
			cells: { files, time },
			disclosure: {
				label: `Show files changed in ${commit.shortHash}`,
				expanded: open.has(commit.hash),
				onChange: (value) => {
					if (value) open.add(commit.hash);
					else open.delete(commit.hash);
					render();
				},
			},
			children: commit.files.map((file) => ({
				key: `${commit.hash}:${file.path}`,
				content: file.from ? `${file.from} → ${file.path}` : file.path,
				cells: { files: el("span", "lhgit-code", file.code), time: changeLabel(file.code) },
			})),
		};
	};

	function render(): void {
		const now = new Date();
		tree.update({ rows: commits.map((commit) => row(commit, now)) });
		note.textContent = commits.length ? "" : "No commits yet.";
	}

	liveRefresh(ctx, signal, async (pushed) => {
		const mine = ++generation;
		try {
			const state = pushed ?? (await ctx.call<State>("state"));
			if (signal.aborted || mine !== generation || state.busy) return;
			if (state.repo.kind !== "repo") {
				commits = [];
				render();
				note.textContent =
					"The learning data folder is not a Git repository yet. Initialize it or clone a backup from the Git view.";
				return;
			}
			const [next, name] = await Promise.all([
				ctx.call<Commit[]>("log", { limit: 200 }),
				// Without a readable user name no row names an author.
				ctx.call<string | null>("userName").catch(() => null),
			]);
			if (signal.aborted || mine !== generation) return;
			commits = next;
			user = name;
			error.textContent = "";
			render();
		} catch (cause) {
			if (!signal.aborted && mine === generation) error.textContent = errorText(cause);
		}
	});
}
