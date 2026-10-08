// Cache cấu hình + helper kênh. Admin gọi invalidate() nên thay đổi có hiệu lực ngay.
import { getSetting, setSetting } from './db.js';

const CACHE_MS = 5000;
const cache = { value: null, expiresAt: 0, promise: null };
const bool = (v, d) => String(v ?? d) === 'true';

export function invalidateSettings() { cache.expiresAt = 0; cache.value = null; }

export async function getSettings(force = false) {
  if (!force && cache.value && cache.expiresAt > Date.now()) return cache.value;
  if (cache.promise) return cache.promise;
  cache.promise = (async () => {
    const [lock, allowed, provider, model, freeFirst, autoRoute, council, judge, persona] = await Promise.all([
      'channel_lock_enabled', 'allowed_channel_ids', 'default_provider', 'default_model',
      'free_first', 'auto_route_enabled', 'council_enabled', 'council_judge', 'persona'
    ].map(getSetting));
    let ids = [];
    try { ids = JSON.parse(allowed || '[]'); } catch { /* giữ [] */ }
    cache.value = {
      lockEnabled: bool(lock, 'false'),
      allowed: new Set(ids.map(String)),
      defaultProvider: provider || process.env.DEFAULT_PROVIDER || null,
      defaultModel: model || process.env.DEFAULT_MODEL || null,
      freeFirst: bool(freeFirst, 'true'),
      autoRoute: bool(autoRoute, 'true'),
      council: bool(council, 'true'),
      councilJudge: bool(judge, 'true'),
      persona: persona || 'default'
    };
    cache.expiresAt = Date.now() + CACHE_MS;
    return cache.value;
  })().finally(() => { cache.promise = null; });
  return cache.promise;
}

/** Cho phép nếu kênh được chọn, hoặc là thread nằm trong kênh được chọn. */
export function channelAllowedBy(settings, channel) {
  if (!settings.lockEnabled) return true;
  if (!channel) return false;
  return settings.allowed.has(String(channel.id)) || Boolean(channel.parentId && settings.allowed.has(String(channel.parentId)));
}

export async function toggleSetting(key, defaultValue = 'true') {
  const cur = String((await getSetting(key)) ?? defaultValue) === 'true';
  await setSetting(key, cur ? 'false' : 'true');
  invalidateSettings();
  return !cur;
}

export async function readAllowedIds() {
  try { return JSON.parse((await getSetting('allowed_channel_ids')) || '[]').map(String); } catch { return []; }
}
export async function writeAllowedIds(ids) {
  await setSetting('allowed_channel_ids', JSON.stringify([...new Set(ids.map(String))]));
  invalidateSettings();
}
