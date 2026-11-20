# Contributing

Thanks for helping. Bug reports, fixes and new features are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree
  on the approach.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Setting up

See the Quick start in the [README](README.md). The test suites need no API
keys: model calls run on deterministic stubs.

## Making a change

1. Branch from `main`.
2. Keep the existing conventions:
   - Every table and query is scoped by `workspace_id`. Add or extend the
     cross-tenant tests when you touch data access.
   - Prompts live in `app/server/src/lib/prompts/<task>.md`, and every model
     call returns structured output validated by Zod. Bump a prompt's
     `version` when its body changes meaningfully. See
     [docs/llm-calls.md](docs/llm-calls.md).
   - Migrations are additive and idempotent (`addColumnIfMissing`).
   - New environment variables get a row in
     `app/server/src/platform/config.ts`; then run `npm run env:example`.
   - Unit tests never call a real model.
3. Run the checks for every package you touched:

   ```bash
   cd app/server && npm run build && npm run test:run
   cd app/web && npm run build
   cd surfaces/slack && npm test      # and/or surfaces/whatsapp
   ```

4. Open a pull request describing what changed and why.

## Sign-off

Every commit must carry a `Signed-off-by` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/): that
you wrote the change, or have the right to submit it under this project's
MIT licence. `git commit -s` adds it for you.

## Conduct

Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
