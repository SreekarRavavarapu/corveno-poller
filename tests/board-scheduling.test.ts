import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claimSources,
  createClaimQueue,
  isMissingRpc,
  nextChangeRate,
  nextPollInterval,
  passRunKey,
  scheduleAfterPoll,
  shardSources,
} from "../src/board-scheduling";

const base = { poll_interval_seconds: 1200, change_rate_ema: 0, consecutive_failures: 0 };

test("unchanged polls grow ×1.5 and cap at 6 h (same table as tests/sql/board-scheduling.sql)", () => {
  const expected = [1800, 2700, 4050, 6075, 9113, 13670, 20505, 21600, 21600];
  let state = { ...base };
  for (const interval of expected) {
    state = { ...state, poll_interval_seconds: nextPollInterval(state, { changed: false, failed: false }) };
    assert.equal(state.poll_interval_seconds, interval);
  }
});

test("a change resets to 20 minutes from any interval", () => {
  assert.equal(nextPollInterval({ ...base, poll_interval_seconds: 21600 }, { changed: true, failed: false }), 1200);
  assert.equal(nextPollInterval({ ...base, poll_interval_seconds: 1800 }, { changed: true, failed: false }), 1200);
});

test("failures back off 1200 × 2^failures and cap at 24 h without changing the EMA", () => {
  const expected: [number, number][] = [
    [0, 2400],
    [1, 2400],
    [2, 4800],
    [3, 9600],
    [4, 19200],
    [5, 38400],
    [6, 76800],
    [7, 86400],
    [8, 86400],
    [40, 86400],
  ];
  for (const [failures, interval] of expected) {
    assert.equal(nextPollInterval({ ...base, consecutive_failures: failures }, { changed: true, failed: true }), interval, `failures=${failures}`);
  }
  assert.equal(nextChangeRate(0.288, { changed: true, failed: true }), 0.288);
});

test("change rate EMA uses α = 0.2 and rounds like the database", () => {
  assert.equal(nextChangeRate(0, { changed: true, failed: false }), 0.2);
  assert.equal(nextChangeRate(0.2, { changed: true, failed: false }), 0.36);
  assert.equal(nextChangeRate(0.36, { changed: false, failed: false }), 0.288);
  assert.equal(nextChangeRate(0, { changed: false, failed: false }), 0);
});

test("scheduleAfterPoll sets next_due_at = now + interval", () => {
  const now = Date.UTC(2026, 8, 18, 12, 0, 0);
  const next = scheduleAfterPoll({ ...base, poll_interval_seconds: 6075 }, { changed: false, failed: false }, now);
  assert.deepEqual(next, {
    poll_interval_seconds: 9113,
    change_rate_ema: 0,
    consecutive_failures: 0,
    next_due_at: new Date(now + 9113 * 1000).toISOString(),
  });
});

const ALL = ["greenhouse", "lever", "ashby", "recruitee", "workable", "breezy", "pinpoint", "teamtailor", "usajobs"];

test("shards partition the sources; others = everything but the big three", () => {
  assert.deepEqual(shardSources("greenhouse", ALL), ["greenhouse"]);
  assert.deepEqual(shardSources("others", ALL), ["recruitee", "workable", "breezy", "pinpoint", "teamtailor", "usajobs"]);
  assert.deepEqual(shardSources("all", ALL), ALL);
  assert.deepEqual(shardSources(undefined, ALL), ALL);
  assert.deepEqual(shardSources("lever, ashby ,nosuch", ALL), ["lever", "ashby"]);
});

test("claimSources narrows by the pilot ATS filter and drops usajobs without credentials", () => {
  assert.deepEqual(claimSources({ shard: "others", all: ALL, usajobs: false }), ["recruitee", "workable", "breezy", "pinpoint", "teamtailor"]);
  assert.deepEqual(claimSources({ shard: "others", all: ALL, usajobs: true }), ["recruitee", "workable", "breezy", "pinpoint", "teamtailor", "usajobs"]);
  assert.deepEqual(claimSources({ shard: "all", atsFilter: "lever", all: ALL, usajobs: false }), ["lever"]);
  assert.deepEqual(claimSources({ shard: "greenhouse", atsFilter: "lever", all: ALL, usajobs: false }), []);
  assert.deepEqual(claimSources({ shard: "all", atsFilter: "all", all: ALL, usajobs: false }).includes("usajobs"), false);
});

test("missing-RPC detection covers PostgREST and Postgres signals only", () => {
  assert.equal(isMissingRpc({ code: "PGRST202", message: "Could not find the function public.claim_due_boards(...) in the schema cache" }), true);
  assert.equal(isMissingRpc({ code: "42883", message: "function public.claim_due_boards(integer) does not exist" }), true);
  assert.equal(isMissingRpc({ code: null, message: "Could not find the function public.record_corpus_collection_pass" }), true);
  assert.equal(isMissingRpc({ code: "57014", message: "canceling statement due to statement timeout" }), false);
  assert.equal(isMissingRpc(null), false);
});

test("pass run key: GitHub run id + attempt (+ shard), else the uuid", () => {
  assert.equal(passRunKey({ GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" }, "lever", () => "u"), "123-2-lever");
  assert.equal(passRunKey({ GITHUB_RUN_ID: "123" }, "all", () => "u"), "123-1");
  assert.equal(passRunKey({}, "lever", () => "local-uuid"), "local-uuid");
});

function fakeClaim(total: number, log: number[] = []) {
  let handed = 0;
  return {
    log,
    claim: async (limit: number) => {
      log.push(limit);
      const n = Math.min(limit, total - handed);
      const rows = Array.from({ length: n }, (_, i) => ({ id: `b${handed + i}` }));
      handed += n;
      return rows;
    },
  };
}

test("claim loop: claims in batches until the source is empty; eight workers share one in-flight claim", async () => {
  const source = fakeClaim(150);
  const queue = createClaimQueue({ claim: source.claim, cap: 4000, budgetMs: 60_000, batch: 64 });
  const seen: string[] = [];
  const worker = async () => {
    for (;;) {
      const board = await queue.next();
      if (!board) return;
      seen.push(board.id);
      await new Promise((r) => setImmediate(r));
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  assert.equal(seen.length, 150);
  assert.equal(new Set(seen).size, 150, "no board is handed out twice");
  assert.deepEqual(source.log, [64, 64, 64, 64], "single-flight claims: 64 + 64 + 22 rows, then the empty call — not one call per worker");
  assert.deepEqual(queue.stats().stoppedBy, "empty");
  assert.equal(queue.stats().claimed, 150);
});

test("claim loop: the per-pass board cap bounds the claims", async () => {
  const source = fakeClaim(10_000);
  const queue = createClaimQueue({ claim: source.claim, cap: 100, budgetMs: 60_000, batch: 64 });
  let count = 0;
  while (await queue.next()) count++;
  assert.equal(count, 100);
  assert.deepEqual(source.log, [64, 36], "the last claim asks only for the remaining allowance");
  assert.equal(queue.stats().stoppedBy, "cap");
});

test("claim loop: the wall-time budget stops new claims but already claimed boards still run", async () => {
  let clock = 0;
  const source = fakeClaim(10_000);
  const queue = createClaimQueue({ claim: source.claim, cap: 4000, budgetMs: 1000, batch: 10, now: () => clock });
  let count = 0;
  for (;;) {
    const board = await queue.next();
    if (!board) break;
    count++;
    if (count === 15) clock = 1000; // budget exhausted while the second batch is half done
  }
  assert.equal(count, 20, "the second batch finishes; no third claim");
  assert.deepEqual(source.log, [10, 10]);
  assert.equal(queue.stats().stoppedBy, "budget");
});

test("claim loop: rows from the probe claim are served first and counted", async () => {
  const source = fakeClaim(5);
  const queue = createClaimQueue({ claim: source.claim, cap: 4000, budgetMs: 60_000, batch: 64, initial: [{ id: "probe-1" }, { id: "probe-2" }] });
  const ids: string[] = [];
  for (;;) {
    const board = await queue.next();
    if (!board) break;
    ids.push(board.id);
  }
  assert.deepEqual(ids, ["probe-1", "probe-2", "b0", "b1", "b2", "b3", "b4"]);
  assert.equal(queue.stats().claims, 3, "probe + one full batch + the empty one");
  const empty = createClaimQueue({ claim: source.claim, cap: 4000, budgetMs: 60_000, batch: 64, initial: [] });
  assert.equal(await empty.next(), null, "an empty probe means nothing is due");
  assert.equal(empty.stats().stoppedBy, "empty");
});

test("claim loop: a failing claim ends the pass gracefully instead of throwing into the workers", async () => {
  let calls = 0;
  const queue = createClaimQueue({
    claim: async () => {
      calls++;
      if (calls === 1) return [{ id: "a" }, { id: "b" }];
      throw new Error("DATABASE_57014");
    },
    cap: 4000,
    budgetMs: 60_000,
    batch: 2,
  });
  const ids: string[] = [];
  for (;;) {
    const board = await queue.next();
    if (!board) break;
    ids.push(board.id);
  }
  assert.deepEqual(ids, ["a", "b"]);
  assert.equal(queue.stats().stoppedBy, "error");
  assert.equal(queue.stats().error, "DATABASE_57014");
});
