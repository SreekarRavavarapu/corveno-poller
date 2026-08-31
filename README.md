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
