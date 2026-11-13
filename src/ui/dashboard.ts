/** Main "Git" view (artboard 03-backup-dashboard): backup status first, then pending changes. History lives in Git History. */
import type { PluginFrontendContext, PluginTreeRow } from "learnharness-plugin-api";
import {
	backupDetails,
	backupHeadline,
	CONFLICT_DIFF_LEGEND,
	changeLabel,
	cloneDetails,
	conflictHeadline,
	conflictMessage,
	diffMarkdown,
	filesLeft,
	keptLabel,
	resolvedNotice,
	visibleError,
} from "../format.ts";
import type { Commit, FileChange, Side, Status } from "../git.ts";
import type { State } from "../service.ts";
import { openCloneDialog } from "./clone.ts";
import { el, errorText, HISTORY_VIEW, liveRefresh, showError } from "./live.ts";

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

	// Notice after an automatic resolution (artboard 04): one line, backup folder, Details, Dismiss.
	const notice = el("section", "lhgit-notice-block");
	const noticeRow = el("div", "lhgit-notice");
	noticeRow.setAttribute("role", "status");
	const noticeText = el("div", "lhgit-notice-text");
	const noticeTitle = el("strong", "");
	const noticeBackup = el("div", "lhgit-note");
	noticeText.append(noticeTitle, noticeBackup);
	const noticeActions = el("div", "");
	noticeRow.append(noticeText, noticeActions);
	const noticeDetails = el("details", "lhgit-resolution");
	const noticeSummary = el("summary", "lhgit-note", "Details");
	const resolvedList = el("div", "lhgit-list");
	noticeDetails.append(noticeSummary, resolvedList);
	notice.append(noticeRow, noticeDetails);

	// Conflict screen (artboard 05): a version per file, then resolve and sync.
	const conflicts = el("section", "lhgit-conflicts");
	conflicts.setAttribute("aria-label", "Conflicted files");
	const conflictList = el("div", "lhgit-list");
	const bulk = el("div", "lhgit-buttons");
	const conflictActions = el("div", "lhgit-buttons");
	const conflictReason = el("p", "lhgit-note");
	// Why a chosen version was rejected: one line per file, under the list.
	const conflictNotes = el("div", "lhgit-error");
	conflictNotes.setAttribute("role", "status");
	conflicts.append(conflictList, conflictNotes, bulk, conflictActions, conflictReason);

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

	root.append(card, error, notice, conflicts, pending);
	container.append(root);

	let snapshot: Snapshot | null = null;
	let generation = 0;
	/** The user's version per conflicted file; kept across refreshes until resolved. */
	const choices = new Map<string, Side>();
	/** "Later" hides the conflict screen for this list of files. */
	let laterFor: string | null = null;
	/** The failure of the user's last action in this view; null once an action succeeds. */
	let localError: string | null = null;
	/** The failure of the last refresh; null once a refresh succeeds. */
	let refreshError: string | null = null;
	let shownError: string | null = null;

	/** The error box has one source of truth: `visibleError` over the local failure and the latest state. */
	const updateError = () => {
		const state = snapshot?.state;
		const message = visibleError({
			localError: localError ?? refreshError,
			lastError: state?.lastError ?? null,
			busy: state?.busy ?? null,
			paused: state?.paused ?? false,
		});
		if (message === shownError) return;
		shownError = message;
		if (message === null) error.textContent = "";
		else showError(error, new Error(message));
	};

	const run = async (operation: string, input?: unknown) => {
		localError = null;
		updateError();
		try {
			return await ctx.call(operation, input);
		} catch (cause) {
			if (signal.aborted) return undefined;
			localError = errorText(cause);
			updateError();
			return undefined;
		}
	};
	const slot = () => {
		const node = el("span", "lhgit-slot");
		primary.append(node);
		return node;
	};
	const syncSlot = slot();
	const resolveSlot = slot();
	const initSlot = slot();
	const cloneSlot = slot();

	const syncButton = ctx.ui.mountButton(
		syncSlot,
		{ label: "Sync now", size: "lg", title: "Commit, pull and push", onClick: () => void run("sync") },
		options,
	);
	const resolveButton = ctx.ui.mountButton(
		resolveSlot,
		{
			label: "Resolve",
			size: "lg",
			variant: "outline",
			onClick: () => {
				laterFor = null;
				render();
			},
		},
		options,
	);
	const initButton = ctx.ui.mountButton(
		initSlot,
		{ label: "Initialize repository", size: "lg", onClick: () => void run("init") },
		options,
	);
	const cloneButton = ctx.ui.mountButton(
		cloneSlot,
		{
			label: "Clone from remote",
			size: "lg",
			variant: "outline",
			title: "Clone an existing backup repository",
			onClick: () => openCloneDialog(ctx, signal),
		},
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
				else if (result) {
					localError = "Nothing to commit.";
					updateError();
				}
			},
		},
		options,
	);

	/** The dialog has no visible host title: the file path heads the content, then the legend if any. */
	const openDiff = (title: string, diff: unknown, legend?: string) => {
		if (typeof diff !== "string" || signal.aborted) return;
		ctx.ui.openDialog(
			{
				title,
				content: (body, dialogSignal) => {
					body.append(el("h2", "lhgit-dialog-title lhgit-path", title));
					if (legend) body.append(el("p", "lhgit-note lhgit-legend", legend));
					const text = el("div", "");
					body.append(text);
					ctx.ui.mountMarkdown(text, { text: diffMarkdown(diff) }, { signal: dialogSignal });
				},
			},
			options,
		);
	};
	const showDiff = async (file: FileChange, staged: boolean) => {
		openDiff(file.path, await run("diff", { path: file.path, staged, untracked: file.code === "?" }));
	};

	ctx.ui.mountButton(
		noticeActions,
		{ label: "Dismiss", variant: "ghost", onClick: () => void run("dismissResolution") },
		options,
	);
	const resolved = ctx.ui.mountTree(
		resolvedList,
		{
			label: "Resolved files",
			rows: [],
			columns: [
				{ key: "kept", header: "Kept", width: 80 },
				{ key: "rule", header: "Rule", width: 140 },
			],
		},
		options,
	);

	const pendingFiles = () => snapshot?.state.pendingConflicts?.files.map((file) => file.path) ?? [];
	const choose = (paths: readonly string[], side: Side) => {
		for (const file of paths) choices.set(file, side);
		render();
	};
	const conflictRow = (file: string): PluginTreeRow => ({
		key: file,
		content: el("span", "lhgit-hash lhgit-path", file),
		cells: {
			diff: (cell, cellSignal) => {
				ctx.ui.mountButton(
					cell,
					{
						label: "Diff",
						variant: "ghost",
						size: "sm",
						title: `Local and remote versions of ${file}`,
						onClick: async () => openDiff(file, await run("conflictDiff", { path: file }), CONFLICT_DIFF_LEGEND),
					},
					{ signal: cellSignal },
				);
			},
			choice: (cell, cellSignal) => {
				const group = el("div", "lhgit-segment");
				group.setAttribute("role", "group");
				group.setAttribute("aria-label", `Version of ${file}`);
				cell.append(group);
				for (const [side, label] of [
					["local", "Local"],
					["remote", "Remote"],
				] as const) {
					ctx.ui.mountButton(
						group,
						{
							label,
							size: "sm",
							variant: choices.get(file) === side ? "default" : "outline",
							title: choices.get(file) === side ? `${label} version chosen` : `Keep the ${label.toLowerCase()} version`,
							onClick: () => choose([file], side),
						},
						{ signal: cellSignal },
					);
				}
			},
		},
	});
	const conflictTree = ctx.ui.mountTree(
		conflictList,
		{
			label: "Conflicted files",
			rows: [],
			columns: [
				{ key: "diff", header: "", width: 64, align: "right" },
				{ key: "choice", header: "", width: 160, align: "right" },
			],
		},
		options,
	);
	ctx.ui.mountButton(
		bulk,
		{ label: "Use all local", variant: "outline", size: "sm", onClick: () => choose(pendingFiles(), "local") },
		options,
	);
	ctx.ui.mountButton(
		bulk,
		{ label: "Use all remote", variant: "outline", size: "sm", onClick: () => choose(pendingFiles(), "remote") },
		options,
	);
	const resolveAndSync = ctx.ui.mountButton(
		conflictActions,
		{
			label: "Resolve and sync",
			onClick: async () => {
				const chosen = Object.fromEntries(pendingFiles().map((file) => [file, choices.get(file)]));
				const result = await run("resolveConflicts", { choices: chosen });
				if (result !== undefined) choices.clear();
			},
		},
		options,
	);
	ctx.ui.mountButton(
		conflictActions,
		{
			label: "Later",
			variant: "outline",
			onClick: () => {
				laterFor = pendingFiles().join("\0");
				render();
			},
		},
		options,
	);

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

		const conflicted = (state.pendingConflicts?.files ?? []).map((file) => file.path);
		for (const file of choices.keys()) if (!conflicted.includes(file)) choices.delete(file);
		const choosing = repo && conflicted.length > 0 && !state.restartRequired && laterFor !== conflicted.join("\0");

		const lastCommit = recent[0]?.date ?? null;
		const title = choosing
			? conflictHeadline(conflicted.length)
			: backupHeadline(
					{
						repo,
						lastCommit,
						busy: state.busy,
						paused: state.paused,
						conflicts: conflicted.length,
						restartRequired: state.restartRequired,
						cloneBranch: state.cloneBranch,
					},
					now,
				);
		// Only the "Backed up …" headline links to the history; busy, paused and setup states stay plain text.
		const linked = repo && lastCommit !== null && !choosing && !state.busy && !state.paused && !state.restartRequired;
		if (linked) {
			headlineLink.textContent = title;
			if (headlineLink.parentNode !== headline) headline.replaceChildren(headlineLink);
		} else headline.textContent = title;
		card.classList.toggle("lhgit-alert", state.paused && !state.restartRequired);
		if (state.restartRequired) {
			details.textContent = cloneDetails(state.cloneBackupDir);
		} else if (!repo) {
			details.textContent =
				state.repo.kind === "nested" ? `Inside another repository (${state.repo.topLevel}).` : "No Git repository yet.";
		} else if (choosing) {
			details.textContent = "Pick a version for each file.";
		} else if (state.paused) {
			details.textContent = state.pendingConflicts
				? conflictMessage(state.pendingConflicts.upstream)
				: (state.lastError ?? "");
		} else {
			const parts = backupDetails({ changes: changes.length, nextSync: state.nextSync, status }, now);
			details.replaceChildren(
				...parts.flatMap((part, index) => {
					const node = index === 2 ? el("strong", "lhgit-branch", part) : document.createTextNode(part);
					return index ? [document.createTextNode(" · "), node] : [node];
				}),
			);
		}
		updateError();

		syncButton.update({ disabled: !repo || state.busy !== null });
		resolveButton.update({ disabled: state.busy !== null });
		initButton.update({ disabled: state.busy !== null });
		cloneButton.update({ disabled: state.busy !== null });
		syncSlot.hidden = !repo || choosing;
		resolveSlot.hidden = !repo || choosing || conflicted.length === 0;
		initSlot.hidden = repo;
		cloneSlot.hidden = repo;
		pending.hidden = !repo;

		// The conflict screen replaces the previous resolution notice until it closes.
		const resolution = repo && !choosing ? state.lastResolution : null;
		notice.hidden = resolution === null;
		if (resolution) {
			noticeTitle.textContent = resolvedNotice(resolution.files);
			noticeBackup.replaceChildren();
			if (resolution.backupDir) {
				noticeBackup.append("Previous versions in ", el("code", "lhgit-hash", resolution.backupDir));
			}
			resolved.update({
				rows: resolution.files.map((file) => ({
					key: file.path,
					content: el("span", "lhgit-hash lhgit-path", file.path),
					cells: { kept: keptLabel(file.kept), rule: file.rule },
				})),
			});
		}

		conflicts.hidden = !choosing;
		if (choosing) {
			conflictTree.update({ rows: conflicted.map(conflictRow) });
			conflictNotes.textContent = (state.pendingConflicts?.notes ?? []).join("\n");
			const left = conflicted.filter((file) => !choices.has(file)).length;
			resolveAndSync.update({ disabled: left > 0 || state.busy !== null });
			conflictReason.textContent = left > 0 ? filesLeft(left) : "";
		}
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
			refreshError = null;
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
			if (signal.aborted || mine !== generation) return;
			refreshError = errorText(cause);
			updateError();
		}
	});

	// Keep "4 minutes ago" and "next sync in 6 min" truthful while the view stays open.
	const clock = setInterval(render, 30_000);
	signal.addEventListener("abort", () => clearInterval(clock), { once: true });
}
