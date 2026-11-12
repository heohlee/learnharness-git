---
name: worktree-isolation
description: "Trigger: starting any change in the learnharness-git repository. Create a new git worktree under ../learnharness-git-worktrees instead of working in the main checkout, so several changes can run in parallel."
license: MIT
metadata:
  author: "heohlee"
  version: "2.0"
---

## Activation Contract

Run before the first write of any change: feature, bug, chore, docs, or skill edit. Not needed for read-only work: reading, searching, inspecting history, running tests or building all leave the main checkout usable.

## Hard Rules

- One change, one worktree, one branch. The main checkout is for reading, syncing, and merging.
- The worktree goes in the sibling directory next to the repository root, never inside it: `../learnharness-git-worktrees/<type>-<slug>`.
- Branch `<type>/<slug>`, based on an updated `main`. The prefixes are listed in `../pr-governance/SKILL.md`.
- An issue is optional; when one exists, it governs the change (`../issue-governance/SKILL.md`).
- Worktrees never share mutable local state: when the project runs a server or keeps a local database, each worktree uses its own port and data path.
<!-- kit:local rules -->
<!-- /kit:local rules -->

## Execution Steps

1. Create the worktree from the updated base. `--track` sets the upstream, so a later push needs no `-u`:

   ```
   git fetch origin
   git worktree add --track -b <type>/<slug> ../learnharness-git-worktrees/<type>-<slug> origin/main
   cd ../learnharness-git-worktrees/<type>-<slug>
   ```

2. Work, test and commit only inside that worktree; the local checks mirror the required CI checks listed in `../pr-governance/SKILL.md`.

<!-- kit:local setup -->
<!-- /kit:local setup -->

3. After the PR is merged, remove the worktree from the main checkout with `git worktree remove ../learnharness-git-worktrees/<type>-<slug>`, only with authorization.

## Output Contract

Report the worktree path, its branch and the base commit, plus any per-worktree port or data path in use.

## References

- `../../../AGENTS.md`: skill registration.
- `../issue-governance/SKILL.md`: when an issue is recommended and label taxonomy.
- `../pr-governance/SKILL.md`: branch prefixes and required checks.
