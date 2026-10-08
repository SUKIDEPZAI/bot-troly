// Trí nhớ hội thoại ngắn hạn theo kênh (RAM, có TTL) — chỉ lưu tin bot đã xử lý.
import { envInt } from './utils.js';

const TURNS = envInt('HISTORY_TURNS', 8, 0, 30);
const TTL = envInt('HISTORY_TTL_MS', 20 * 60_000, 10_000);
const SCOPE = String(process.env.HISTORY_SCOPE || 'user').toLowerCase() === 'channel' ? 'channel' : 'user';
const MAX_CHARS = 6000;
const MAX_CHANNELS = 500;
const store = new Map(); // channelId → { at, items:[{role,content}] }

function trim(items) {
  const keep = [];
  let chars = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    chars += items[i].content.length;
    if (chars > MAX_CHARS || keep.length >= TURNS * 2) break;
    keep.unshift(items[i]);
  }
  while (keep.length && keep[0].role !== 'user') keep.shift();
  return keep;
}

/** Mặc định mỗi (kênh, người dùng) có trí nhớ riêng → người sau không nhận ngữ cảnh của người trước. HISTORY_SCOPE=channel để dùng chung theo kênh. */
export const historyKey = (channelId, userId) => (SCOPE === 'channel' ? String(channelId) : `${channelId}:${userId}`);

export function getHistory(channelId, now = Date.now()) {
  const h = store.get(channelId);
  if (!h) return [];
  if (now - h.at > TTL) { store.delete(channelId); return []; }
  return h.items.map(x => ({ ...x }));
}

export function addTurn(channelId, userContent, assistantContent, now = Date.now()) {
  if (!TURNS) return;
  const h = store.get(channelId) && now - store.get(channelId).at <= TTL ? store.get(channelId) : { at: now, items: [] };
  h.items.push({ role: 'user', content: String(userContent).slice(0, 2500) }, { role: 'assistant', content: String(assistantContent).slice(0, 2500) });
  h.items = trim(h.items); h.at = now;
  store.set(channelId, h);
  if (store.size > MAX_CHANNELS) for (const [k, v] of store) if (now - v.at > TTL) store.delete(k);
}

export const clearHistory = (channelId, userId) => store.delete(historyKey(channelId, userId));
export const historySize = () => store.size;
