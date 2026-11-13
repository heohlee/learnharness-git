# learnharness-git — Agent Skills Index

Before contributing, read [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute, local checks, merge policy and releases.

When working on this project, load the relevant skill(s) BEFORE writing any code.

## How to Use

1. Check the trigger column to find skills that match your current task.
2. Load the skill by reading the `SKILL.md` file at the listed path.
3. Follow ALL patterns and rules from the loaded skill.
4. Multiple skills can apply simultaneously.

## Precedence

Repository-local skills under `.agents/skills/` take precedence over generic or global skills with the same purpose (for example generic branch, PR or issue skills). When a skill is added, renamed or removed, update this index in the same change.

## Skills

| Skill           | Trigger                                                                                                                                                                                                              | Path                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `git-workflow`  | Starting any change in this repository (before the first write), creating or triaging an issue, labeling, planning work, creating a branch or worktree, or creating, preparing, reviewing or merging a pull request. | `.agents/skills/git-workflow/SKILL.md`  |
| `node-tests`    | Node tests, `tests/*.test.ts`, the fake `git` runner, type stripping limits, or CI test evidence.                                                                                                                    | `.agents/skills/node-tests/SKILL.md`    |
| `release-notes` | Release notes or release messages.                                                                                                                                                                                   | `.agents/skills/release-notes/SKILL.md` |

## Learning data

The plugin works on the learner's own records. Never write conflict markers into JSON files: abort the merge and leave the files unchanged. Never run `git init` or clone without an explicit user action. Never commit, paste or log learning data, tokens, credentials or personal data, in code, tests, issues, PRs or release notes. Tests never run the real `git`, the network or LearnHarness.
