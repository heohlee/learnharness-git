import assert from "node:assert/strict";
import type { GitResult, GitRunner } from "../src/git.ts";

export interface ScriptedCall {
	args: string[];
	result?: Partial<GitResult>;
}

/** Spawn fake for git: replays an ordered script and records every call. */
export function fakeGit(script: ScriptedCall[]) {
	const calls: { args: string[]; cwd: string }[] = [];
	const queue = [...script];
	const run: GitRunner = async (args, options) => {
		calls.push({ args: [...args], cwd: options.cwd });
		const next = queue.shift();
		if (!next) assert.fail(`unexpected git call: ${args.join(" ")}`);
		assert.deepEqual([...args], next.args);
		return { code: 0, stdout: "", stderr: "", ...next.result };
	};
	return {
		run,
		calls,
		/** Asserts the whole script was consumed. */
		done() {
			assert.deepEqual(
				queue.map((call) => call.args),
				[],
			);
		},
	};
}
