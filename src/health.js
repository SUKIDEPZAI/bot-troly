// Theo dõi sức khỏe provider/model trong bộ nhớ (áp dụng NGAY, không đợi cache DB 5s).
import { isTransientError } from './providers.js';

const providerUntil = new Map();
const modelUntil = new Map();
const key = (p, m) => `${String(p).toLowerCase()}::${m}`;

export const isProviderCooling = (p, now = Date.now()) => (providerUntil.get(String(p).toLowerCase()) || 0) > now;
export const isModelCooling = (p, m, now = Date.now()) => (modelUntil.get(key(p, m)) || 0) > now;
export function coolProvider(p, ms, now = Date.now()) { providerUntil.set(String(p).toLowerCase(), now + ms); }
export function coolModel(p, m, ms, now = Date.now()) { modelUntil.set(key(p, m), now + ms); }
export function clearHealth() { providerUntil.clear(); modelUntil.clear(); }
export const cooldownLeft = p => Math.max(0, (providerUntil.get(String(p).toLowerCase()) || 0) - Date.now());

/**
 * Phân loại lỗi để quyết định phạm vi cooldown:
 *  - 401            → provider (key sai/hết hạn): nghỉ lâu
 *  - 429/5xx/timeout/mạng → provider: backoff theo số lần lỗi liên tiếp
 *  - 400/403/404    → chỉ riêng model đó (model bị xóa/không có quyền) — provider vẫn dùng được
 */
export function classifyFailure(err, failCount = 0) {
  const status = Number(err?.status || 0);
  if (status === 401) return { scope: 'provider', cooldownMs: 5 * 60_000, refreshCatalog: false };
  if (status === 404 || status === 403) return { scope: 'model', cooldownMs: 10 * 60_000, refreshCatalog: true };
  if (status === 400) return { scope: 'model', cooldownMs: 2 * 60_000, refreshCatalog: false };
  if (isTransientError(err)) {
    const base = status === 429 ? 20_000 : 10_000;
    const ms = err?.retryAfterMs || Math.min(120_000, base * 2 ** Math.min(failCount, 3));
    return { scope: 'provider', cooldownMs: ms, refreshCatalog: false };
  }
  return { scope: 'model', cooldownMs: 60_000, refreshCatalog: false };
}
