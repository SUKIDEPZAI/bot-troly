// Đồng bộ danh mục model từ API provider vào DB (có negative-cache để không gọi lặp khi provider đang lỗi).
import { addModelsBulk, listProviders } from './db.js';
import { listRemoteModels } from './providers.js';

const lastAttempt = new Map(); // provider → timestamp
const MIN_GAP_MS = 60_000;
const MAX_MODELS = 150;

export async function syncProviderModels(providerName, { force = false } = {}) {
  const name = String(providerName).toLowerCase();
  if (!force && Date.now() - (lastAttempt.get(name) || 0) < MIN_GAP_MS) return [];
  lastAttempt.set(name, Date.now());
  try {
    const remote = await listRemoteModels(name, { force });
    // Lưu theo chất lượng giảm dần để model mạnh không bị cắt khi vượt giới hạn.
    const picked = [...remote].sort((a, b) => b.tier - a.tier || Number(b.free) - Number(a.free)).slice(0, MAX_MODELS);
    await addModelsBulk(name, picked);
    return picked;
  } catch (err) {
    console.warn(`⚠️ Đồng bộ model ${name} lỗi: ${err?.message || err}`);
    return [];
  }
}

export async function syncAllProviders(opts) {
  const ps = (await listProviders()).filter(p => p.api_key);
  const res = await Promise.allSettled(ps.map(p => syncProviderModels(p.name, opts)));
  return res.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value.length : 0), 0);
}
