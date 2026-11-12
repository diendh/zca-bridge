import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createPool } from "../../src/store/db.js";
import { runMigrations } from "../../src/store/migrate.js";
import { JobQueueRepo } from "../../src/store/jobQueueRepo.js";
import type { Pool } from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
let pool: Pool;

beforeAll(async () => {
  if (!url) return;
  await runMigrations(url);
  pool = createPool(url);
});
beforeEach(async () => { if (pool) await pool.query("TRUNCATE job_queue RESTART IDENTITY"); });
afterAll(async () => { if (pool) await pool.end(); });

d("JobQueueRepo", () => {
  it("enqueues idempotently by (kind, dedup_key)", async () => {
    const q = new JobQueueRepo(pool);
    expect(await q.enqueue("inbound", "acct1:m1", { a: 1 })).toBe(true);
    expect(await q.enqueue("inbound", "acct1:m1", { a: 1 })).toBe(false); // duplicate ignored
  });

  it("claims a pending job exactly once and marks done", async () => {
    const q = new JobQueueRepo(pool);
    await q.enqueue("outbound", "msg-7", { hello: "world" });
    const job = await q.claimNext();
    expect(job?.payload).toEqual({ hello: "world" });
    expect(job?.attempts).toBe(1);
    expect(await q.claimNext()).toBeNull(); // already processing -> not re-claimed immediately
    await q.markDone(job!.id);
  });

  it("retries with backoff, then dead-letters at max_attempts", async () => {
    const q = new JobQueueRepo(pool);
    await q.enqueue("outbound", "msg-fail", { x: 1 });
    await pool.query("UPDATE job_queue SET max_attempts = 1 WHERE dedup_key = 'msg-fail'");
    const job = await q.claimNext();             // attempts -> 1
    const res = await q.markRetry(job!.id, "boom", 0); // attempts(1) >= max(1) => failed
    expect(res.status).toBe("failed");
    const failed = await q.listFailed();
    expect(failed.map((f) => f.dedupKey)).toContain("msg-fail");
  });

  it("reclaims a stale processing job", async () => {
    const q = new JobQueueRepo(pool);
    await q.enqueue("inbound", "stale-1", { y: 2 });
    const job = await q.claimNext();
    await pool.query("UPDATE job_queue SET updated_at = now() - interval '10 minutes' WHERE id = $1", [job!.id]);
    const reclaimed = await q.claimNext(); // stale processing reclaimed
    expect(reclaimed?.id).toBe(job!.id);
    expect(reclaimed?.attempts).toBe(2);
  });

  it("claims only the requested kinds (lanes)", async () => {
    const q = new JobQueueRepo(pool);
    await q.enqueue("inbound", "in-1", { n: 1 }, "4:t1");
    await q.enqueue("outbound", "out-1", { n: 2 });
    expect((await q.claimNext(["inbound"]))?.dedupKey).toBe("in-1");
    expect(await q.claimNext(["inbound"])).toBeNull();
    expect((await q.claimNext(["outbound", "undo"]))?.dedupKey).toBe("out-1");
  });

  it("keeps one lane ordered while other lanes run in parallel", async () => {
    const q = new JobQueueRepo(pool);
    await q.enqueue("inbound", "a-1", {}, "4:A");
    await q.enqueue("inbound", "a-2", {}, "4:A");
    await q.enqueue("inbound", "b-1", {}, "4:B");
    const [x, y, z] = await Promise.all([q.claimNext(["inbound"]), q.claimNext(["inbound"]), q.claimNext(["inbound"])]);
    expect(x?.dedupKey).toBe("a-1");
    expect(y?.dedupKey).toBe("b-1"); // a-2 is held back while a-1 is in flight
    expect(z).toBeNull();
    await q.markDone(x!.id);
    expect((await q.claimNext(["inbound"]))?.dedupKey).toBe("a-2");
  });

  it("does not let a stale in-flight job block its lane", async () => {
    const q = new JobQueueRepo(pool);
    await q.enqueue("inbound", "s-1", {}, "4:S");
    await q.enqueue("inbound", "s-2", {}, "4:S");
    const first = await q.claimNext();
    await pool.query("UPDATE job_queue SET updated_at = now() - interval '10 minutes' WHERE id = $1", [first!.id]);
    expect((await q.claimNext())?.dedupKey).toBe("s-1"); // the stale one is reclaimed first, in order
  });

  it("requeues jobs left in flight by a previous run", async () => {
    const q = new JobQueueRepo(pool);
    await q.enqueue("inbound", "r-1", {}, "4:R");
    await q.claimNext();
    expect(await q.requeueInFlight()).toBe(1);
    expect((await q.claimNext())?.dedupKey).toBe("r-1");
  });

  it("purges only finished jobs past the retention window", async () => {
    const q = new JobQueueRepo(pool);
    await q.enqueue("outbound", "old-done", {});
    await q.enqueue("outbound", "new-done", {});
    await q.enqueue("outbound", "old-pending", {});
    await pool.query("UPDATE job_queue SET status = 'done' WHERE dedup_key IN ('old-done', 'new-done')");
    await pool.query("UPDATE job_queue SET updated_at = now() - interval '40 days' WHERE dedup_key IN ('old-done', 'old-pending')");
    expect(await q.purgeDone(30)).toBe(1);
    const left = await pool.query("SELECT dedup_key FROM job_queue ORDER BY id");
    expect(left.rows.map((r) => r.dedup_key)).toEqual(["new-done", "old-pending"]);
  });
});
