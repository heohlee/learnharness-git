/** Shared view plumbing: backend state subscription scoped to a mount signal. */
import type { PluginFrontendContext } from "learnharness-plugin-api";
import type { State } from "../service.ts";

export const DASHBOARD_VIEW = "dashboard";
export const HISTORY_VIEW = "history";

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Calls `refresh` now, after every finished backend operation, after a resync and
 * (debounced) after app activity that may have written learning data.
 * Every subscription ends with `signal`.
 */
export function liveRefresh(
	ctx: PluginFrontendContext,
	signal: AbortSignal,
	refresh: (state: State | null) => void,
): void {
	let debounce: ReturnType<typeof setTimeout> | undefined;
	const offs = [
		ctx.onNotification((event) => {
			if (event.topic !== "state") return;
			const state = event.data as State;
			refresh(state);
		}),
		ctx.onResync(() => refresh(null)),
		ctx.onAppEvent(() => {
			clearTimeout(debounce);
			debounce = setTimeout(() => refresh(null), 2000);
		}),
	];
	signal.addEventListener(
		"abort",
		() => {
			clearTimeout(debounce);
			for (const off of offs) off();
		},
		{ once: true },
	);
	refresh(null);
}
