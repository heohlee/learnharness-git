/** "Clone from remote" dialog: asks for the backup repository URL and clones it into the learning data folder. */
import type { PluginFrontendContext } from "learnharness-plugin-api";
import { el, errorText } from "./live.ts";

export function openCloneDialog(ctx: PluginFrontendContext, signal: AbortSignal): void {
	const dialog = ctx.ui.openDialog(
		{
			title: "Clone from remote",
			content: (body, dialogSignal) => {
				const root = el("div", "lhgit-confirm");
				const field = el("label", "lhgit-field");
				// SSH remotes such as git@github.com:you/data.git are not valid type="url" values.
				const input = el("input", "lhgit-message");
				input.type = "text";
				input.inputMode = "url";
				input.spellcheck = false;
				input.autocomplete = "off";
				input.placeholder = "git@github.com:you/learning-data.git";
				field.append(el("span", "", "Remote URL"), input);
				const error = el("div", "lhgit-error");
				error.setAttribute("role", "alert");
				const buttons = el("div", "lhgit-buttons");
				root.append(
					el("h2", "lhgit-section-title", "Clone from remote"),
					el(
						"p",
						"",
						"Use this on a new computer to bring your learning data from an existing backup repository. Files LearnHarness already created here that the backup also has are moved to .learnharness-git-backup/ first. Restart LearnHarness when it finishes.",
					),
					field,
					error,
					buttons,
				);
				body.append(root);

				let running = false;
				const clone = async () => {
					if (running) return;
					running = true;
					error.textContent = "";
					cloneButton.update({ disabled: true });
					try {
						await ctx.call("clone", { url: input.value });
						dialog.dispose();
					} catch (cause) {
						if (!dialogSignal.aborted) error.textContent = errorText(cause);
					} finally {
						running = false;
						if (!dialogSignal.aborted) cloneButton.update({ disabled: false });
					}
				};
				const cloneButton = ctx.ui.mountButton(
					buttons,
					{ label: "Clone", onClick: () => clone() },
					{ signal: dialogSignal },
				);
				ctx.ui.mountButton(
					buttons,
					{ label: "Cancel", variant: "outline", onClick: () => dialog.dispose() },
					{ signal: dialogSignal },
				);
				input.addEventListener(
					"keydown",
					(event) => {
						if (event.key === "Enter") void clone();
					},
					{ signal: dialogSignal },
				);
				input.focus();
			},
		},
		{ signal },
	);
}
