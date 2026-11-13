/** Remote URL settings row: preview what would be pushed, confirm, then connect and push. */
import type { PluginFrontendContext, PluginSettingsRow } from "learnharness-plugin-api";
import { plural } from "../format.ts";
import type { State } from "../service.ts";
import { el } from "./live.ts";

interface Preview {
	url: string;
	files: number;
	sensitive: string[];
}

/** Shows what connecting would publish; resolves true only on an explicit "Connect and push". */
function confirmPush(ctx: PluginFrontendContext, preview: Preview): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			resolve(value);
			dialog.dispose();
		};
		const dialog = ctx.ui.openDialog(
			{
				title: "Connect remote and push",
				onClose: () => finish(false),
				content: (body, signal) => {
					const root = el("div", "lhgit-confirm");
					root.append(
						el(
							"p",
							"",
							`Commits pending changes and pushes ${plural(preview.files, "file")} to ${preview.url}. Anyone with access can read them.`,
						),
					);
					if (preview.sensitive.length) {
						root.append(
							el(
								"p",
								"lhgit-warning",
								"May contain private settings or keys. Already committed files are pushed anyway, even if now in .gitignore:",
							),
						);
						const list = el("ul", "lhgit-sensitive");
						for (const file of preview.sensitive) list.append(el("li", "lhgit-hash", file));
						root.append(list);
					}
					const buttons = el("div", "lhgit-buttons");
					root.append(buttons);
					body.append(root);
					ctx.ui.mountButton(buttons, { label: "Connect and push", onClick: () => finish(true) }, { signal });
					ctx.ui.mountButton(
						buttons,
						{ label: "Cancel", variant: "outline", onClick: () => finish(false) },
						{ signal },
					);
				},
			},
			{ signal: ctx.signal },
		);
	});
}

export function remoteRow(
	ctx: PluginFrontendContext,
	state: State | null,
	accepted: (state: State) => void,
): PluginSettingsRow {
	const ready = state?.repo.kind === "repo";
	return {
		type: "text",
		key: "remote",
		label: "Remote URL",
		description: ready
			? "Empty repository, e.g. git@github.com:you/learning-data.git. Saving sets origin and pushes after you confirm. No tokens in the URL."
			: "Initialize the repository in the Git view first.",
		value: state?.remote ?? "",
		disabled: !ready,
		validate: (value) => (value.trim() ? undefined : "Enter a Git remote URL."),
		onChange: async (value) => {
			try {
				const preview = await ctx.call<Preview>("previewRemote", { url: value });
				if (await confirmPush(ctx, preview)) await ctx.call("connectRemote", { url: preview.url });
			} finally {
				// Show what git now has: the new URL, or the previous one after Cancel or an error.
				accepted(await ctx.call<State>("state"));
			}
		},
	};
}
