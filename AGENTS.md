# AGENTS.md

learnharness-git is a LearnHarness community plugin that versions the learning-data directory with the system `git` (commit, pull, push, sync, Source Control and History views). License: AGPL-3.0-only.

## Layout

- `src/`: plugin code. `main.ts` is the frontend entry (views, actions, settings), `backend.ts` the Node backend entry (git process runner, scheduler); the rest is shared logic (`git.ts`, `service.ts`, `conflicts.ts`, `clone.ts`, `settings.ts`, `format.ts`).
- `src/ui/`: views and dialogs.
- `tests/`: `node:test` tests (`*.test.ts`), with `fake-git.ts` instead of the real `git`.
- `scripts/`: build, package and local install.
- `.sdk/`: vendored LearnHarness plugin API types (`learnharness-plugin-api`). Do not edit by hand.

## Commands

```sh
npm ci                  # install
npm test                # tests
npm run coverage        # tests with the 85% line, branch and function minimum
npm run typecheck       # tsc --noEmit
npm run lint            # biome ci (lint and format check)
npm run lint:fix        # apply Biome fixes and formatting
npm run build           # dist/
npm run package         # releases/learnharness-git-<version>.zip
npm run install:local -- "<plugins folder>"   # build and install into a LearnHarness plugins folder
```

`.github/workflows/` is the source of truth for the checks; `CONTRIBUTING.md` lists them.

## Rules

- Tests follow `.agents/skills/node-tests/SKILL.md`: never run real external programs (no real `git`, network or app) in tests; use the fakes.
- User-visible messages use style B: short, in Git terms (commit, pull, push, remote, merge conflict).
- Never write conflict markers into JSON files; abort the merge instead and leave the files unchanged.
- The plugin never runs `git init` on its own; only an explicit user action initializes (which adds the default `.gitignore` and `.gitattributes` when missing) or clones.
- Never commit learning data, tokens, credentials or personal data in code, fixtures, issues, PRs or logs.
- Working notes (plans, task logs, scratch) stay out of git.

## Skills

The `.agents/skills/` kit skills are the source for these rules; read them instead of restating them:

- `git-workflow` (`.agents/skills/git-workflow/SKILL.md`): issues (optional), labels, branches, one worktree per change under `../learnharness-git-worktrees/`, PR body, required checks, merge.
- `release-notes`: release notes and how releases are published.
- `node-tests`: test rules and coverage gates.
