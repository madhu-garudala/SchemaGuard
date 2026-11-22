# Schema Guard

See README.md for setup, commands and layout.

- Checks before calling work done: `npm run typecheck`, `npm test` (needs `npm run db:up`), `npm run build`.
- Never write secrets to tracked files or output. The Cerebras key lives only in `.env.local`.
- The dashboard (`src/app`, `src/components`) must not import worker-only code (`src/lib/env.ts`, `src/lib/agents`, `src/lib/fixture-repo.ts`, `src/lib/runner.ts`).
- Money is integer minor units (BigInt), serialized as decimal strings.

## Peer review
Before presenting a pull request as ready, run the `peer-review` skill. A PR is ready only when
`peer-review.mjs status <pr>` prints `ready: true`. The owner makes the merge decision.
Do not write the reviewers' names into the repository, commits or PRs.
