# CLAUDE.md

- Never add yourself to commits as author.
- Always talk in English.
- Keep `PATCH_NOTES.md` updated when implementing a feature, user-facing fix, or QoL improvement.
- Before committing a completed feature, add a short, friend-readable bullet under `## Unreleased` in `PATCH_NOTES.md`.
- When a release/version tag is created or observed, move the current `Unreleased` bullets into a new section for that version and date if known, then leave a fresh empty `Unreleased` section at the top.
- Patch notes should stay high level and easy to send to friends. Avoid internal function names, endpoint details, and overly technical wording unless the user asks for that.
