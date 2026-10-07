# Jev Tab Order

## Code Conventions

- Follow existing structure and conventions. Use arrow functions, type aliases,
  inferred return types, and `@/` imports within the application. Preserve relative
  imports in configuration files when required by their runtime.
- Order constants, types, and internal data structures before main exports, followed
  by helpers.
- Use default Oxfmt formatting and default Oxlint rules with the built-in React
  plugin. Do not add stylistic rules or speculative abstractions.

## UI Text and Translation

- `locales/en.json` is the source of truth. Use WXT's `#i18n` in extension code.
- When adding, removing, or changing the meaning of text, update all supported
  locales in the same change. Avoid unrelated translation edits.
- Check keys, non-empty messages, placeholders, and consistency of meaning across
  languages.

## Documentation

- Write project-owned documentation and skills in English by default.
- Keep `README.md` and `README.ja.md` aligned in structure and meaning, with
  reciprocal language links.
- `CHROMEWEBSTORE.md` field names may be Japanese; localized store copy uses its
  target language.
- Do not modify downloaded official skills to enforce these language conventions.
## Hosted CI status

GitHub-hosted CI is intentionally paused to avoid Actions billing. Do not treat missing CI, or historical failed/cancelled Actions runs, as an implementation blocker. Do not spend time trying to repair or re-run hosted Actions unless the user explicitly says hosted CI has been re-enabled.

Run the repository's documented validation commands locally and report the exact commands and results. Do not manually dispatch the GitHub Actions validation workflow unless explicitly requested.

## Work-ticket lifecycle

Use three explicit GitHub issue types:

- `[Agent]` — bounded implementation work that an agent can complete and verify. Prefer one Agent issue → one PR. A PR that fully completes it must use `Closes #123` (or `Closes owner/repository#123` cross-repo).
- `[Human]` — acceptance or work requiring the owner, subjective judgment, a physical device/appliance, personal credentials/accounts, or another real-world check the coding agent cannot independently prove. These normally do not need a PR.
- `[Epic]` — a larger product outcome spanning multiple Agent and/or Human tickets. Epics may stay open across many PRs; implementation should happen in bounded Agent children.

Do not mix human-only acceptance into an Agent ticket. If implementation needs physical-device, subjective, account-owner, reboot, external-network, or similar acceptance, put that checklist in a linked `[Human]` ticket. The Agent PR can then close its Agent issue when the implementation and agent-verifiable checks are complete.

If Human validation later finds a defect, create a new bounded `[Agent]` bug from the concrete observation instead of keeping or reopening an otherwise completed implementation ticket unless the original implementation was genuinely incomplete.

Use `Refs #123` only for deliberately partial work that should not close the issue. When practical, split remaining work into a new ticket before merging. Only `[Agent]` tickets should normally receive autonomous-agent pickup labels such as `ready for agent pickup`.

The canonical workflow convention is tracked in `khuumi/mac-agent-setup#37`.
