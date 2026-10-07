import pg from 'pg';
import { encrypt, decrypt } from './crypto.js';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: String(process.env.PGSSL ?? 'true') === 'true' ? { rejectUnauthorized: false } : false,
  max: 8,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000,
  statement_timeout: 12000,
  query_timeout: 12000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 5000
});

pool.on('error', (err) => console.error('❌ PostgreSQL pool error:', err.message));

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_providers (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      base_url TEXT NOT NULL DEFAULT '',
      api_key_encrypted TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ai_models (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      free BOOLEAN NOT NULL DEFAULT TRUE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      description TEXT NOT NULL DEFAULT '',
      tier INTEGER NOT NULL DEFAULT 2,
      context_length INTEGER,
      capabilities TEXT NOT NULL DEFAULT '',
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(provider, name)
    );
    CREATE TABLE IF NOT EXISTS ai_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Migrations: giữ nguyên PostgreSQL cũ, không xóa dữ liệu.
  await pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS base_url TEXT`);
  await pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT`);
  await pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
  await pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  await pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS last_ok_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS last_error TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS fail_count INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS avg_latency_ms INTEGER`);

  await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS free BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS tier INTEGER NOT NULL DEFAULT 2`);
  await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS context_length INTEGER`);
  await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS capabilities TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);

  // Schema cũ từng dùng provider_id thay cho provider.
  const modelCols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ai_models'
  `);
  const modelNames = new Set(modelCols.rows.map(r => r.column_name));
  if (!modelNames.has('provider')) await pool.query(`ALTER TABLE ai_models ADD COLUMN provider TEXT`);
  if (modelNames.has('provider_id')) {
    await pool.query(`
      UPDATE ai_models m
      SET provider = p.name
      FROM ai_providers p
      WHERE (m.provider IS NULL OR m.provider='') AND m.provider_id = p.id
    `);
    await pool.query(`ALTER TABLE ai_models ALTER COLUMN provider_id DROP NOT NULL`).catch(() => {});
  }
  await pool.query(`UPDATE ai_models SET provider='' WHERE provider IS NULL`);
  await pool.query(`ALTER TABLE ai_models ALTER COLUMN provider SET NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ai_models_provider_name_uq ON ai_models(provider,name)`);
  await pool.query(`UPDATE ai_models SET tier=2 WHERE tier IS NULL OR tier < 1 OR tier > 3`);
  await pool.query(`UPDATE ai_models SET hidden=FALSE WHERE hidden IS NULL`);

  const providerCols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ai_providers'
  `);
  const providerNames = new Set(providerCols.rows.map(r => r.column_name));
  if (providerNames.has('api_key')) {
    await pool.query(`
      UPDATE ai_providers
      SET api_key_encrypted=api_key
      WHERE (api_key_encrypted IS NULL OR api_key_encrypted='') AND api_key IS NOT NULL
    `);
    await pool.query(`ALTER TABLE ai_providers ALTER COLUMN api_key DROP NOT NULL`).catch(() => {});
  }
  await pool.query(`UPDATE ai_providers SET base_url='' WHERE base_url IS NULL`);
  await pool.query(`UPDATE ai_providers SET created_at=COALESCE(created_at,NOW()), updated_at=COALESCE(updated_at,NOW())`);

  // Các setting mặc định mới. Không ghi đè cấu hình người dùng.
  await setDefaultSetting('free_first', 'true');
  await setDefaultSetting('auto_route_enabled', 'true');
  await setDefaultSetting('council_enabled', 'true');
}

async function setDefaultSetting(key, value) {
  await pool.query(`INSERT INTO ai_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING`, [key, value]);
}

function safeDecrypt(value) {
  if (!value) return '';
  try { return decrypt(value); }
  catch { return String(value); }
}

export async function listProviders() {
  const { rows } = await pool.query(`
    SELECT id,name,base_url,api_key_encrypted AS api_key,created_at,updated_at,
           last_ok_at,last_error,fail_count,cooldown_until,avg_latency_ms
    FROM ai_providers ORDER BY name
  `);
  return rows.map(r => ({ ...r, api_key: safeDecrypt(r.api_key) }));
}

export async function getProvider(name) {
  const { rows } = await pool.query(`
    SELECT id,name,base_url,api_key_encrypted,last_ok_at,last_error,fail_count,cooldown_until,avg_latency_ms
    FROM ai_providers WHERE lower(name)=lower($1) LIMIT 1
  `, [name]);
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    name: rows[0].name,
    base_url: rows[0].base_url,
    api_key: safeDecrypt(rows[0].api_key_encrypted),
    last_ok_at: rows[0].last_ok_at,
    last_error: rows[0].last_error || '',
    fail_count: Number(rows[0].fail_count || 0),
    cooldown_until: rows[0].cooldown_until,
    avg_latency_ms: rows[0].avg_latency_ms == null ? null : Number(rows[0].avg_latency_ms)
  };
}

export async function getSecret(name) { return (await getProvider(name))?.api_key || ''; }

export async function upsertProvider({ name, apiKey, baseUrl }) {
  const encrypted = encrypt(apiKey);
  await pool.query(`
    INSERT INTO ai_providers(name,base_url,api_key_encrypted,updated_at)
    VALUES($1,$2,$3,NOW())
    ON CONFLICT(name) DO UPDATE SET
      base_url=EXCLUDED.base_url,
      api_key_encrypted=EXCLUDED.api_key_encrypted,
      updated_at=NOW(),
      last_error='', fail_count=0, cooldown_until=NULL
  `, [name, baseUrl, encrypted]);
}

export async function deleteProvider(name) {
  await pool.query('DELETE FROM ai_models WHERE lower(provider)=lower($1)', [name]);
  await pool.query('DELETE FROM ai_providers WHERE lower(name)=lower($1)', [name]);
}

export async function listModels(provider = null, includeHidden = false) {
  if (provider) {
    const q = includeHidden
      ? await pool.query(`SELECT id,provider,name,free,enabled,description,tier,context_length,capabilities,hidden,created_at FROM ai_models WHERE lower(provider)=lower($1) ORDER BY tier,name`, [provider])
      : await pool.query(`SELECT id,provider,name,free,enabled,description,tier,context_length,capabilities,hidden,created_at FROM ai_models WHERE lower(provider)=lower($1) AND hidden=FALSE ORDER BY tier,name`, [provider]);
    return q.rows;
  }
  const q = includeHidden
    ? await pool.query(`SELECT id,provider,name,free,enabled,description,tier,context_length,capabilities,hidden,created_at FROM ai_models ORDER BY provider,tier,name`)
    : await pool.query(`SELECT id,provider,name,free,enabled,description,tier,context_length,capabilities,hidden,created_at FROM ai_models WHERE hidden=FALSE ORDER BY provider,tier,name`);
  return q.rows;
}

export async function addModel({ provider, name, free = true, description = '', tier = 2, contextLength = null, capabilities = '', hidden = false }) {
  const { rows } = await pool.query(`
    INSERT INTO ai_models(provider,name,free,enabled,description,tier,context_length,capabilities,hidden)
    VALUES($1,$2,$3,TRUE,$4,$5,$6,$7,$8)
    ON CONFLICT(provider,name) DO UPDATE SET
      free=EXCLUDED.free,
      tier=EXCLUDED.tier,
      context_length=COALESCE(EXCLUDED.context_length, ai_models.context_length),
      capabilities=CASE WHEN EXCLUDED.capabilities='' THEN ai_models.capabilities ELSE EXCLUDED.capabilities END,
      hidden=EXCLUDED.hidden,
      description=CASE WHEN EXCLUDED.description='' THEN ai_models.description ELSE EXCLUDED.description END
    RETURNING *
  `, [provider, name, free, description, tier, contextLength, capabilities, hidden]);
  return rows[0];
}

export async function toggleModel(id) {
  const { rows } = await pool.query(`UPDATE ai_models SET enabled=NOT enabled WHERE id=$1 RETURNING *`, [id]);
  return rows[0] || null;
}

export async function recordProviderSuccess(name, latencyMs) {
  await pool.query(`
    UPDATE ai_providers
    SET last_ok_at=NOW(),last_error='',fail_count=0,cooldown_until=NULL,
        avg_latency_ms=CASE WHEN avg_latency_ms IS NULL THEN $2 ELSE ROUND(avg_latency_ms*0.7 + $2*0.3)::INT END,
        updated_at=NOW()
    WHERE lower(name)=lower($1)
  `, [name, Math.max(0, Math.round(latencyMs || 0))]).catch(() => {});
}

export async function recordProviderFailure(name, message, cooldownMs = 30000) {
  await pool.query(`
    UPDATE ai_providers
    SET last_error=$2,fail_count=LEAST(fail_count+1,20),cooldown_until=NOW()+($3 * INTERVAL '1 millisecond'),updated_at=NOW()
    WHERE lower(name)=lower($1)
  `, [name, String(message || 'Unknown error').slice(0,1000), Math.max(1000, cooldownMs)]).catch(() => {});
}

export async function getRoutingState() {
  const [providers, models] = await Promise.all([listProviders(), listModels()]);
  return { providers, models };
}

export async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM ai_settings WHERE key=$1', [key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(key, value) {
  await pool.query(`
    INSERT INTO ai_settings(key,value,updated_at)
    VALUES($1,$2,NOW())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()
  `, [key, String(value)]);
}
