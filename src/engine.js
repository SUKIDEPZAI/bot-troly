// Lõi AI: định tuyến theo độ khó + fallback, và Hội đồng (nhiều AI song song → judge tổng hợp).
import { listModels, listProviders, recordProviderFailure, recordProviderSuccess, recordUsage } from './db.js';
import { PROVIDERS, chat, clearModelCache } from './providers.js';
import { syncProviderModels } from './catalog.js';
import { classifyFailure, coolModel, coolProvider, isModelCooling, isProviderCooling } from './health.js';
import { difficulty, pickAttempts, pickCouncil, providerCooling, rankAnswer, rankCandidates } from './routing.js';
import { collectAnswers, envInt, truncate } from './utils.js';

const COUNCIL_MAX = envInt('COUNCIL_MAX_MEMBERS', 5, 2, 8);
const label = p => PROVIDERS[p]?.label || p;

// ── cache trạng thái route (5s) ──
const routeCache = { value: null, expiresAt: 0, promise: null };
export function invalidateRoute() { routeCache.expiresAt = 0; routeCache.value = null; }
async function loadRoute() {
  if (routeCache.value && routeCache.expiresAt > Date.now()) return routeCache.value;
  if (routeCache.promise) return routeCache.promise;
  routeCache.promise = (async () => {
    const [providers, models] = await Promise.all([listProviders(), listModels()]);
    routeCache.value = { providers, models };
    routeCache.expiresAt = Date.now() + 5000;
    return routeCache.value;
  })().finally(() => { routeCache.promise = null; });
  return routeCache.promise;
}

async function rankedCandidates(settings, tier) {
  let { providers, models } = await loadRoute();
  const cooling = p => providerCooling(p) || isProviderCooling(p.name);
  // Provider có key nhưng chưa có model nào → tự đồng bộ catalog (có negative-cache bên trong).
  const withModels = new Set(models.filter(m => m.enabled && !m.hidden).map(m => String(m.provider).toLowerCase()));
  const missing = providers.filter(p => p.api_key && !cooling(p) && !withModels.has(String(p.name).toLowerCase()));
  if (missing.length) {
    const synced = await Promise.all(missing.map(p => syncProviderModels(p.name)));
    if (synced.some(a => a.length)) { invalidateRoute(); ({ providers, models } = await loadRoute()); }
  }
  return rankCandidates({ providers, models, settings, tier, modelCooling: isModelCooling, providerCoolingFn: cooling });
}

/** Gọi một model; ghi nhận sức khỏe với phạm vi cooldown đúng (provider hay chỉ model). */
export async function oneCall(candidate, messages, { maxTokens = 1000, timeoutMs = 10000, temperature = 0.65 } = {}) {
  const started = Date.now();
  try {
    const r = await chat({ provider: candidate.provider, model: candidate.model, messages, temperature, maxTokens, timeoutMs });
    const latencyMs = r.latencyMs || Date.now() - started;
    recordProviderSuccess(candidate.provider, latencyMs);
    recordUsage(candidate.provider, true, latencyMs);
    return { ...r, provider: candidate.provider, model: candidate.model, tier: candidate.tier };
  } catch (err) {
    const f = classifyFailure(err, candidate.failCount);
    if (f.scope === 'provider') {
      coolProvider(candidate.provider, f.cooldownMs);
      recordProviderFailure(candidate.provider, err?.message || err, f.cooldownMs);
    } else {
      coolModel(candidate.provider, candidate.model, f.cooldownMs);
    }
    recordUsage(candidate.provider, false, Date.now() - started);
    invalidateRoute();
    if (f.refreshCatalog) { clearModelCache(candidate.provider); syncProviderModels(candidate.provider, { force: true }).then(invalidateRoute); }
    err.candidate = `${label(candidate.provider)}/${candidate.model}`;
    throw err;
  }
}

const tokensFor = d => (d.tier === 3 ? 1500 : 1100);

export async function routedChat({ messages, prompt, settings }) {
  const d = difficulty(prompt);
  const tier = settings.autoRoute ? d.tier : 2;
  let list = await rankedCandidates(settings, tier);
  if (settings.defaultProvider && settings.defaultModel) {
    const exact = list.find(c => c.provider === settings.defaultProvider.toLowerCase() && c.model === settings.defaultModel);
    if (exact) list = [exact, ...list.filter(c => c !== exact)];
  }
  if (!list.length) throw new Error('Chưa có AI khả dụng (chưa cấu hình API, hoặc tất cả đang tạm nghỉ). Quản trị viên hãy mở /admin → API.');

  const failures = [];
  for (const c of pickAttempts(list, 3)) {
    if (isProviderCooling(c.provider) || isModelCooling(c.provider, c.model)) continue; // vừa bị đánh dấu lỗi trong lúc lặp
    try {
      const r = await oneCall(c, messages, { maxTokens: tokensFor(d), timeoutMs: 12000 });
      return { ...r, difficulty: d, mode: 'auto', attempts: failures.length + 1 };
    } catch (err) {
      failures.push(`${err.candidate || c.provider}: ${truncate(err?.message || err, 140)}`);
    }
  }
  throw Object.assign(new Error(`Các tuyến AI đều lỗi (đã thử ${failures.length}). ${failures.slice(0, 2).join(' | ')}`), { failures });
}

export function buildJudgeMessages(question, answers) {
  const body = answers.map((a, i) => `### Phương án ${i + 1}\n${truncate(a.text, 3500)}`).join('\n\n');
  return [
    { role: 'system', content: 'Bạn là biên tập viên tổng hợp. Từ nhiều phương án trả lời, hãy chọn thông tin đúng, loại bỏ chỗ sai/mâu thuẫn và hợp nhất thành MỘT câu trả lời duy nhất, mạch lạc, cùng ngôn ngữ người dùng. Giữ nguyên code hoàn chỉnh nếu có. Tuyệt đối không nhắc tới "phương án", "AI khác" hay quá trình tổng hợp.' },
    { role: 'user', content: `Câu hỏi của người dùng:\n${truncate(question, 3000)}\n\n${body}\n\nHãy viết câu trả lời cuối cùng.` }
  ];
}

export async function councilChat({ messages, prompt, settings }) {
  const d = difficulty(prompt);
  const list = await rankedCandidates(settings, 3);
  const members = pickCouncil(list, COUNCIL_MAX);
  if (members.length < 2) return routedChat({ messages, prompt, settings }); // 1 AI thì dùng tuyến thường (có fallback)

  const answers = await collectAnswers(
    members.map(c => oneCall(c, messages, { maxTokens: 900, timeoutMs: 9000 })),
    { deadlineMs: 13000, enough: Math.min(3, members.length), graceMs: 1500 }
  );
  if (!answers.length) return routedChat({ messages, prompt, settings });

  const ranked = [...answers].sort((a, b) => rankAnswer(b.text, prompt, b.truncated) - rankAnswer(a.text, prompt, a.truncated));
  let final = ranked[0], judged = false;

  if (settings.councilJudge && answers.length >= 2) {
    const fastest = [...answers].sort((a, b) => a.latencyMs - b.latencyMs)[0];
    const judgeCand = members.find(c => c.provider === fastest.provider && c.model === fastest.model);
    try {
      const j = await oneCall(judgeCand, buildJudgeMessages(prompt, ranked), { maxTokens: 1400, timeoutMs: 12000, temperature: 0.4 });
      if (j.text.length >= 20) { final = j; judged = true; }
    } catch { /* giữ câu trả lời xếp hạng cao nhất */ }
  }
  return {
    ...final, difficulty: d, mode: 'council',
    council: { members: answers.map(a => label(a.provider)), total: members.length, judged }
  };
}
