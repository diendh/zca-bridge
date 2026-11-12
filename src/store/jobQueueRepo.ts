import type { Pool } from "pg";

export type JobKind = "inbound" | "outbound" | "reaction" | "undo";
export type JobStatus = "pending" | "processing" | "done" | "failed";

export interface Job {
  id: number;
  kind: JobKind;
  dedupKey: string;
  payload: any;
  attempts: number;
  status: JobStatus;
}

const STALE_PROCESSING = "5 minutes";

interface Row {
  id: string;
  kind: JobKind;
  dedup_key: string;
  payload: any;
  attempts: number;
  status: JobStatus;
}

function toJob(r: Row): Job {
  return {
    id: Number(r.id),
    kind: r.kind,
    dedupKey: r.dedup_key,
    payload: r.payload,
    attempts: r.attempts,
    status: r.status,
  };
}

export class JobQueueRepo {
  constructor(private pool: Pool) {}

  /** Idempotent enqueue. Returns false if a job with the same (kind, dedup_key) already exists. */
  async enqueue(kind: JobKind, dedupKey: string, payload: unknown): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO job_queue (kind, dedup_key, payload) VALUES ($1, $2, $3)
       ON CONFLICT (kind, dedup_key) DO NOTHING`,
      [kind, dedupKey, JSON.stringify(payload)]
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Atomically claim one runnable job: a due 'pending' row, or a stale 'processing' row (crash recovery). */
  async claimNext(): Promise<Job | null> {
    const res = await this.pool.query<Row>(
      `UPDATE job_queue SET status = 'processing', attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM job_queue
         WHERE next_attempt_at <= now()
           AND (status = 'pending'
                OR (status = 'processing' AND updated_at < now() - interval '${STALE_PROCESSING}'))
         -- Human-facing jobs (agent replies, undos) jump ahead of the inbound firehose;
         -- otherwise a busy group feed delays outbound replies by minutes.
         ORDER BY CASE kind WHEN 'outbound' THEN 0 WHEN 'undo' THEN 0 WHEN 'reaction' THEN 1 ELSE 2 END, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, kind, dedup_key, payload, attempts, status`
    );
    return res.rows[0] ? toJob(res.rows[0]) : null;
  }

  async markDone(id: number): Promise<void> {
    await this.pool.query(
      "UPDATE job_queue SET status = 'done', updated_at = now() WHERE id = $1",
      [id]
    );
  }

  /** Mark for retry; transitions to 'failed' once attempts >= max_attempts. Returns the resulting status. */
  async markRetry(
    id: number,
    error: string,
    backoffSeconds: number
  ): Promise<{ status: JobStatus; attempts: number }> {
    const res = await this.pool.query<{ status: JobStatus; attempts: number }>(
      `UPDATE job_queue
       SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
           next_attempt_at = now() + ($2 || ' seconds')::interval,
           last_error = $3, updated_at = now()
       WHERE id = $1
       RETURNING status, attempts`,
      [id, String(backoffSeconds), error.slice(0, 2000)]
    );
    return res.rows[0] ?? { status: "failed", attempts: 0 };
  }

  async listFailed(): Promise<Job[]> {
    const res = await this.pool.query<Row>(
      "SELECT id, kind, dedup_key, payload, attempts, status FROM job_queue WHERE status = 'failed' ORDER BY id"
    );
    return res.rows.map(toJob);
  }
}
