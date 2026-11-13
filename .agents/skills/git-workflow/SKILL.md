---
name: git-workflow
description: "Trigger: starting any change in learnharness-git, creating or triaging an issue, labeling, planning work, creating a branch or worktree, or creating, preparing, reviewing or merging a pull request. Issues are optional and never a gate; each change gets its own worktree and branch; pull requests follow the template, the required checks and the merge method."
license: MIT
metadata:
  author: "heohlee"
  version: "1.0"
---

## Activation Contract

Use before the first write of any learnharness-git change (feature, bug, chore, docs or skill edit), when an issue needs creating, labeling or triaging, and when a change is pushed for a pull request, needs a PR created or edited, or is checked for review readiness.

Do not use for read-only work: Q&A, reading, searching, inspecting history, running tests or building all leave the main checkout usable. Loading this skill does not authorize GitHub writes, pushing, opening a PR or merging.

Generic PR, branch or issue instructions installed in your agent describe other repositories and do not apply here. Follow this skill rather than importing checks from another repository, and do not reconcile the two.

## Hard Rules

- An issue is optional for every change and every contributor: a pull request may arrive without one, and no CI check requires it. Recommend opening an issue first only for large or design-changing work, so the idea can be discussed before code is written. Never block, close or delay a change for lacking an issue, and never require an approval label or an approval round trip. Do not reintroduce issue or approval requirements through labels, title conventions or contributor roles.
- One change, one worktree, one branch. The main checkout is for reading, syncing and merging.
- Every required check must pass before merge, including on documentation-only PRs. Never interpret readiness as permission to merge.
- Never put tokens, credentials or personal data in issues, PR bodies, comments, screenshots or logs. Summarize or redact logs.
- Respect the current task's authorization: if GitHub writes are prohibited, report the proposed issue, labels or PR without creating or editing anything remotely.

## Issues

An issue is optional; when one exists, it governs the change: it is the intent anchor and the target of the PR's `Closes #<n>` line. Search for an existing issue and reuse it if present. For large or design-changing work without one, propose one (title prefix, motivation, acceptance criteria) and create it when authorized. Keep its classification truthful as scope changes.

### Issue Forms

`.github/ISSUE_TEMPLATE/` has a bug report form (applies `bug`) and a feature request form (applies `enhancement`). Blank issues are disabled in the web UI, so documentation, chores, CI and tooling issues are created with `gh issue create`.

### Label Taxonomy

| Group | Rule | Values |
| --- | --- | --- |
| Type | Exactly one for bugs, capabilities or docs-only work | `bug`: incorrect behavior; `enhancement`: new capability; `documentation`: documentation only |
| Maintenance | No label | Chores, CI and tooling issues remain unlabeled; do not invent a chore type |
| Triage | Only when applicable, not a type or approval gate | GitHub defaults: `duplicate`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix` |

Use only these labels, on issues and PRs alike; never create labels or import another repository's taxonomy. Apply the best fit best-effort and note uncertainty; missing or imperfect labels never block or delay work. Classification belongs to the issue; PR labels are optional and need not duplicate it. An issue that is only a question or triage record needs no type label. Verify the live inventory with `gh label list --repo heohlee/learnharness-git`; do not claim it contains only these labels without checking. Labels outside the permitted set do not authorize using them or changing the remote inventory.

<!-- local: labels -->
<!-- /local: labels -->

Labels are informational. Only claim release-note grouping by labels if an actual `.github/release.yml` configures it; `.github/workflows/release.yml` is a different file.

### Issue Title Prefixes

New issue titles start with one prefix matching the change type: `[Feature]`, `[Bug]`, `[Docs]` or `[Chore]`. Example: `[Feature] Add export to CSV`. The forms apply `[Bug]` and `[Feature]`; apply the others manually. The prefix is a human-readable aid, not a replacement for the label: a missing or wrong prefix is not a violation and never becomes a gate; when prefix and label disagree, the label wins. Do not bulk-edit existing titles.

## Branches and Worktrees

Branch `type/slug`, lowercase and without spaces, based on an updated `main`. The worktree goes in the sibling directory next to the repository root, never inside it: `../learnharness-git-worktrees/<type>-<slug>`.

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

Do not invent other prefixes or impose an issue-number slug requirement; issue linkage belongs in the PR body. Worktrees never share mutable local state: when the project runs a server or keeps a local database, each worktree uses its own port and data path.

<!-- local: worktree-rules -->
<!-- /local: worktree-rules -->

1. Create the worktree from the updated base. `--track` sets the upstream, so a later push needs no `-u`:

   ```
   git fetch origin
   git worktree add --track -b <type>/<slug> ../learnharness-git-worktrees/<type>-<slug> origin/main
   cd ../learnharness-git-worktrees/<type>-<slug>
   ```

2. Work, test and commit only inside that worktree; the local checks mirror the required checks below.

<!-- local: worktree-setup -->
<!-- /local: worktree-setup -->

3. After the PR is merged, remove the worktree from the main checkout with `git worktree remove ../learnharness-git-worktrees/<type>-<slug>`, only with authorization.

## Pull Requests

- The PR body follows `.github/PULL_REQUEST_TEMPLATE.md`: Why, Summary, Verification, Not verified, and the optional issue-closing line. Describe observed verification, not intended checks; anything not tried belongs in Not verified.
- When an issue exists, link it with a standalone `Closes #<n>` line. No check requires the line; a missing issue or link never blocks a PR.
- Pending or failing required checks block merge. Check definitions live under `.github/workflows/`; point at them rather than duplicating their flags, and do not claim a check that has no workflow. Making a check merge-blocking requires repository protection configuration (a ruleset or branch protection on `main`); the workflow file alone does not establish that setting.
- With explicit merge authorization, use `gh pr merge --merge` and no other method.
<!-- local: pr-rules -->
<!-- /local: pr-rules -->

### Required checks

- `CI` (`.github/workflows/ci.yml`): aggregates `Checks (Node ...)`: tests with the coverage minimum, type check, lint and format, and package contents.

An empty list means no required check is configured for this project yet; any other workflows live under `.github/workflows/`. No check validates issue linkage.

### What Proves A Pull Request Here

- `.github/PULL_REQUEST_TEMPLATE.md`: body contract
- The workflows that actually run (none when the list is empty):

- `.github/workflows/ci.yml`: tests, coverage, type check, lint and package contents on pull requests and the default branch.
- `.github/workflows/security.yml`: CodeQL and `npm audit`, on pull requests, the default branch and weekly (not required).
- `.github/workflows/release.yml`: on tag `vX.Y.Z`, verify, publish to npm with provenance when `npm_publish` is `true`, then create the GitHub release from the notes.

<!-- local: proof -->
<!-- /local: proof -->

Release workflows run on pushed tags, not on PRs; they are not missing PR gates. Do not report another repository's checks as missing here. Do not call a local command run proof that remote required checks passed.

### Commit Format

Use Conventional Commits, such as `feat: ...`, `fix: ...`, `docs: ...` or `ci(release): ...`. Scopes are optional. Keep commits focused. With the `squash` merge method the PR title becomes the commit on `main`, so write it as a valid conventional commit; with `merge` the branch commits are preserved and the title does not replace them.

## Decision Gates

| Condition | Result |
| --- | --- |
| No issue exists for the change | GO: the issue is optional; suggest one only for large or design-changing work |
| Issue exists | GO: no approval wait |
| Bug, capability or docs issue has missing or conflicting type labels | GO: apply or propose the best-fit single type; never block over labels |
| Label is ambiguous or outside the permitted set | GO: note or propose a correction; do not create labels |
| Chore, CI or tooling issue is unlabeled | GO: this is the intended classification |
| No issue, or an issue the PR does not link | GO: suggest adding `Closes #<n>` when an issue exists |
| Branch name or prefix deviates | GO: report the deviation in `branch_valid` |
| A required check fails or is pending | BLOCKED for merge |
| Required checks pass | GO for readiness, not authorization to publish or merge |
| A release workflow does not run on the PR | Not a missing PR gate |

## Output Contract

Return:

- `issue`: number/URL or "none"; `labels_valid`: true/false, with the exact taxonomy deviation if false;
- `worktree`: path, branch and base commit, plus any per-worktree port or data path in use; `branch_valid`: true/false, with the naming deviation if any;
- `pr`: number/URL or "none"; `issue_linked`: true/false, with the exact closing line if any (informational);
- `gate`: GO or BLOCKED, naming failing or pending required checks;
- verification performed, anything not verified, and proposed corrections or GitHub writes not performed because authorization was absent.

## References

Paths below are repository-relative.

- `.github/ISSUE_TEMPLATE/`: bug report and feature request forms
- `.github/PULL_REQUEST_TEMPLATE.md`: body contract
- `.github/workflows/`: actual check and release definitions
- GitHub label inventory: `gh label list --repo heohlee/learnharness-git`
<!-- local: references -->
<!-- /local: references -->
