import { describe, it, expect, vi } from "vitest";
import { Worker, backoffSeconds } from "../../src/worker/worker.js";
import type { Job } from "../../src/store/jobQueueRepo.js";

function job(over: Partial<Job> = {}): Job {
  return { id: 1, kind: "outbound", dedupKey: "k", payload: {}, attempts: 1, status: "processing", ...over };
}

describe("backoffSeconds", () => {
  it("grows exponentially and caps", () => {
    expect(backoffSeconds(1)).toBe(2);
    expect(backoffSeconds(2)).toBe(4);
    expect(backoffSeconds(3)).toBe(8);
    expect(backoffSeconds(20)).toBe(300); // capped at 300s
  });
});

describe("Worker.tick", () => {
  it("dispatches a claimed job and marks it done on success", async () => {
    const q = {
      claimNext: vi.fn(async () => job()),
      markDone: vi.fn(async () => {}),
      markRetry: vi.fn(async () => ({ status: "pending" as const, attempts: 1 })),
    };
    const dispatch = vi.fn(async () => {});
    const onPermanentFailure = vi.fn(async () => {});
    const w = new Worker(q as any, dispatch, onPermanentFailure);
    const did = await w.tick();
    expect(did).toBe(true);
    expect(dispatch).toHaveBeenCalled();
    expect(q.markDone).toHaveBeenCalledWith(1);
  });

  it("retries with backoff when dispatch throws", async () => {
    const q = {
      claimNext: vi.fn(async () => job({ attempts: 2 })),
      markDone: vi.fn(async () => {}),
      markRetry: vi.fn(async () => ({ status: "pending" as const, attempts: 2 })),
    };
    const dispatch = vi.fn(async () => { throw new Error("send failed"); });
    const w = new Worker(q as any, dispatch, vi.fn());
    await w.tick();
    expect(q.markRetry).toHaveBeenCalledWith(1, expect.stringContaining("send failed"), backoffSeconds(2));
  });

  it("invokes onPermanentFailure when a job dead-letters", async () => {
    const failing = job({ kind: "outbound", attempts: 25 });
    const q = {
      claimNext: vi.fn(async () => failing),
      markDone: vi.fn(async () => {}),
      markRetry: vi.fn(async () => ({ status: "failed" as const, attempts: 25 })),
    };
    const onPermanentFailure = vi.fn(async () => {});
    const w = new Worker(q as any, vi.fn(async () => { throw new Error("boom-cause"); }), onPermanentFailure);
    await w.tick();
    // The dead-letter hook must receive the failing job AND the underlying error,
    // so the agent note can surface the real reason.
    expect(onPermanentFailure).toHaveBeenCalledWith(failing, expect.any(Error));
    expect(String((onPermanentFailure.mock.calls[0] as unknown[])[1])).toContain("boom-cause");
  });

  it("claims only its lane's kinds", async () => {
    const q = { claimNext: vi.fn(async () => null), markDone: vi.fn(), markRetry: vi.fn() };
    const w = new Worker(q as any, vi.fn(), vi.fn(), 250, undefined, ["outbound", "undo"]);
    await w.tick();
    expect(q.claimNext).toHaveBeenCalledWith(["outbound", "undo"]);
  });

  it("returns false when there is nothing to claim", async () => {
    const q = { claimNext: vi.fn(async () => null), markDone: vi.fn(), markRetry: vi.fn() };
    const w = new Worker(q as any, vi.fn(), vi.fn());
    expect(await w.tick()).toBe(false);
  });
});

describe("Worker.wake", () => {
  it("wake() processes a newly available job without waiting for the poll interval", async () => {
    const jobs: Job[] = [];
    let claimed = false;
    const q = {
      claimNext: vi.fn(async () => {
        if (!claimed && jobs.length > 0) { claimed = true; return jobs[0]; }
        return null;
      }),
      markDone: vi.fn(async () => {}),
      markRetry: vi.fn(async () => ({ status: "pending" as const, attempts: 1 })),
    };
    const dispatch = vi.fn(async () => {});
    const w = new Worker(q as any, dispatch, vi.fn(async () => {}), 10_000); // 10s poll
    w.start();
    await new Promise((r) => setTimeout(r, 20)); // let it go idle (queue empty)
    jobs.push(job({ id: 1, kind: "inbound", attempts: 0 }));
    w.wake();
    await new Promise((r) => setTimeout(r, 50)); // far less than the 10s poll
    w.stop();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
