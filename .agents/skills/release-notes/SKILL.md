---
name: release-notes
description: "Trigger: release notes, release message, notas de release, mensaje de release. Draft concise, evidence-backed learnharness-git release copy without publishing."
license: MIT
metadata:
  author: "heohlee"
  version: "1.0"
---

## Activation Contract

Use when drafting or revising release text. Do not use for bumping versions, building artifacts, managing tags or publishing.

## Hard Rules

- Write English unless the owner requests otherwise. Use only the version as the title; do not repeat it as a body heading.
- Describe verified user impact from the selected source. Never invent changes, verification results or roadmap promises.
- Omit empty sections, repeated README content and routine CI, smoke, checksum or digest reports. Do not use en dashes, em dashes or middle dots.
- Never include tokens, credentials or personal data, even in screenshots.
- Never create tags, change releases or labels, push, publish or alter publication workflows. Return a draft; publication needs separate explicit authorization.

## Decision Gates

| Content | Sections |
| --- | --- |
| First release | Short product introduction, Highlights with the main capabilities and Getting started |
| Fixes only | Fixes |
| Features and fixes | Features, then Fixes |
| Noteworthy change needing explanation or a screenshot | Optional Highlights; do not repeat Features |
| Installation changes | Getting started only when instructions changed |
| Required upgrade action or incompatibility (for example a new minimum runtime version) | Upgrade notes before the changes |

## Execution Steps

1. Resolve the requested version, exact target and previous published release. Ask if ambiguous. Inspect the source range and merged PRs; for a first release inspect capabilities instead.
2. Use native generated notes as input, not finished copy. Categories, if configured, use PR labels, not issue labels. Inspect every change, including unlabeled ones, instead of dropping it.
3. Select only applicable sections. Read `assets/examples.md` for hypothetical formatting, never factual claims.
4. Finish with a real Full changelog comparison when a previous release exists, then one Documentation link line (`https://github.com/heohlee/learnharness-git#readme`). Pin links to verified source refs. Do not add a Documentation section.

<!-- local: links -->
<!-- /local: links -->

## Output Contract

Return the version-only title and Markdown body, plus a separate private evidence summary: target/range, change sources and unresolved facts or links. Keep that summary out of the public text. Never claim publication.

<!-- local: publication -->
Releases are tag-driven: the tag is `vX.Y.Z` and must match the `version` in both `package.json` and `manifest.json`. Store the approved notes as `.github/release-notes/vX.Y.Z.md` on `main` before pushing the tag. On the tag, `.github/workflows/release.yml` verifies and creates the GitHub release from that file (no npm publish); `.github/workflows/release-package.yml` then builds and attaches `learnharness-git-X.Y.Z.zip`, the archive for install path 2 in the README.
<!-- /local: publication -->

## References

- [Formatting examples](assets/examples.md)
