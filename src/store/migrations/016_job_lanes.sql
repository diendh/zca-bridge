-- Concurrent inbound workers: lane_key ("<accountId>:<threadId>") identifies the conversation a job
-- belongs to, so jobs of different threads run in parallel while one thread stays strictly ordered.
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS lane_key TEXT;

-- Backfill the backlog so pending jobs enqueued before this migration keep per-thread ordering.
UPDATE job_queue
   SET lane_key = (payload->>'accountId') || ':' || (payload->'msg'->>'threadId')
 WHERE kind = 'inbound' AND lane_key IS NULL AND status IN ('pending', 'processing')
   AND payload ? 'accountId' AND payload->'msg' ? 'threadId';

-- "Is this thread busy?" probe used by claimNext.
CREATE INDEX IF NOT EXISTS idx_job_queue_lane_busy ON job_queue (lane_key) WHERE status = 'processing';

-- Per-lane claim scan (kind filter + due time).
CREATE INDEX IF NOT EXISTS idx_job_queue_kind_runnable ON job_queue (kind, next_attempt_at)
  WHERE status IN ('pending', 'processing');
