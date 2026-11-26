# CLAUDE.md

- Never add yourself to commits as author.
- Always talk in English.
- Use placeholders for account names, login usernames, and Riot IDs in committed files. Include a real identifier only when it is essential to reproduce research.
- Keep `PATCH_NOTES.md` updated when implementing a feature, user-facing fix, or QoL improvement.
- Every section in `PATCH_NOTES.md` (including `## Unreleased`) must start with `**Overview:**` (a very short, high-level summary of the features/changes in that version) followed by `**Detailed Patch Notes:**` (a bullet list of short, friend-readable notes).
- Before committing a completed feature, add a short, friend-readable bullet under `**Detailed Patch Notes:**` in `## Unreleased` in `PATCH_NOTES.md`, and keep the `**Overview:**` summary in `## Unreleased` up to date.
- When a release/version tag is created or observed, move the current `Unreleased` overview and detailed bullets into a new section for that version and date if known, then leave a fresh `## Unreleased` section at the top with `**Overview:**` and `**Detailed Patch Notes:**`.
- Patch notes should stay high level and easy to send to friends. Avoid internal function names, endpoint details, and overly technical wording unless the user asks for that.
