/** Frontend entry: views, actions with keyboard shortcuts and the settings page. */
import type { PluginFrontendContext, PluginSettingsRow } from "learnharness-plugin-api";
import type { State } from "./service.ts";
import { mountDashboard } from "./ui/dashboard.ts";
import { mountHistory } from "./ui/history.ts";
import { DASHBOARD_VIEW, HISTORY_VIEW } from "./ui/live.ts";
import { remoteRow } from "./ui/remote.ts";

const ICON =
	'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10c0 4-6 3-10 6"/></svg>';

export function activate(ctx: PluginFrontendContext): void {
	ctx.registerView({ id: DASHBOARD_VIEW, name: "Git", mount: (c, s) => mountDashboard(ctx, c, s) });
	ctx.registerView({ id: HISTORY_VIEW, name: "Git History", mount: (c, s) => mountHistory(ctx, c, s) });

	const operation = (id: string, name: string, op: string, input: unknown, defaultBinding?: string) => {
		ctx.registerAction({
			id,
			name,
			shortcut: { scope: "app", ...(defaultBinding ? { defaultBinding } : {}) },
			run: async () => {
				await ctx.call(op, input);
			},
		});
	};
	operation("commit-all", "Git: Commit all changes", "commit", { all: true }, "mod+alt+c");
	operation("sync", "Git: Commit, pull and push", "sync", undefined, "mod+alt+s");
	operation("pull", "Git: Pull", "pull", undefined, "mod+alt+l");
	operation("push", "Git: Push", "push", undefined, "mod+alt+p");
	operation("init", "Git: Initialize repository", "init", undefined);
	ctx.registerAction({
		id: "open-dashboard",
		name: "Git",
		icon: ICON,
		shortcut: { scope: "app", defaultBinding: "mod+alt+g" },
		run: () => ctx.app.openView(DASHBOARD_VIEW),
	});
	ctx.registerAction({
		id: "open-history",
		name: "Git history",
		shortcut: { scope: "app" },
		run: () => ctx.app.openView(HISTORY_VIEW),
	});
	ctx.placeAction({ id: "sidebar-dashboard", actionId: "open-dashboard", location: "sidebar" });
	ctx.placeAction({
		id: "dashboard-history",
		actionId: "open-history",
		location: "top-bar",
		views: [DASHBOARD_VIEW],
	});
	ctx.placeAction({
		id: "history-dashboard",
		actionId: "open-dashboard",
		location: "top-bar",
		views: [HISTORY_VIEW],
	});

	registerSettings(ctx);
}

function registerSettings(ctx: PluginFrontendContext): void {
	let current: State | null = null;
	let settings: State["settings"] | null = null;
	const accept = (state: State) => {
		current = state;
		settings = state.settings;
		handle.update({ rows: rows() });
	};
	const save = (key: string) => async (value: unknown) => {
		accept(await ctx.call<State>("saveSettings", { [key]: value }));
	};
	const rows = (): PluginSettingsRow[] => {
		const s = settings;
		const disabled = s === null;
		return [
			{
				type: "number",
				key: "autoSyncMinutes",
				label: "Auto sync interval (minutes)",
				description: "Commit every change every N minutes. 0 turns automatic sync off.",
				value: s?.autoSyncMinutes ?? 0,
				min: 0,
				max: 1440,
				step: 1,
				disabled,
				validate: (v) =>
					Number.isInteger(v) && v >= 0 && v <= 1440 ? undefined : "Use a whole number between 0 and 1440.",
				onChange: save("autoSyncMinutes"),
			},
			{
				type: "toggle",
				key: "autoPush",
				label: "Pull and push after each automatic commit",
				description: "Needs an upstream branch. A merge conflict aborts the pull and pauses automatic sync.",
				value: s?.autoPush ?? false,
				disabled,
				onChange: save("autoPush"),
			},
			{
				type: "toggle",
				key: "pullOnStart",
				label: "Pull when LearnHarness starts",
				value: s?.pullOnStart ?? false,
				disabled,
				onChange: save("pullOnStart"),
			},
			{
				type: "text",
				key: "commitMessage",
				label: "Commit message template",
				description:
					"Used for automatic commits and when the message box is empty. {{date}} becomes the local date and time.",
				value: s?.commitMessage ?? "",
				disabled,
				validate: (v) => (v.trim() ? undefined : "The template must not be empty."),
				onChange: save("commitMessage"),
			},
			remoteRow(ctx, current, accept),
		];
	};
	const handle = ctx.registerSettings({ rows: rows() });
	const load = () =>
		ctx
			.call<State>("state")
			.then((state) => {
				if (!ctx.signal.aborted) accept(state);
			})
			.catch(() => {});
	ctx.cleanup(ctx.onResync(load));
	void load();
}
