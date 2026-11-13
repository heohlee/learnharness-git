/** Shared view plumbing: backend state subscription scoped to a mount signal. */
import type { PluginFrontendContext } from "learnharness-plugin-api";
import { authHint } from "../format.ts";
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

/** Writes an error into `target`; an authentication failure becomes its fixes, one per line (artboard 03). */
export function showError(target: HTMLElement, error: unknown): void {
	const message = errorText(error);
	const hint = authHint(message);
	if (!hint) {
		target.textContent = message;
		return;
	}
	const steps = el("ol", "lhgit-steps");
	const step = (label: string, command: string) => {
		const item = el("li", "");
		item.append(el("strong", "", label), el("code", "lhgit-cmd", command));
		steps.append(item);
	};
	step("gh (HTTPS)", hint.gh);
	if (hint.ssh) step("SSH", hint.ssh);
	const box = el("div", "lhgit-auth");
	box.append(el("strong", "lhgit-auth-title", hint.headline), el("p", "lhgit-note", hint.sub), steps);
	target.replaceChildren(box);
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
