# Contributing to learnharness-git

Pull requests are welcome without an issue: opening one first is optional. For large or design-changing work, an [issue](https://github.com/heohlee/learnharness-git/issues/new/choose) lets us agree on the idea before you write code. The full rule and the label taxonomy are in [git-workflow](.agents/skills/git-workflow/SKILL.md).

Repository rules for agents and humans start at [AGENTS.md](AGENTS.md) and its skill index.

## Quick path

1. Optional: find or create an [issue](https://github.com/heohlee/learnharness-git/issues/new/choose) describing the motivation and acceptance criteria, especially for large changes. Use the bug report or feature request form; for documentation, chores, CI and tooling, use `gh issue create`.
2. Create a worktree and a branch from `main` named `type/slug` (see below).
3. Implement the scoped change with tests and relevant documentation.
4. Run the checks below and open a PR using the [PR template](.github/PULL_REQUEST_TEMPLATE.md).
5. If the PR resolves an issue, include a standalone closing line in the PR body, replacing the example number with your issue:

   ```text
   Closes #123
   ```

## Branches and worktrees

Branches are named `type/slug`, lowercase, for example `fix/conflict-notice` or `docs/install-steps`. Supported prefixes are `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci` and `perf`.

Each change lives in its own git worktree under `../learnharness-git-worktrees/`, so several changes can run in parallel without sharing state:

```sh
git fetch origin
git worktree add --track -b fix/conflict-notice ../learnharness-git-worktrees/fix-conflict-notice origin/main
```

Run `npm ci` once in each new worktree. [git-workflow](.agents/skills/git-workflow/SKILL.md) lists the isolation rules.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/), such as `fix: show the backup folder in the conflict notice` or `ci(release): require release notes`. Keep commits focused.

## Local checks

Node.js 24 or newer (`engines` in `package.json`) and npm. These are the commands the `CI` workflow ([ci.yml](.github/workflows/ci.yml)) runs:

```sh
npm ci                # install from package-lock.json
npm run coverage      # every test, failing below 85% line, branch or function coverage
npm run typecheck     # TypeScript type check
npm run lint          # Biome lint and format check (npm run lint:fix applies the fixes)
npm pack --dry-run    # package contents
npm run package       # builds releases/learnharness-git-<version>.zip, the prebuilt package
```

### Security checks

[security.yml](.github/workflows/security.yml) runs CodeQL and `npm audit --audit-level=high` on pull requests, on `main` and weekly. These checks are not required for merge, but their failures get fixed or explained in the PR.

The workflows in `.github/workflows/` are the source of truth for every check.

## Pull requests and merging

- Follow the PR template: Why, Summary, Verification, Not verified, and `Closes #<number>` when an issue exists.
- Report checks actually run and explicitly list anything not verified.
- Keep the change focused; when it has an issue, update the issue if scope changes.
- Wait for all required checks to be green, including on documentation-only PRs. Local results are not proof that remote checks passed.
- Merge with a merge commit (`gh pr merge --merge`) once the required `CI` check passes.
- Never put learning data, tokens, credentials or remote URLs with secrets in code, test fixtures, issues, PRs or logs.

[git-workflow](.agents/skills/git-workflow/SKILL.md) holds the full PR rules.

## Releases

1. Run `npm version X.Y.Z --no-git-tag-version` (updates `package.json` and `package-lock.json`) and set the same `version` in `manifest.json`.
2. Write the release notes with the [release-notes](.agents/skills/release-notes/SKILL.md) skill and save them as `.github/release-notes/vX.Y.Z.md`.
3. Merge those changes into `main`, then tag that commit `vX.Y.Z` and push the tag.
4. [release.yml](.github/workflows/release.yml) checks that the tag matches the `package.json` version and that the notes file exists and is not empty, runs the tests, type check, lint and `npm pack --dry-run`, then creates the GitHub release from the notes file. The package is not published to npm.
5. [release-package.yml](.github/workflows/release-package.yml) runs when the release is published: it checks the tag against `package.json` and `manifest.json`, builds `learnharness-git-X.Y.Z.zip` and attaches it to the release (the prebuilt package in the README).
