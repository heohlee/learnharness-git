---
name: pr-governance
description: "Trigger: creating, preparing, or reviewing a pull request in this repository. Apply learnharness-git's issue linkage, branch naming, PR template, CI gates and merge policy."
license: MIT
metadata:
  author: "heohlee"
  version: "1.0"
---

## Activation Contract

Use when a learnharness-git change is about to be pushed for a pull request, needs a PR created or edited, or is being checked for review readiness.

Do not use for read-only Q&A or local work that will not become a PR. Loading this skill does not authorize pushing, opening a PR or merging.

## Precedence

Generic PR, branch or issue skills installed in your agent (for example `branch-pr`) describe other repositories and do not apply here. Follow this project skill rather than importing checks from another repository, and do not reconcile the two.

## Hard Rules

- When a governing issue exists, link it with a standalone `Closes #<n>` line. The issue is optional (`issue-governance`) and no check requires the line; a missing issue or link never blocks a PR.
- The PR body follows `.github/PULL_REQUEST_TEMPLATE.md`: Why, Summary, Verification, Not verified, and the optional issue-closing line. Describe observed verification, not intended checks; anything not tried belongs in Not verified.
- PR bodies, screenshots and logs never contain tokens, credentials or personal data.
- PR labels are optional. Use only the labels `issue-governance` permits (`bug`, `enhancement`, `documentation` and any its project labels add); never invent or import labels from another repository's taxonomy.
- Every required check must pass before merge, including on documentation-only PRs. Pending or failing required checks block merge. Check definitions live under `.github/workflows/`; point at them rather than duplicating their flags, and do not claim a check that has no workflow. Making a check merge-blocking requires repository protection configuration (a ruleset or branch protection on `main`); the workflow file alone does not establish that setting.
- Preserve the merge style of this repository: with explicit merge authorization, use `gh pr merge --merge` and no other method. Never interpret readiness as permission to merge.
<!-- kit:local rules -->
<!-- /kit:local rules -->

### Required checks

- `CI` (`.github/workflows/ci.yml`): aggregates `Checks (Node ...)`: tests with the coverage minimum, type check, lint and format, and package contents.

An empty list means the kit generated no required check for this project; checks configured outside the kit live under `.github/workflows/`. No check validates issue linkage.

## Branch Naming

Format: `type/slug`, lowercase and without spaces. The worktree directory is `../learnharness-git-worktrees/<type>-<slug>` (see `worktree-isolation`).

| Prefix | Use for |
| --- | --- |
| `feat/` | User-facing capability |
| `fix/` | Incorrect behavior |
| `refactor/` | Restructuring without intended behavior change |
| `perf/` | Performance improvement without intended behavior change |
| `docs/` | Documentation only |
| `test/` | Test-only changes |
| `chore/` | Tooling, skills and repository configuration |
| `ci/` | CI and release workflow changes |

Do not invent other prefixes. Do not impose an issue-number slug requirement; issue linkage belongs in the PR body.

## What Proves A Pull Request Here

- `.github/PULL_REQUEST_TEMPLATE.md`: body contract
- `.agents/skills/issue-governance/SKILL.md`: when an issue is recommended and permitted labels
- The workflows that actually run (none when the list is empty):

- `.github/workflows/ci.yml`: tests, coverage, type check, lint and package contents on pull requests and the default branch.
- `.github/workflows/security.yml`: CodeQL and `npm audit`, on pull requests, the default branch and weekly (not required).
- `.github/workflows/release.yml`: on tag `vX.Y.Z`, verify, publish to npm with provenance when `npm_publish` is `true`, then create the GitHub release from the notes.

<!-- kit:local proof -->
<!-- /kit:local proof -->

Release workflows run on pushed tags, not on PRs; they are not missing PR gates. Do not report another repository's checks as missing here. Do not call a local command run proof that remote required checks passed.

## Commit Format

Use Conventional Commits, such as `feat: ...`, `fix: ...`, `docs: ...` or `ci(release): ...`. Scopes are optional. Keep commits focused. With the `squash` merge method the PR title becomes the commit on `main`, so write it as a valid conventional commit; with `merge` the branch commits are preserved and the title does not replace them.

## Decision Gates

| Condition | Result |
| --- | --- |
| No issue, or an issue the PR does not link | GO: suggest adding `Closes #<n>` when an issue exists; never block on it |
| A required check fails or is pending | BLOCKED for merge |
| Required checks pass | GO for readiness, not authorization to publish or merge |
| A release workflow does not run on the PR | Not a missing PR gate |

## Output Contract

Return:

- `pr`: number/URL or "none";
- `issue_linked`: true/false, with the exact closing line if any (informational);
- `branch_valid`: true/false, with the naming deviation if any;
- `gate`: GO or BLOCKED, naming failing or pending required checks;
- verification performed and anything not verified.

## References

Paths below are repository-relative.

- `AGENTS.md`: skill precedence
- `.agents/skills/issue-governance/SKILL.md`: when an issue is recommended and labels
- `.agents/skills/worktree-isolation/SKILL.md`: worktree and branch creation
- `.github/PULL_REQUEST_TEMPLATE.md`: body contract
- `.github/workflows/`: actual check and release definitions
