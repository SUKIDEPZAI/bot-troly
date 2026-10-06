import pg from 'pg';
import { config } from './config.js';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.db.url,
  ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

let dbReady = false;
let lastDbError = null;
const dbEnabled = () => Boolean(config.db.url && dbReady);

async function safeQuery(text, params = []) {
  if (!config.db.url || !dbReady) return null;
  try {
    return await pool.query(text, params);
  } catch (err) {
    lastDbError = String(err?.message || err);
    return null;
  }
}

export async function initDb() {
  if (!config.db.url) return false;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY, username TEXT, first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS channels (
        channel_id TEXT PRIMARY KEY, guild_id TEXT, channel_name TEXT, last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY, channel_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS memories (
        id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, memory TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS ai_runs (
        id BIGSERIAL PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, intent TEXT, difficulty INTEGER, ok BOOLEAN NOT NULL, latency_ms INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ai_runs_provider_time ON ai_runs(provider, created_at DESC);
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY, preferred_language TEXT, communication_style TEXT, last_intent TEXT, preferences JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    dbReady = true;
    lastDbError = null;
    return true;
  } catch (err) {
    dbReady = false;
    lastDbError = String(err?.message || err);
    console.warn(`[db] Database unavailable; bot will run without persistence: ${lastDbError}`);
    return false;
  }
}

export function dbStatus() { return { configured: Boolean(config.db.url), ready: dbReady, lastError: lastDbError }; }

export async function saveUser(user) {
  await safeQuery(`INSERT INTO users(user_id, username) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET username=EXCLUDED.username, last_seen=NOW()`, [user.id, user.username]);
}
export async function saveChannel(channel) {
  await safeQuery(`INSERT INTO channels(channel_id, guild_id, channel_name) VALUES($1,$2,$3) ON CONFLICT(channel_id) DO UPDATE SET channel_name=EXCLUDED.channel_name, last_seen=NOW()`, [channel.id, channel.guild?.id || 'dm', channel.name || 'dm']);
}
export async function saveMessage(channelId, userId, role, content) {
  await safeQuery('INSERT INTO messages(channel_id,user_id,role,content) VALUES($1,$2,$3,$4)', [channelId,userId,role,String(content).slice(0,16000)]);
}
export async function getRecentMessages(channelId, limit) {
  const result = await safeQuery('SELECT role, content FROM messages WHERE channel_id=$1 ORDER BY created_at DESC LIMIT $2', [channelId, limit]);
  return result?.rows?.reverse() || [];
}
export async function addMemory(userId, memory) {
  if (!memory?.trim()) return;
  await safeQuery('INSERT INTO memories(user_id,memory) VALUES($1,$2)', [userId, memory.slice(0,2000)]);
}
export async function getMemories(userId, limit=8) {
  const result = await safeQuery('SELECT memory FROM memories WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [userId, limit]);
  return result?.rows?.map(r => r.memory) || [];
}
export async function saveAiRun(run) {
  await safeQuery('INSERT INTO ai_runs(provider,model,intent,difficulty,ok,latency_ms) VALUES($1,$2,$3,$4,$5,$6)', [run.provider, run.model, run.intent, run.difficulty, run.ok, run.latencyMs]);
}
export async function getProviderStats(name) {
  const result = await safeQuery(`SELECT provider, AVG(latency_ms)::int AS avg_latency, AVG(CASE WHEN ok THEN 1 ELSE 0 END) AS success_rate, COUNT(*)::int AS runs FROM ai_runs WHERE provider=$1 AND created_at > NOW() - INTERVAL '7 days' GROUP BY provider`, [name]);
  return result?.rows?.[0] || null;
}
export async function upsertUserProfile(userId, profile = {}) {
  await safeQuery(`INSERT INTO user_profiles(user_id, preferred_language, communication_style, last_intent, preferences) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(user_id) DO UPDATE SET preferred_language=COALESCE(EXCLUDED.preferred_language, user_profiles.preferred_language), communication_style=COALESCE(EXCLUDED.communication_style, user_profiles.communication_style), last_intent=COALESCE(EXCLUDED.last_intent, user_profiles.last_intent), preferences=user_profiles.preferences || EXCLUDED.preferences, updated_at=NOW()`, [userId, profile.language || null, profile.style || null, profile.intent || null, JSON.stringify(profile.preferences || {})]);
}
export async function getUserProfile(userId) {
  const result = await safeQuery('SELECT * FROM user_profiles WHERE user_id=$1', [userId]);
  return result?.rows?.[0] || null;
}

// Retry a failed startup connection without blocking Discord startup forever.
setInterval(async () => {
  if (config.db.url && !dbReady) await initDb();
}, 60000).unref();
