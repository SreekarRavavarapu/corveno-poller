# corveno-poller

Keeps [Corveno](https://corveno.io)'s job corpus fresh: polls public ATS job
boards (Greenhouse, Lever, Ashby) every ~20 minutes, refreshes community seed
lists, classifies postings (intern / new-grad / other), and diffs
new / reopened / closed into the database.

No secrets live in this repo — credentials are injected via GitHub Actions
secrets (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).

## How it works

- `dist/run.cjs seed` — refreshes curated lists into the corpus
- `dist/run.cjs poll` — fetches every verified ATS board, classifies, diffs
- `dist/run.cjs verify` — weekly registry health check (active/empty/dead)

Source in `src/run.ts`; `dist/` is the esbuild bundle committed for
zero-install workflow runs.

## Data sources & thanks

- [SimplifyJobs/Summer2027-Internships](https://github.com/SimplifyJobs/Summer2027-Internships)
  and [SimplifyJobs/New-Grad-Positions](https://github.com/SimplifyJobs/New-Grad-Positions)
  (Pitt CSC + Simplify)
- [vanshb03/Summer2027-Internships](https://github.com/vanshb03/Summer2027-Internships) (MIT)
- [kalil0321/ats-scrapers (jobhive)](https://github.com/kalil0321/ats-scrapers) company registry (MIT)
- The public job-board APIs of Greenhouse, Lever, and Ashby

Polling is deliberately gentle: one request per board per cycle, conditional
concurrency limits, and backoff on errors.

## Collector generation 2 (September 2026)

`src/` is synced from the Corveno app repository (`scripts/corpus/run.ts`,
`scripts/corpus/primary-source.ts`, `lib/corpus/country-evidence.ts`,
`lib/corpus/employment-evidence.ts`) with `npm run sync`, then `npm run typecheck`
and `npm run build`; `dist/run.cjs` is committed. Greenhouse is fetched with
`content=true`, Lever pages with its requirement lists, Ashby with full HTML
descriptions; every job keeps its complete text, a stable source record and its
SHA-256, explicit country evidence and a source-stated employment type with quotes.
Writes go through the service RPCs (`begin/apply/finish_corpus_collection`), are
change-only and batch-indexed; absence is only recorded after complete snapshots.

Bounded rollout controls (see `.github/workflows/pilot.yml`):
`COLLECT_BOARD_LIMIT` (0 = all), `COLLECT_ATS` (`greenhouse|lever|ashby|all`),
`COLLECT_TIER` (`intern-proven|harvested|all`), `COLLECT_PILOT=1` (prints a
`PILOT_SUMMARY` JSON line with payload bytes, description sizes, typed/country
coverage and database time).

## Scheduled polling (September 2026, Phase 1 item 1.4)

With migration `20260917120000_board_due_times.sql` applied, a pass no longer
fetches every board. It claims due boards through `claim_due_boards` (a lease per
board, owner = the pass run key, fairness round-robin across sources; inside a
source: overdue > 2 h, intern-proven, highest change rate, most overdue) and
reports every outcome through `finish_board_poll`, which sets the next due time:
changed → 20 min; unchanged → ×1.5 up to 6 h; failed → 20 min × 2^failures up
to 24 h. At the end of the pass one `PASS_SUMMARY` line is printed and
`record_corpus_collection_pass` is called (a missing RPC is a warning).
Without the migration the pass logs a warning and polls every board as before.

`poll.yml` runs four parallel shard jobs (`COLLECT_ATS_SHARD` = `greenhouse`,
`lever`, `ashby`, `others`), each with its own concurrency group; the wake-up
POST runs once after all shards. Knobs (env): `COLLECT_BOARD_CAP` (boards per
pass per shard, default 4000), `COLLECT_PASS_BUDGET_SECONDS` (stop claiming
after this long, default 900; claimed boards still finish),
`COLLECT_LEASE_SECONDS` (default 1800), `COLLECT_CLAIM_BATCH` (boards per claim,
default 64), `COLLECT_ATS_SHARD` (`all`, a group name or a comma-separated
source list). `npm test` runs the unit tests for the interval policy and the
claim loop (`tests/`).
