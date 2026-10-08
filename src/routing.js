// Logic định tuyến thuần (không I/O) → có thể test độc lập.
import { clamp } from './utils.js';

// \b của JS không hiểu chữ có dấu (đ, ộ, á…) nên dùng biên Unicode.
const words = (list, flags = 'iu') => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list})(?![\\p{L}\\p{N}])`, flags);
const RE = {
  tech: words('code|javascript|typescript|python|sql|api|debug|bug|lỗi|fix|source|project|github|render|postgres|discord\\.js|docker|regex|thuật toán'),
  analysis: words('phân tích|so sánh|thiết kế|kiến trúc|đánh giá|suy luận|chứng minh|nghiên cứu|chiến lược|tối ưu|hệ thống'),
  deep: words('từng bước|chi tiết|toàn bộ|nhiều phần|ít nhất \\d+|nâng cấp|sửa hàng loạt|step by step'),
  greet: words('hello|hi|hey|xin chào|chào|cảm ơn|thanks|ok|oke|ping')
};

export function difficulty(prompt) {
  const t = String(prompt || '').trim();
  let score = 0;
  if (t.length > 300) score += 2;
  if (t.length > 900) score += 2;
  if (/```/.test(t)) score += 2;
  if (RE.tech.test(t)) score += 2;
  if (RE.analysis.test(t)) score += 2;
  if (/[?？][\s\S]*[?？]/.test(t)) score += 1;
  if (RE.deep.test(t)) score += 2;
  if (t.split('\n').length > 8) score += 1;
  if (RE.greet.test(t) && t.length < 80) score -= 2;
  if (score <= 2) return { name: 'DỄ', tier: 1, score };
  if (score <= 5) return { name: 'TRUNG BÌNH', tier: 2, score };
  return { name: 'KHÓ', tier: 3, score };
}

export const providerCooling = (p, now = Date.now()) =>
  Boolean(p?.cooldown_until && new Date(p.cooldown_until).getTime() > now);

export function toCandidate(provider, model, settings) {
  const name = String(provider.name).toLowerCase();
  return {
    provider: name,
    model: model.name,
    tier: clamp(Number(model.tier || 2), 1, 3),
    free: Boolean(model.free),
    contextLength: Number(model.context_length || 0),
    latency: Number(provider.avg_latency_ms || 5000),
    failCount: Number(provider.fail_count || 0),
    defaultMatch: settings.defaultProvider?.toLowerCase() === name && settings.defaultModel === model.name
  };
}

export function routeScore(c, targetTier, settings) {
  let s = Math.abs(c.tier - targetTier) * 5;
  if (settings.freeFirst && c.free) s -= 2;
  if (c.defaultMatch) s -= 3;
  s += Math.min(c.latency, 12000) / 6000;
  s += Math.min(c.failCount, 5) * 2;
  if (targetTier === 3 && c.tier < 3) s += 2;
  if (targetTier === 1 && c.tier > 1) s += 1;
  return s;
}

/** Danh sách ứng viên đã lọc (key hợp lệ, không cooldown, model bật & không ẩn) và xếp theo điểm tăng dần. */
export function rankCandidates({ providers, models, settings, tier = 2, modelCooling = () => false, providerCoolingFn = providerCooling, now = Date.now() }) {
  const byName = new Map(providers.map(p => [String(p.name).toLowerCase(), p]));
  const out = [];
  for (const m of models) {
    if (!m.enabled || m.hidden) continue;
    const p = byName.get(String(m.provider).toLowerCase());
    if (!p?.api_key || providerCoolingFn(p, now) || modelCooling(String(p.name).toLowerCase(), m.name)) continue;
    out.push(toCandidate(p, m, settings));
  }
  return out.sort((a, b) => routeScore(a, tier, settings) - routeScore(b, tier, settings));
}

/** Ưu tiên mỗi provider một model tốt nhất trước, rồi mới tới model thứ 2 của cùng provider. */
export function pickAttempts(ranked, max = 3) {
  const seen = new Set(), first = [], rest = [];
  for (const c of ranked) {
    if (seen.has(c.provider)) rest.push(c);
    else { seen.add(c.provider); first.push(c); }
  }
  return [...first, ...rest].slice(0, max);
}

export function pickCouncil(ranked, max = 5) {
  return pickAttempts(ranked, Infinity).filter((c, i, arr) => arr.findIndex(x => x.provider === c.provider) === i).slice(0, max);
}

/** Chấm điểm câu trả lời để chọn khi không có judge. */
export function rankAnswer(text, prompt, truncated = false) {
  const t = String(text || '').trim();
  let s = Math.min(t.length, 3000) / 600;
  if (t.length < 40) s -= 3;
  if (/```/.test(t) && /```|code|lập trình|script|hàm|function/i.test(prompt)) s += 2;
  if (/^(xin lỗi|rất tiếc|tôi không thể|i can't|i cannot|as an ai)/i.test(t)) s -= 3;
  if (/api key|hãy cấu hình|chưa được cấu hình/i.test(t)) s -= 4;
  if (/[.!?…)]$|```$/.test(t)) s += 1;
  if (truncated) s -= 2;
  return s;
}
