import pg from 'pg';
import { encrypt, decrypt } from './crypto.js';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: String(process.env.PGSSL ?? 'true') === 'true' ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(provider, name)
    );
    CREATE TABLE IF NOT EXISTS ai_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Migration cho các bản cũ: trước đây API key có thể nằm ở cột `api_key`.
  await pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS base_url TEXT`);
  await pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT`);
  await pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
  await pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`);

  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ai_providers'
  `);
  const names = new Set(cols.rows.map(r => r.column_name));
  if (names.has('api_key')) {
    // Giữ dữ liệu cũ; bản cũ của dự án cũng lưu giá trị đã mã hóa.
    await pool.query(`UPDATE ai_providers SET api_key_encrypted=api_key WHERE (api_key_encrypted IS NULL OR api_key_encrypted='') AND api_key IS NOT NULL`);
    // Cho phép bản mới ghi vào cột api_key_encrypted mà không bị NOT NULL của schema cũ.
    await pool.query(`ALTER TABLE ai_providers ALTER COLUMN api_key DROP NOT NULL`);
  }

  // Bổ sung các cột có thể thiếu từ những schema cũ hơn.
  await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS free BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
  await pool.query(`UPDATE ai_models SET created_at=COALESCE(created_at,NOW())`);

  await pool.query(`UPDATE ai_providers SET base_url='' WHERE base_url IS NULL`);
  await pool.query(`UPDATE ai_providers SET created_at=COALESCE(created_at,NOW()), updated_at=COALESCE(updated_at,NOW())`);
}

function safeDecrypt(value) {
  if (!value) return '';
  try { return decrypt(value); }
  catch {
    // Hỗ trợ trường hợp dữ liệu cũ là plaintext; sẽ được mã hóa lại khi cập nhật.
    return String(value);
  }
}

export async function listProviders() {
  const { rows } = await pool.query(`
    SELECT id,name,base_url,api_key_encrypted AS api_key,created_at,updated_at
    FROM ai_providers ORDER BY name
  `);
  return rows.map(r => ({ ...r, api_key: safeDecrypt(r.api_key) }));
}

export async function getProvider(name) {
  const { rows } = await pool.query(`
    SELECT id,name,base_url,api_key_encrypted
    FROM ai_providers WHERE lower(name)=lower($1) LIMIT 1
  `, [name]);
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    name: rows[0].name,
    base_url: rows[0].base_url,
    api_key: safeDecrypt(rows[0].api_key_encrypted)
  };
}

export async function getSecret(name) {
  const p = await getProvider(name);
  return p?.api_key || '';
}

export async function upsertProvider({ name, apiKey, baseUrl }) {
  const encrypted = encrypt(apiKey);
  await pool.query(`
    INSERT INTO ai_providers(name,base_url,api_key_encrypted,updated_at)
    VALUES($1,$2,$3,NOW())
    ON CONFLICT(name) DO UPDATE SET
      base_url=EXCLUDED.base_url,
      api_key_encrypted=EXCLUDED.api_key_encrypted,
      updated_at=NOW()
  `, [name, baseUrl, encrypted]);
}

export async function deleteProvider(name) {
  await pool.query('DELETE FROM ai_models WHERE lower(provider)=lower($1)', [name]);
  await pool.query('DELETE FROM ai_providers WHERE lower(name)=lower($1)', [name]);
}

export async function listModels(provider = null) {
  const q = provider
    ? await pool.query(`SELECT id,provider,name,free,enabled,description,created_at FROM ai_models WHERE lower(provider)=lower($1) ORDER BY name`, [provider])
    : await pool.query(`SELECT id,provider,name,free,enabled,description,created_at FROM ai_models ORDER BY provider,name`);
  return q.rows;
}

export async function addModel({ provider, name, free = true, description = '' }) {
  const { rows } = await pool.query(`
    INSERT INTO ai_models(provider,name,free,enabled,description)
    VALUES($1,$2,$3,TRUE,$4)
    ON CONFLICT(provider,name) DO UPDATE SET
      free=EXCLUDED.free,
      description=CASE WHEN EXCLUDED.description='' THEN ai_models.description ELSE EXCLUDED.description END
    RETURNING *
  `, [provider, name, free, description]);
  return rows[0];
}

export async function toggleModel(id) {
  const { rows } = await pool.query(`UPDATE ai_models SET enabled=NOT enabled WHERE id=$1 RETURNING *`, [id]);
  return rows[0] || null;
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
