import postgres, { type Sql } from 'postgres';

/**
 * Postgres client. On Vercel use the *transaction-mode* pooled connection string
 * (Supabase: port 6543, not the 5432 session pooler; Neon: the "-pooler" host).
 *
 * Every serverless instance gets its own pool, and the instances don't share connections.
 * We keep each instance to one connection and close idle ones quickly so concurrent
 * instances don't use up the pooler's client limit (EMAXCONNSESSION / "max clients reached").
 */
const serverless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

function createClient(): Sql {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Add a Postgres connection string to your environment.');
  warnIfSessionPooler(url);
  return postgres(url, {
    max: Number(process.env.DB_POOL_MAX) || (serverless ? 1 : 5),
    idle_timeout: serverless ? 5 : 20,
    connect_timeout: 15,
    prepare: false, // required for transaction-mode poolers (PgBouncer, Supabase, Neon pooler)
    onnotice: () => {},
  });
}

/** Supabase's session-mode pooler (port 5432) gives each client a dedicated slot, which serverless traffic runs out of quickly. */
function warnIfSessionPooler(url: string) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('.pooler.supabase.com') && (u.port || '5432') === '5432') {
      console.warn(
        '[db] DATABASE_URL uses the Supabase *session* pooler (port 5432). On serverless this hits ' +
          '"max clients reached" — switch to the transaction pooler URL (port 6543).',
      );
    }
  } catch {
    /* not a parseable URL; postgres() will report it */
  }
}

// Reuse one client across hot reloads (dev) and invocations of a warm serverless instance.
const g = globalThis as unknown as { __cfSql?: Sql; __cfSchema?: Promise<void> };

function client(): Sql {
  return (g.__cfSql ??= createClient());
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL
  );

  CREATE TABLE IF NOT EXISTS searches (
    id           SERIAL PRIMARY KEY,
    linkedin_url TEXT NOT NULL,
    status       TEXT NOT NULL,                 -- running | done | not_found | error
    stop_when    TEXT NOT NULL,
    full_name    TEXT,
    headline     TEXT,
    emails       JSONB NOT NULL DEFAULT '[]',
    phones       JSONB NOT NULL DEFAULT '[]',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_searches_url ON searches (linkedin_url);
  CREATE INDEX IF NOT EXISTS idx_searches_running ON searches (status) WHERE status = 'running';

  CREATE TABLE IF NOT EXISTS provider_results (
    id             SERIAL PRIMARY KEY,
    search_id      INT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
    provider       TEXT NOT NULL,
    position       INT NOT NULL,
    status         TEXT NOT NULL,               -- pending | running | waiting | found | not_found | error | timeout | skipped
    message        TEXT,
    emails         JSONB NOT NULL DEFAULT '[]',
    phones         JSONB NOT NULL DEFAULT '[]',
    person         JSONB,
    raw            JSONB,
    credits_left   INT,
    duration_ms    INT,
    started_at     TIMESTAMPTZ,
    deadline_at    TIMESTAMPTZ,                 -- when a 'waiting' step gives up on its callback
    callback_token TEXT UNIQUE,
    UNIQUE (search_id, provider)
  );
  CREATE INDEX IF NOT EXISTS idx_pr_search ON provider_results (search_id);

  -- Several API keys per provider, tried in position order with automatic failover.
  CREATE TABLE IF NOT EXISTS api_keys (
    id                 SERIAL PRIMARY KEY,
    provider           TEXT NOT NULL,
    label              TEXT NOT NULL,
    api_key            TEXT NOT NULL,
    position           INT NOT NULL DEFAULT 0,
    enabled            BOOLEAN NOT NULL DEFAULT true,
    credits            INT,                     -- last known remaining credits (credit check / response header)
    credits_checked_at TIMESTAMPTZ,
    last_error_code    TEXT,                    -- NO_CREDITS, INVALID_API_KEY, RATE_LIMITED, ...
    last_error_at      TIMESTAMPTZ,
    last_used_at       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, api_key)
  );
  CREATE INDEX IF NOT EXISTS idx_keys_provider ON api_keys (provider, position);

  ALTER TABLE provider_results ADD COLUMN IF NOT EXISTS api_key_id INT REFERENCES api_keys(id) ON DELETE SET NULL;
  ALTER TABLE provider_results ADD COLUMN IF NOT EXISTS api_key_label TEXT;

  -- One-time migration: single 'apiKey' stored in settings (v2.0) -> api_keys rows.
  INSERT INTO api_keys (provider, label, api_key, position)
    SELECT p->>'id', 'Key 1', p->>'apiKey', 0
    FROM settings s, jsonb_array_elements(s.value) p
    WHERE s.key = 'providers' AND jsonb_typeof(s.value) = 'array' AND coalesce(p->>'apiKey', '') <> ''
  ON CONFLICT (provider, api_key) DO NOTHING;
  UPDATE settings SET value = (SELECT jsonb_agg(p - 'apiKey') FROM jsonb_array_elements(value) p)
    WHERE key = 'providers' AND jsonb_typeof(value) = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(value) p WHERE p ? 'apiKey');
`;

/** Returns the client, creating tables on first use (idempotent, safe under concurrent cold starts). */
export async function db(): Promise<Sql> {
  const sql = client();
  g.__cfSchema ??= sql
    .begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(724361001)`;
      await tx.unsafe(SCHEMA);
    })
    .then(() => undefined)
    .catch((err) => {
      g.__cfSchema = undefined; // retry on next request
      throw err;
    });
  await g.__cfSchema;
  return sql;
}

/**
 * Value for a JSONB parameter: ${jsonb(x)}::jsonb
 * postgres v4 serialises by the type the server asks for, so pass the value itself —
 * a pre-stringified value would be stored as a JSON *string*.
 */
export const jsonb = (v: unknown) => (v === undefined || v === null ? null : (v as any));

/** Close the pool (tests / scripts). */
export async function closeDb() {
  await g.__cfSql?.end({ timeout: 5 });
  g.__cfSql = undefined;
  g.__cfSchema = undefined;
}
