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
