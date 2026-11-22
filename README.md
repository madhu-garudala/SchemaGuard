# Schema Guard

Schema Guard watches three source feeds (Orders, Payments, Shipping) that feed Finance, Revenue and Operations dashboards. When a producer proposes a schema change, it works out which dashboards would break, asks an investigator agent for a diagnosis, asks a repair agent for a mapping change, and replays the same logical records through the changed pipeline. A new snapshot is published only if the replay proves the dashboard totals are unchanged. Otherwise the previous snapshot stays.

Everything runs locally: a Next.js dashboard, a worker process, Postgres in Docker, and OpenClaw talking to Kimi K3.1 Pro on Cerebras.

## Start it

Prerequisites: Node 22 or later, Docker, OpenClaw installed (the CLI is expected at `~/.openclaw/bin/openclaw`), and `CEREBRAS_API_KEY` in `.env.local`.

One-time setup:

```bash
npm install
npm run db:up            # Postgres on 127.0.0.1:54329
npm run db:migrate
npm run db:seed          # catalog, baseline snapshot, fixture pipeline repo
npm run openclaw:setup   # creates the isolated OpenClaw profile "schema-guard"
```

Then three terminals:

```bash
npm run openclaw:gateway   # 1. OpenClaw gateway on 127.0.0.1:18795
npm run worker             # 2. worker (runs rehearsals and agents)
npm run dev                # 3. dashboard on http://localhost:3210
```

The gateway is only needed for live agent turns. Without it, the worker in `AGENT_MODE=auto` falls back to fixture output and labels it.

To start over: `npm run db:migrate -- --reset && npm run db:seed -- --fresh`.

## Run the main demo

Open http://localhost:3210 and press **Run schema-change rehearsal**. Or from a terminal:

```bash
npm run demo                  # main rehearsal
npm run demo -- --bad-repair  # same change, deliberately wrong repair
npm run demo -- --case 3      # any catalog case, 1 to 20
```

What happens in the rehearsal:

1. Payments proposes contract v2: `payment_amount` (decimal dollars) becomes `amount_cents` (integer cents). It is not active yet, so Finance keeps reading snapshot r1.
2. The watcher diffs v2 against v1, traces the column through lineage, and opens one alert: Finance and Revenue are at risk; Payments Platform owns the feed.
3. The investigator agent returns a finding that must cite evidence IDs belonging to this run.
4. The repair agent returns typed operations (`rename_field`, `convert_minor_units`). They are applied in a Git worktree of the fixture pipeline repo, producing a real diff.
5. The release gate checks that every unit, key and rename the repair relies on is declared in the producer's contract.
6. The replay runs the same 16 payments in the new format through the repaired pipeline and compares every row and every dashboard total with the baseline. A negative control confirms that keeping the old ×100 conversion (1234 cents becoming 123400) is caught.
7. Only then is v2 activated and snapshot r2 published. Finance net revenue is $1,592.27 before and after.

With `--bad-repair`, the replay fails on "Per-payment canonical rows match" and r1 stays published.

## Scenarios

http://localhost:3210/scenarios lists the twenty-case catalog with a **Replay** button per case, and **Generate scenarios**, which asks three separate author agents (Orders, Payments, Shipping) to draft new plans. Drafts are validated; rejected drafts are kept with the reason. Each replay runs in its own sandbox from the same baseline and fixed clock, and the expected outcome is stored in a table the investigator never sees.

The three quickest cases to try: **1** (repair and publish), **2** (safe additive change, no investigation), **3** (ambiguous unit, blocked until the owner clarifies).

| # | Case | Expected outcome |
|---|------|------------------|
| 1 | Payment field renamed and dollars changed to cents, declared | repair_and_publish |
| 2 | Safe nullable Orders field added | pass_and_publish |
| 3 | Payment unit changed with ambiguous contract metadata | block_pending_clarification |
| 4 | Required order ID removed | hold_previous_snapshot |
| 5 | Nullable field becomes required with existing nulls | hold_previous_snapshot |
| 6 | Numeric payments silently become strings | hold_previous_snapshot |
| 7 | Refund sign convention changes | repair_and_publish |
| 8 | Currency field removed from a multicurrency sample | hold_previous_snapshot |
| 9 | Duplicate payment IDs arrive in one batch | hold_previous_snapshot |
| 10 | Already-applied batch delivered again | ignore_event |
| 11 | Old batch arrives after a newer batch | ignore_event |
| 12 | Payment rows missing but the file is present | hold_previous_snapshot |
| 13 | Orders volume falls outside the configured range | hold_previous_snapshot |
| 14 | Shipping export misses its progress time, arrives before cutoff | warn_and_recover |
| 15 | Shipping export misses its hard deadline | delayed_previous_snapshot |
| 16 | Warehouse transformation fails after valid input | hold_previous_snapshot |
| 17 | Downstream join changes from one-to-one to one-to-many | repair_and_publish |
| 18 | Upstream change reverted after the warning | withdrawn_no_change |
| 19 | Two independent changes in close succession | repair_and_publish |
| 20 | OpenClaw or Cerebras unavailable during a rehearsal | hold_previous_snapshot |

## Live and fixture agent modes

`AGENT_MODE` (in `.env.local`, default `auto`):

- `live`: every agent turn goes through OpenClaw to `cerebras/moonshotai-kimi-k3.1-pro-trial`. A provider failure holds the change.
- `fixture`: deterministic canned agent output, no network. Used by the tests.
- `auto`: try live; on a provider failure (for example Cerebras `429 queue_exceeded`) use fixture output for that turn and say so.

Every agent turn is recorded with its mode, provider, model, token usage and elapsed time. Runs and timeline entries that used fixture output carry a "Fixture mode" label in the dashboard. A live turn that reports a different model than the configured one is rejected.

`npm run live:check` makes one minimal live call and one evidence-packet call and prints the provider, model and timing, never the key.

Agents never decide publication. The assertion gate, the repository tests and the replay are deterministic code.

## Secrets and OpenClaw

- The Cerebras key is read from `.env.local` (gitignored) and passed to OpenClaw through the environment. The OpenClaw config references it as `${CEREBRAS_API_KEY}`; the value is never written to a config or tracked file, and log output is redacted.
- Setup uses a separate OpenClaw profile (`~/.openclaw-schema-guard`). Your personal `~/.openclaw` configuration is not modified.
- `npm run openclaw:setup` appends a random `OPENCLAW_GATEWAY_TOKEN` to `.env.local` if one is missing.
- Agent role templates are in `openclaw/workspaces/<agent>/AGENTS.md`. The five agents are `sg-investigator`, `sg-repair`, `sg-orders-author`, `sg-payments-author` and `sg-shipping-author`. They have no tools; prompts are passed by file, not on the command line.

## Tests

```bash
npm test          # 71 tests; needs only the database (npm run db:up)
npm run typecheck
npm run build
```

Tests run in fixture mode against their own database (`schema_guard_test`) and runtime directory (`.runtime-test`), so they do not touch demo data. They cover: the baseline, the main rehearsal, the blocked bad repair, all twenty catalog cases against their expected outcomes, ambiguity blocking activation even when samples reconcile, late and missing files, duplicate and out-of-order batches, lease expiry and restart, rejection of evidence from another run, malformed agent output, provider outage, provenance and fixture labels, the publication guard, scenario generation, and the OpenClaw adapter's error classification.

## Layout

```
src/app            dashboard pages and API routes (read the database, enqueue jobs)
src/components     UI
src/worker         job loop: claims jobs, executes runs, calls agents
src/lib            contracts, runner, replay, queue, scorer, agents/
db/migrations      schema
fixtures           contracts, baseline data, independently computed expected totals,
                   lineage, and the pipeline template the repairs are applied to
openclaw           agent workspace templates
scripts            migrate, seed, demo, openclaw setup/gateway, live check
tests              acceptance and unit tests
.runtime           generated: fixture Git repo, repair worktrees, logs (gitignored)
```

Money is integer minor units (BigInt) end to end and is serialized as a decimal string.

## Deploying the dashboard separately

The dashboard and the worker share only the Postgres database. The dashboard never spawns OpenClaw, touches Git or reads the fixture files at runtime; it reads rows and inserts jobs. To host the dashboard on Vercel later:

- point `DATABASE_URL` at a hosted Postgres for both the dashboard and the worker;
- keep the worker and the OpenClaw gateway on a machine that holds the Cerebras key (the dashboard needs no key);
- add authentication before exposing the POST routes, which are open on localhost today.

## Known limits

- Kimi K3.1 Pro on Cerebras is a trial model and intermittently returns `429 queue_exceeded`. In `auto` mode the run continues with labelled fixture output.
- The feeds, clock and pipeline are simulated fixtures. There is no connection to a real warehouse or a real pull-request system.
- Jobs that share a fixture are serialized by key; this is safe with one worker. Running several workers at once has a narrow window where two jobs with the same key could both be claimed.
