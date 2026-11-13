/** Backend entry: wires the system `git` binary, the settings file and host handlers. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { createGit, type GitRunner } from "./git.ts";
import { createService } from "./service.ts";
import { createFileSettingsStore } from "./settings.ts";

const TIMEOUT_MS = 5 * 60_000;

function systemGit(signal: AbortSignal): GitRunner {
	return (args, options) =>
		new Promise((resolve, reject) => {
			const child = spawn("git", args, {
				cwd: options.cwd,
				signal,
				stdio: ["ignore", "pipe", "pipe"],
				timeout: TIMEOUT_MS,
				windowsHide: true,
				// Never wait for a credential prompt nobody can answer.
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.on("error", (error: NodeJS.ErrnoException) => {
				reject(error.code === "ENOENT" ? new Error("Git is not installed or not on PATH.") : error);
			});
			child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
		});
}

export function activate(ctx: PluginBackendContext): void {
	const directory = fs.realpathSync(ctx.learning.directory);
	const service = createService({
		git: createGit(systemGit(ctx.signal), directory),
		store: createFileSettingsStore(ctx.dataDirectory),
		clock: { now: () => new Date(), setInterval, clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout) },
		emit: (topic, data) => {
			if (!ctx.signal.aborted) ctx.events.emit(topic, data);
		},
	});
	for (const [name, handler] of Object.entries(service.handlers)) ctx.handle(name, handler);
	ctx.cleanup(() => service.stop());
	void service.start();
}
