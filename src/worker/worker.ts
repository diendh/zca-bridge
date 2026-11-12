import type { Job, JobKind, JobQueueRepo } from "../store/jobQueueRepo.js";

const BASE_SECONDS = 1;
const CAP_SECONDS = 300;

export function backoffSeconds(attempts: number): number {
  return Math.min(CAP_SECONDS, BASE_SECONDS * 2 ** attempts);
}

export type DispatchFn = (job: Job) => Promise<void>;
export type PermanentFailureFn = (job: Job, error: unknown) => Promise<void>;

export class Worker {
  private running = false;
  private wakeSignal: (() => void) | null = null;
  private pendingWake = false;

  constructor(
    private queue: Pick<JobQueueRepo, "claimNext" | "markDone" | "markRetry">,
    private dispatch: DispatchFn,
    private onPermanentFailure: PermanentFailureFn,
    private pollIntervalMs = 250,
    private log: { error: (obj: unknown, msg?: string) => void } = { error: () => {} },
    private kinds?: JobKind[] // lane: only claim these kinds (all kinds when omitted)
  ) {}

  /** Interrupt the idle wait so a freshly enqueued job is claimed without waiting for the poll. */
  wake(): void {
    if (this.wakeSignal) {
      const signal = this.wakeSignal;
      this.wakeSignal = null;
      signal();
    } else {
      this.pendingWake = true; // wake arrived while not idling; consume on next idle()
    }
  }

  // Idle until the poll interval elapses or wake() is called.
  private idle(): Promise<void> {
    if (this.pendingWake) { this.pendingWake = false; return Promise.resolve(); }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.wakeSignal = null; resolve(); }, this.pollIntervalMs);
      this.wakeSignal = () => { clearTimeout(timer); resolve(); };
    });
  }

  /** Process at most one job. Returns true if a job was processed, false if the queue was empty. */
  async tick(): Promise<boolean> {
    const job = await this.queue.claimNext(this.kinds);
    if (!job) return false;
    try {
      await this.dispatch(job);
      await this.queue.markDone(job.id);
    } catch (err) {
      const res = await this.queue.markRetry(
        job.id,
        String(err instanceof Error ? err.stack ?? err.message : err),
        backoffSeconds(job.attempts)
      );
      if (res.status === "failed") {
        try { await this.onPermanentFailure(job, err); } catch { /* never let the failure hook crash the loop */ }
      }
    }
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async (): Promise<void> => {
      while (this.running) {
        let processed = false;
        try { processed = await this.tick(); } catch (err) { this.log.error({ err }, "worker tick error"); }
        if (!processed) await this.idle();
      }
    };
    void loop();
  }

  stop(): void { this.running = false; this.wake(); }
}
