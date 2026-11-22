# Synthetic warehouse pipeline

Fixture repository used by Schema Guard. `npm run db:seed` copies this template into
`.runtime/fixture-repo` and makes it a standalone Git repository. Repairs are applied in
run-specific worktrees of that repository, never in the Schema Guard application repo.

- `mappings/*.json` — versioned source-to-canonical field mappings (the only files a repair may change, plus `samples/`).
- `transform.mjs` — staging, facts, joins and dashboard aggregates. Money is BigInt cents.
- `run.mjs` — JSON in on stdin, JSON out on stdout.
- `test.mjs` — `node --test test.mjs`.
