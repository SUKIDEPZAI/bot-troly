import pg from 'pg';
import { encrypt, decrypt, looksEncrypted, isLegacyCiphertext } from './crypto.js';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // PGSSL_REJECT_UNAUTHORIZED=true (+ PGSSL_CA nếu cần) để xác thực chứng chỉ; mặc định false để tương thích Render/DB managed.
  ssl: String(process.env.PGSSL ?? 'true') === 'true'
    ? { rejectUnauthorized: String(process.env.PGSSL_REJECT_UNAUTHORIZED ?? 'false') === 'true', ...(process.env.PGSSL_CA ? { ca: process.env.PGSSL_CA.replace(/\\n/g, '\n') } : {}) }
    : false,
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
  // Schema cũ có thể còn cột lạ (vd. api_key_enc) mang NOT NULL mà code hiện tại không ghi → INSERT bị từ chối.
  await relaxLegacyColumns('ai_providers', ['id', 'name']);
  await relaxLegacyColumns('ai_models', ['id', 'provider', 'name']);
  await relaxLegacyColumns('ai_settings', ['key', 'value']);
  await pool.query(`UPDATE ai_providers SET base_url='' WHERE base_url IS NULL`);
  await pool.query(`UPDATE ai_providers SET created_at=COALESCE(created_at,NOW()), updated_at=COALESCE(updated_at,NOW())`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      day DATE NOT NULL DEFAULT CURRENT_DATE,
      provider TEXT NOT NULL,
      ok_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      total_latency_ms BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (day, provider)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_models_enabled_idx ON ai_models(enabled, hidden)`);

  await migrateKeyEncryption();

  // Các setting mặc định mới. Không ghi đè cấu hình người dùng.
  await setDefaultSetting('free_first', 'true');
  await setDefaultSetting('auto_route_enabled', 'true');
  await setDefaultSetting('council_enabled', 'true');
  await setDefaultSetting('council_judge', 'true');
  await setDefaultSetting('persona', 'default');
}

async function setDefaultSetting(key, value) {
  await pool.query(`INSERT INTO ai_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING`, [key, value]);
}

let warnedDecrypt = false;
function safeDecrypt(value) {
  if (!value) return '';
  try { return decrypt(value); }
  catch {
    // Dữ liệu cũ lưu plaintext → dùng nguyên. Nếu là ciphertext của bot nhưng giải mã lỗi
    // (đổi AI_SECRET_KEY) thì trả rỗng, KHÔNG gửi ciphertext đi như một API key.
    if (looksEncrypted(value)) {
      if (!warnedDecrypt) { warnedDecrypt = true; console.error('❌ Không giải mã được API key trong DB — AI_SECRET_KEY đã đổi? Hãy nhập lại API key trong /admin.'); }
      return '';
    }
    return String(value);
  }
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ai_models WHERE lower(provider)=lower($1)', [name]);
    await client.query('DELETE FROM ai_providers WHERE lower(name)=lower($1)', [name]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
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
  `, [name, String(message || 'Unknown error').replace(/\s+/g, ' ').slice(0, 300), Math.max(1000, cooldownMs)]).catch(() => {});
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

/** Upsert hàng loạt model của một provider (1 query thay vì N). Không đụng enabled/hidden do admin đặt. */
export async function addModelsBulk(provider, models) {
  if (!models?.length) return 0;
  const col = f => models.map(m => f(m));
  await pool.query(`
    INSERT INTO ai_models(provider,name,free,enabled,description,tier,context_length,capabilities,hidden)
    SELECT $1, x.name, x.free, TRUE, x.description, x.tier, x.context_length, x.capabilities, FALSE
    FROM unnest($2::text[],$3::boolean[],$4::text[],$5::int[],$6::int[],$7::text[])
      AS x(name,free,description,tier,context_length,capabilities)
    ON CONFLICT(provider,name) DO UPDATE SET
      free=EXCLUDED.free,
      tier=EXCLUDED.tier,
      context_length=COALESCE(EXCLUDED.context_length, ai_models.context_length),
      capabilities=CASE WHEN EXCLUDED.capabilities='' THEN ai_models.capabilities ELSE EXCLUDED.capabilities END,
      description=CASE WHEN EXCLUDED.description='' THEN ai_models.description ELSE EXCLUDED.description END
  `, [
    provider,
    col(m => String(m.name)),
    col(m => Boolean(m.free)),
    col(m => String(m.description || '').slice(0, 300)),
    col(m => Number(m.tier) || 2),
    col(m => (Number.isFinite(Number(m.context)) && Number(m.context) > 0 && Number(m.context) < 2_000_000_000 ? Math.round(Number(m.context)) : null)),
    col(m => String(m.capabilities || ''))
  ]);
  return models.length;
}

export async function recordUsage(provider, ok, latencyMs = 0) {
  await pool.query(`
    INSERT INTO ai_usage(day,provider,ok_count,fail_count,total_latency_ms)
    VALUES(CURRENT_DATE,$1,$2,$3,$4)
    ON CONFLICT(day,provider) DO UPDATE SET
      ok_count=ai_usage.ok_count+EXCLUDED.ok_count,
      fail_count=ai_usage.fail_count+EXCLUDED.fail_count,
      total_latency_ms=ai_usage.total_latency_ms+EXCLUDED.total_latency_ms
  `, [provider, ok ? 1 : 0, ok ? 0 : 1, Math.max(0, Math.round(latencyMs))]).catch(() => {});
}

export async function usageSummary(days = 7) {
  const { rows } = await pool.query(`
    SELECT provider, SUM(ok_count)::int AS ok, SUM(fail_count)::int AS fail,
           CASE WHEN SUM(ok_count)>0 THEN ROUND(SUM(total_latency_ms)::numeric/SUM(ok_count))::int ELSE NULL END AS avg_ms
    FROM ai_usage WHERE day >= CURRENT_DATE - ($1::int - 1)
    GROUP BY provider ORDER BY SUM(ok_count+fail_count) DESC
  `, [days]);
  return rows;
}

export async function setSettings(obj) {
  for (const [k, v] of Object.entries(obj)) await setSetting(k, v);
}

export async function closeDb() { await pool.end().catch(() => {}); }

/** Nâng cấp key cũ (SHA-256 hoặc plaintext) lên định dạng v2 (scrypt). Lỗi từng dòng không làm hỏng khởi động. */
async function migrateKeyEncryption() {
  const { rows } = await pool.query(`SELECT id, api_key_encrypted FROM ai_providers WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted <> '' AND api_key_encrypted NOT LIKE 'v2.%'`);
  let migrated = 0;
  for (const r of rows) {
    try {
      const v = r.api_key_encrypted;
      const plain = isLegacyCiphertext(v) ? decrypt(v) : (looksEncrypted(v) ? null : String(v));
      if (!plain) continue;
      const res = await pool.query('UPDATE ai_providers SET api_key_encrypted=$1 WHERE id=$2 AND api_key_encrypted=$3', [encrypt(plain), r.id, v]);
      migrated += res.rowCount || 0;
    } catch { /* không giải mã được (đổi AI_SECRET_KEY) → giữ nguyên */ }
  }
  if (migrated) console.log(`🔐 Đã nâng cấp mã hóa (scrypt) cho ${migrated} API key.`);
}

/** Kiểm tra DB còn sống (timeout 3s) — dùng cho /health. */
export async function pingDb(timeoutMs = 3000) {
  let timer;
  try {
    await Promise.race([pool.query('SELECT 1'), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('DB ping timeout')), timeoutMs); })]);
    return true;
  } finally { clearTimeout(timer); }
}

/** Gỡ NOT NULL của mọi cột không có DEFAULT và không thuộc schema hiện tại (cột legacy), để INSERT của bot luôn hợp lệ. */
async function relaxLegacyColumns(table, keep) {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL`, [table]);
  for (const { column_name: col } of rows) {
    if (keep.includes(col)) continue;
    try {
      await pool.query(`ALTER TABLE ${table} ALTER COLUMN "${String(col).replace(/"/g, '""')}" DROP NOT NULL`);
      console.log(`🛠 Đã gỡ NOT NULL của cột legacy ${table}.${col}`);
    } catch (err) { console.warn(`⚠️ Không gỡ được NOT NULL của ${table}.${col}: ${err?.message || err}`); }
  }
}
