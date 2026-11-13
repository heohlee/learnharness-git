/** Main "Git" view (artboard 03-backup-dashboard): backup status first, then pending changes. History lives in Git History. */
import type { PluginFrontendContext, PluginTreeRow } from "learnharness-plugin-api";
import { backupDetails, backupHeadline, changeLabel, diffMarkdown } from "../format.ts";
import type { Commit, FileChange, Status } from "../git.ts";
import type { State } from "../service.ts";
import { el, errorText, HISTORY_VIEW, liveRefresh } from "./live.ts";

/** Only the last commit is needed: its date heads the status card. */
const RECENT = 1;

interface Snapshot {
	state: State;
	status: Status | null;
	recent: Commit[];
}

export function mountDashboard(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal): void {
	const options = { signal };
	const root = el("div", "lhgit lhgit-dashboard");

	// Status card: one headline, its supporting facts and the primary action.
	const card = el("section", "lhgit-card");
	card.setAttribute("aria-label", "Backup status");
	const summary = el("div", "lhgit-summary");
	const headline = el("h2", "lhgit-headline");
	// "Backed up …" opens Git History, the one place that lists commits.
	const headlineLink = el("button", "lhgit-headline-link");
	headlineLink.type = "button";
	headlineLink.title = "Open Git history";
	headlineLink.addEventListener("click", () => ctx.app.openView(HISTORY_VIEW), { signal });
	const details = el("p", "lhgit-note");
	summary.append(headline, details);
	const primary = el("div", "lhgit-primary");
	card.append(summary, primary);

	const error = el("div", "lhgit-error");
	error.setAttribute("role", "alert");

	// Pending changes: collapsible, secondary to the status.
	const pending = el("details", "lhgit-pending");
	pending.open = true;
	const pendingTitle = el("summary", "lhgit-section-title");
	const fileList = el("div", "lhgit-list");
	const commitRow = el("div", "lhgit-commit-row");
	const message = el("textarea", "lhgit-message");
	message.rows = 1;
	message.placeholder = "Optional message";
	message.setAttribute("aria-label", "Commit message");
	commitRow.append(message);
	pending.append(pendingTitle, fileList, commitRow);

	root.append(card, error, pending);
	container.append(root);

	let snapshot: Snapshot | null = null;
	let generation = 0;

	const run = async (operation: string, input?: unknown) => {
		error.textContent = "";
		try {
			return await ctx.call(operation, input);
		} catch (cause) {
			if (!signal.aborted) error.textContent = errorText(cause);
			return undefined;
		}
	};

	const syncButton = ctx.ui.mountButton(
		primary,
		{
			label: "Sync now",
			size: "lg",
			title: "Commit every change, then pull and push",
			onClick: () => void run("sync"),
		},
		options,
	);
	const initButton = ctx.ui.mountButton(
		primary,
		{ label: "Initialize repository", size: "lg", onClick: () => void run("init") },
		options,
	);
	const commitButton = ctx.ui.mountButton(
		commitRow,
		{
			label: "Commit all",
			variant: "outline",
			onClick: async () => {
				const all = (snapshot?.status?.staged.length ?? 0) === 0;
				const result = (await run("commit", { message: message.value, all })) as { committed: boolean } | undefined;
				if (result?.committed) message.value = "";
				else if (result) error.textContent = "Nothing to commit.";
			},
		},
		options,
	);

	const showDiff = async (file: FileChange, staged: boolean) => {
		const diff = await run("diff", { path: file.path, staged, untracked: file.code === "?" });
		if (typeof diff !== "string" || signal.aborted) return;
		ctx.ui.openDialog(
			{
				title: file.path,
				content: (body, dialogSignal) => {
					ctx.ui.mountMarkdown(body, { text: diffMarkdown(diff) }, { signal: dialogSignal });
				},
			},
			options,
		);
	};

	const fileName = (file: FileChange, staged: boolean): HTMLElement => {
		const button = el("button", "lhgit-file");
		button.type = "button";
		button.title = `Show changes in ${file.path}`;
		const slash = file.path.lastIndexOf("/");
		button.append(
			el("span", "", file.path.slice(slash + 1)),
			el("span", "lhgit-dir", ` ${file.from ? `from ${file.from}` : file.path.slice(0, slash + 1)}`),
		);
		if (staged) button.append(el("span", "lhgit-staged", " staged"));
		button.addEventListener("click", () => void showDiff(file, staged), { signal });
		return button;
	};

	const fileRow = (file: FileChange, staged: boolean): PluginTreeRow => {
		const code = file.code === "?" ? "U" : file.code;
		const codeCell = el("span", `lhgit-code lhgit-code-${file.code === "?" ? "untracked" : file.code}`, code);
		codeCell.title = changeLabel(file.code);
		codeCell.setAttribute("aria-label", changeLabel(file.code));
		const verb = staged ? "Unstage" : "Stage";
		return {
			key: `${staged ? "s" : "u"}:${file.path}`,
			content: fileName(file, staged),
			cells: {
				code: codeCell,
				action: (cell, cellSignal) => {
					ctx.ui.mountButton(
						cell,
						{
							label: `${verb} ${file.path}`,
							title: verb,
							icon: staged ? "−" : "+",
							iconOnly: true,
							size: "icon-xs",
							variant: "ghost",
							onClick: () => void run(staged ? "unstage" : "stage", { paths: [file.path] }),
						},
						{ signal: cellSignal },
					);
				},
			},
		};
	};

	const files = ctx.ui.mountTree(
		fileList,
		{
			label: "Pending changes",
			rows: [],
			columns: [
				{ key: "code", header: "", width: 24, align: "right" },
				{ key: "action", header: "", width: 36, align: "right" },
			],
		},
		options,
	);

	function render(): void {
		if (!snapshot) return;
		const { state, status, recent } = snapshot;
		const now = new Date();
		const repo = state.repo.kind === "repo";
		const changes = status ? [...status.staged, ...status.unstaged] : [];

		const lastCommit = recent[0]?.date ?? null;
		const title = backupHeadline({ repo, lastCommit, busy: state.busy, paused: state.paused }, now);
		// Only the "Backed up …" headline links to the history; busy, paused and setup states stay plain text.
		const linked = repo && lastCommit !== null && !state.busy && !state.paused;
		if (linked) {
			headlineLink.textContent = title;
			if (headlineLink.parentNode !== headline) headline.replaceChildren(headlineLink);
		} else headline.textContent = title;
		if (!repo) {
			details.textContent =
				state.repo.kind === "nested"
					? `The learning data is inside another Git repository (${state.repo.topLevel}). Initialize a separate repository to back it up.`
					: "The learning data folder is not a Git repository yet. Initialize one to start backing it up.";
		} else if (state.paused) {
			details.textContent = `${state.lastError ?? ""} Sync now retries after you resolve it.`.trim();
		} else {
			const parts = backupDetails({ changes: changes.length, nextSync: state.nextSync, status }, now);
			details.replaceChildren(
				...parts.flatMap((part, index) => {
					const node = index === 2 ? el("strong", "lhgit-branch", part) : document.createTextNode(part);
					return index ? [document.createTextNode(" · "), node] : [node];
				}),
			);
		}
		if (state.lastError && !state.paused && !error.textContent) error.textContent = state.lastError;

		syncButton.update({ disabled: !repo || state.busy !== null });
		initButton.update({ disabled: state.busy !== null });
		primary.dataset.mode = repo ? "sync" : "init";
		pending.hidden = !repo;
		if (!repo) return;

		pendingTitle.textContent = `Pending changes (${changes.length})`;
		files.update({
			rows: [
				...(status?.staged ?? []).map((file) => fileRow(file, true)),
				...(status?.unstaged ?? []).map((file) => fileRow(file, false)),
			],
		});
		const stagedCount = status?.staged.length ?? 0;
		commitButton.update({
			label: stagedCount ? `Commit staged (${stagedCount})` : "Commit all",
			disabled: changes.length === 0 || state.busy !== null,
		});
	}

	liveRefresh(ctx, signal, async (pushed) => {
		const mine = ++generation;
		try {
			const state = pushed ?? (await ctx.call<State>("state"));
			if (signal.aborted || mine !== generation) return;
			// While git runs, show the busy state with the last known lists.
			if (state.busy || state.repo.kind !== "repo") {
				snapshot = { state, status: state.busy ? (snapshot?.status ?? null) : null, recent: snapshot?.recent ?? [] };
				render();
				return;
			}
			const [status, recent] = await Promise.all([
				ctx.call<Status>("status"),
				ctx.call<Commit[]>("log", { limit: RECENT }),
			]);
			if (signal.aborted || mine !== generation) return;
			snapshot = { state, status, recent };
			render();
		} catch (cause) {
			if (!signal.aborted && mine === generation) error.textContent = errorText(cause);
		}
	});

	// Keep "4 minutes ago" and "next sync in 6 min" truthful while the view stays open.
	const clock = setInterval(render, 30_000);
	signal.addEventListener("abort", () => clearInterval(clock), { once: true });
}
