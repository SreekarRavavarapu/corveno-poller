/**
 * Board scheduling for the collector (Phase 1 item 1.4, September 2026).
 *
 * Pure module, no database client. Two parts:
 *  - the interval policy, a faithful copy of public.finish_board_poll
 *    (migration 20260917120000_board_due_times.sql). The database decides the
 *    real schedule; this copy documents the rule, is unit-tested against the
 *    same table of cases as the SQL harness and drives the fetch-volume
 *    estimate;
 *  - the claim queue, which turns claim_due_boards batches into a bounded
 *    stream of boards for the fetch workers: a per-pass board cap, a wall-time
 *    budget for claiming (in-flight boards always finish) and single-flight
 *    claims so eight workers never issue eight overlapping claim calls.
 */

export const CHANGED_INTERVAL_SECONDS = 1200;
export const QUIET_GROWTH = 1.5;
export const MAX_QUIET_INTERVAL_SECONDS = 3600; // owner decision Sep 18: quiet boards at least hourly (20260917190000)
export const MAX_FAILURE_BACKOFF_SECONDS = 86400;
export const CHANGE_RATE_ALPHA = 0.2;
export const BIG_THREE = ["greenhouse", "lever", "ashby"] as const;

export interface BoardSchedule {
  poll_interval_seconds: number;
  change_rate_ema: number;
  consecutive_failures: number;
}
export interface PollOutcome {
  /** The pass wrote new, updated, reopened or closed rows (or a first miss) for the board. */
  changed: boolean;
  /** The board run failed (fetch, validation or database). */
  failed: boolean;
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Next poll interval in seconds — same rule as public.finish_board_poll:
 *  failed    → 1200 × 2^max(consecutive_failures,1) capped at 24 h (exponent bounded at 8);
 *  changed   → 1200;
 *  unchanged → previous × 1.5 (ceil) capped at 1 h. */
export function nextPollInterval(schedule: BoardSchedule, outcome: PollOutcome): number {
  if (outcome.failed)
    return Math.min(
      MAX_FAILURE_BACKOFF_SECONDS,
      CHANGED_INTERVAL_SECONDS * 2 ** Math.min(Math.max(schedule.consecutive_failures, 1), 8),
    );
  if (outcome.changed) return CHANGED_INTERVAL_SECONDS;
  return Math.min(MAX_QUIET_INTERVAL_SECONDS, Math.ceil(schedule.poll_interval_seconds * QUIET_GROWTH));
}

/** change_rate_ema after a poll: α·changed + (1−α)·ema on successful polls; a
 * failure carries no change information and leaves it alone. */
export function nextChangeRate(ema: number, outcome: PollOutcome): number {
  if (outcome.failed) return ema;
  return round4(CHANGE_RATE_ALPHA * (outcome.changed ? 1 : 0) + (1 - CHANGE_RATE_ALPHA) * ema);
}

export function scheduleAfterPoll(
  schedule: BoardSchedule,
  outcome: PollOutcome,
  nowMs: number,
): BoardSchedule & { next_due_at: string } {
  const poll_interval_seconds = nextPollInterval(schedule, outcome);
  return {
    poll_interval_seconds,
    change_rate_ema: nextChangeRate(schedule.change_rate_ema, outcome),
    consecutive_failures: schedule.consecutive_failures,
    next_due_at: new Date(nowMs + poll_interval_seconds * 1000).toISOString(),
  };
}

/* ---------------- source partitioning (workflow shards) ---------------- */

/** Sources a shard covers. "all" (or blank) = every source; "others" = every
 * source except the big three; otherwise a comma-separated list, unknown
 * names dropped. */
export function shardSources(shard: string | undefined, all: readonly string[]): string[] {
  const key = (shard ?? "").trim().toLowerCase();
  if (!key || key === "all") return [...all];
  if (key === "others") return all.filter((s) => !(BIG_THREE as readonly string[]).includes(s));
  const wanted = key.split(",").map((s) => s.trim()).filter(Boolean);
  return all.filter((s) => wanted.includes(s));
}

/** The source list a pass claims: the shard, narrowed by the pilot's ATS
 * filter, minus USAJOBS when its credentials are absent (its boards are
 * skipped, never leased, never counted as failures). */
export function claimSources(input: {
  shard?: string;
  atsFilter?: string;
  all: readonly string[];
  usajobs: boolean;
}): string[] {
  let sources = shardSources(input.shard, input.all);
  const filter = (input.atsFilter ?? "all").trim().toLowerCase();
  if (filter && filter !== "all") sources = sources.filter((s) => s === filter);
  if (!input.usajobs) sources = sources.filter((s) => s !== "usajobs");
  return sources;
}

/** PostgREST / Postgres signal that an RPC does not exist (migration not yet
 * applied): the pass falls back to the pre-scheduling behaviour. */
export function isMissingRpc(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? "");
}

/** Pass key for leases and the pass summary: the GitHub run id (plus attempt
 * and shard, so parallel shard jobs of one run stay distinct) or a UUID. */
export function passRunKey(
  env: Record<string, string | undefined>,
  shard: string | undefined,
  uuid: () => string,
): string {
  const run = env.GITHUB_RUN_ID?.trim();
  if (!run) return uuid();
  const attempt = env.GITHUB_RUN_ATTEMPT?.trim() || "1";
  const key = (shard ?? "").trim().toLowerCase();
  return key && key !== "all" ? `${run}-${attempt}-${key}` : `${run}-${attempt}`;
}

/* ---------------- claim queue ---------------- */

export type ClaimStop = "cap" | "budget" | "empty" | "error" | null;

export interface ClaimQueueOptions<T> {
  /** Lease up to `limit` due boards (claim_due_boards). */
  claim: (limit: number) => Promise<T[]>;
  /** Boards this pass may take in total. */
  cap: number;
  /** Wall-time budget for claiming, in ms; boards already claimed still run. */
  budgetMs: number;
  /** Boards per claim call. */
  batch: number;
  /** Rows already claimed by the caller (the probe that detected the RPC). */
  initial?: T[];
  now?: () => number;
}

export interface ClaimQueueStats {
  claimed: number;
  claims: number;
  stoppedBy: ClaimStop;
  error: string | null;
  elapsedMs: number;
}

export function createClaimQueue<T>(options: ClaimQueueOptions<T>): {
  next: () => Promise<T | null>;
  stats: () => ClaimQueueStats;
} {
  const now = options.now ?? Date.now;
  const started = now();
  const queue: T[] = [];
  let claimed = 0,
    claims = 0,
    stoppedBy: ClaimStop = null,
    error: string | null = null,
    inflight: Promise<void> | null = null;
  const cap = Math.max(1, Math.floor(options.cap));
  const batch = Math.max(1, Math.floor(options.batch));
  if (options.initial) {
    claims = 1;
    claimed = options.initial.length;
    queue.push(...options.initial);
    if (!options.initial.length) stoppedBy = "empty";
    else if (claimed >= cap) stoppedBy = "cap";
  }
  async function refill(): Promise<void> {
    if (stoppedBy) return;
    if (claimed >= cap) {
      stoppedBy = "cap";
      return;
    }
    if (now() - started >= options.budgetMs) {
      stoppedBy = "budget";
      return;
    }
    let rows: T[];
    try {
      rows = await options.claim(Math.min(batch, cap - claimed));
    } catch (e) {
      stoppedBy = "error";
      error = e instanceof Error ? e.message : String(e);
      return;
    }
    claims++;
    if (!rows.length) {
      stoppedBy = "empty";
      return;
    }
    claimed += rows.length;
    queue.push(...rows);
    if (claimed >= cap) stoppedBy = "cap";
  }
  return {
    async next() {
      for (;;) {
        const item = queue.shift();
        if (item !== undefined) return item;
        if (stoppedBy) return null;
        if (!inflight)
          inflight = refill().finally(() => {
            inflight = null;
          });
        await inflight;
      }
    },
    stats: () => ({ claimed, claims, stoppedBy, error, elapsedMs: now() - started }),
  };
}
