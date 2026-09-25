-- All objects live in a dedicated schema so the shared database stays untouched.
CREATE SCHEMA IF NOT EXISTS image_moderation;

CREATE TABLE IF NOT EXISTS image_moderation.policies (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- { "<category>": { "review": 0.4, "reject": 0.85 } }
  thresholds  jsonb NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS policies_single_default
  ON image_moderation.policies (is_default) WHERE is_default;

CREATE TABLE IF NOT EXISTS image_moderation.images (
  id              uuid PRIMARY KEY,
  -- awaiting_upload -> pending -> approved | rejected | needs_review
  status          text NOT NULL CHECK (status IN
                    ('awaiting_upload', 'pending', 'approved', 'rejected', 'needs_review', 'failed')),
  policy_id       text NOT NULL REFERENCES image_moderation.policies (id),
  incoming_path   text NOT NULL,
  blob_path       text,
  content_type    text,
  bytes_original  integer,
  bytes_stored    integer,
  width           integer,
  height          integer,
  sha256          text,
  exif_removed    boolean,
  uploader_hash   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  uploaded_at     timestamptz,
  decided_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS images_status_created
  ON image_moderation.images (status, created_at DESC);

CREATE TABLE IF NOT EXISTS image_moderation.jobs (
  id              uuid PRIMARY KEY,
  image_id        uuid NOT NULL UNIQUE REFERENCES image_moderation.images (id) ON DELETE CASCADE,
  -- queued -> processing -> completed
  --                      -> retrying -> processing ...
  --                      -> dead_letter
  status          text NOT NULL CHECK (status IN
                    ('queued', 'processing', 'retrying', 'completed', 'dead_letter')),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 4,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  last_error      text,
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  last_enqueue_at timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Supports the SKIP LOCKED sweeper that picks up due or abandoned work.
CREATE INDEX IF NOT EXISTS jobs_due
  ON image_moderation.jobs (next_attempt_at)
  WHERE status IN ('queued', 'retrying', 'processing');

CREATE TABLE IF NOT EXISTS image_moderation.moderation_results (
  image_id        uuid PRIMARY KEY REFERENCES image_moderation.images (id) ON DELETE CASCADE,
  job_id          uuid NOT NULL REFERENCES image_moderation.jobs (id) ON DELETE CASCADE,
  model           text NOT NULL,
  scores          jsonb NOT NULL,
  labels          jsonb NOT NULL,
  decision        text NOT NULL CHECK (decision IN ('approved', 'rejected', 'needs_review')),
  reasons         jsonb NOT NULL,
  policy_id       text NOT NULL,
  policy_version  integer NOT NULL,
  policy_snapshot jsonb NOT NULL,
  inference_ms    integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS image_moderation.audit_log (
  id           bigserial PRIMARY KEY,
  image_id     uuid REFERENCES image_moderation.images (id) ON DELETE SET NULL,
  actor        text NOT NULL,
  action       text NOT NULL,
  from_status  text,
  to_status    text,
  note         text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_image ON image_moderation.audit_log (image_id, created_at);
CREATE INDEX IF NOT EXISTS audit_log_created ON image_moderation.audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS image_moderation.rate_limits (
  bucket        text NOT NULL,
  window_start  timestamptz NOT NULL,
  hits          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
