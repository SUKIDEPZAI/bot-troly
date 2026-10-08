import { getProvider } from './db.js';
import { redact, stripThink } from './utils.js';

// Provider registry: ưu tiên các API có endpoint models + chat theo chuẩn HTTP.
export const PROVIDERS = {
  gemini: {
    label:'Google Gemini', baseUrl:'https://generativelanguage.googleapis.com/v1beta', modelsPath:'/models',
    protocol:'gemini', auth:'query', description:'Gemini; chat, code, phân tích và đa phương thức.'
  },
  groq: {
    label:'Groq', baseUrl:'https://api.groq.com/openai/v1', modelsPath:'/models', chatPath:'/chat/completions',
    protocol:'openai', description:'API OpenAI-compatible, ưu tiên tốc độ.'
  },
  openrouter: {
    label:'OpenRouter', baseUrl:'https://openrouter.ai/api/v1', modelsPath:'/models', chatPath:'/chat/completions',
    protocol:'openai', description:'Một API cho nhiều nhà cung cấp/model; có metadata giá/model.'
  },
  deepseek: {
    label:'DeepSeek', baseUrl:'https://api.deepseek.com', modelsPath:'/models', chatPath:'/chat/completions',
    protocol:'openai', description:'Chat và reasoning; OpenAI-compatible.'
  },
  openai: {
    label:'OpenAI', baseUrl:'https://api.openai.com/v1', modelsPath:'/models', chatPath:'/chat/completions',
    protocol:'openai', description:'API model OpenAI.'
  },
  anthropic: {
    label:'Anthropic Claude', baseUrl:'https://api.anthropic.com/v1', modelsPath:'/models', chatPath:'/messages',
    protocol:'anthropic', description:'Claude; phân tích và lập luận.'
  },
  mistral: {
    label:'Mistral AI', baseUrl:'https://api.mistral.ai/v1', modelsPath:'/models', chatPath:'/chat/completions',
    protocol:'openai', description:'Mistral API, OpenAI-compatible.'
  },
  xai: {
    label:'xAI', baseUrl:'https://api.x.ai/v1', modelsPath:'/models', chatPath:'/chat/completions',
    protocol:'openai', description:'xAI API theo chuẩn OpenAI.'
  },
  together: {
    label:'Together AI', baseUrl:'https://api.together.xyz/v1', modelsPath:'/models', chatPath:'/chat/completions',
    protocol:'openai', description:'Nhiều open model qua API thống nhất.'
  },
  cerebras: {
    label:'Cerebras', baseUrl:'https://api.cerebras.ai/v1', modelsPath:'/models', chatPath:'/chat/completions',
    protocol:'openai', description:'Inference tốc độ cao theo API OpenAI-compatible.'
  },
  fireworks: {
    label:'Fireworks AI', baseUrl:'https://api.fireworks.ai/inference/v1', modelsPath:'/models', chatPath:'/chat/completions',
    protocol:'openai', description:'Open models và serverless inference.'
  },
  huggingface: {
    label:'Hugging Face', baseUrl:'https://router.huggingface.co/v1', modelsPath:'/models', chatPath:'/chat/completions',
    protocol:'openai', description:'Inference API/router cho nhiều model mở.'
  },
  nvidia: {
    label:'NVIDIA NIM', baseUrl:'https://integrate.api.nvidia.com/v1', modelsPath:'/models', chatPath:'/chat/completions',
    protocol:'openai', description:'NVIDIA hosted inference endpoints.'
  },
  sambanova: {
    label:'SambaNova', baseUrl:'https://api.sambanova.ai/v1', modelsPath:'/models', chatPath:'/chat/completions',
    protocol:'openai', description:'Open-model inference API.'
  }
};

const clean = u => String(u || '').trim().replace(/\/+$/, '');

export function normalizeBase(provider, url) {
  let b = clean(url);
  const defaults = PROVIDERS[provider]?.baseUrl;
  if (!b) return defaults || '';
  try {
    const u = new URL(b);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    if (provider === 'gemini') {
      if (!/v1beta$/i.test(path)) u.pathname = `${path}/v1beta`.replace(/\/+/g,'/');
    } else if (provider === 'deepseek') {
      // DeepSeek OpenAI-compatible API uses /v1 for chat and models.
      if (!/\/v1$/i.test(path)) u.pathname = `${path}/v1`.replace(/\/+/g,'/');
    } else if (provider === 'groq') {
      if (!/\/openai\/v1$/i.test(path)) u.pathname = /api\.groq\.com$/i.test(host) ? '/openai/v1' : `${path}/openai/v1`;
    } else if (provider === 'openrouter') {
      if (!/\/api\/v1$/i.test(path)) u.pathname = /openrouter\.ai$/i.test(host) ? '/api/v1' : `${path}/api/v1`;
    } else if (['openai','anthropic','mistral','xai','together','cerebras','huggingface','nvidia','sambanova'].includes(provider)) {
      if (!/\/v1$/i.test(path)) {
        const known = {
          openai:'api.openai.com', anthropic:'api.anthropic.com', mistral:'api.mistral.ai', xai:'api.x.ai',
          together:'api.together.xyz', cerebras:'api.cerebras.ai', huggingface:'router.huggingface.co',
          nvidia:'integrate.api.nvidia.com', sambanova:'api.sambanova.ai'
        };
        u.pathname = host === known[provider] ? '/v1' : `${path}/v1`;
      }
    } else if (provider === 'fireworks') {
      if (!/\/inference\/v1$/i.test(path)) u.pathname = /api\.fireworks\.ai$/i.test(host) ? '/inference/v1' : `${path}/inference/v1`;
    }
    return clean(u.toString());
  } catch { return clean(b); }
}

function join(base, path) { return `${clean(base)}/${String(path || '').replace(/^\/+/, '')}`; }

function headersFor(provider, key) {
  if (provider === 'gemini') return { 'x-goog-api-key': key }; // header thay vì ?key= để key không lọt vào URL/log
  if (provider === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  return { Authorization: `Bearer ${key}` };
}

// ───────────────────────── Phân loại model ─────────────────────────

/** Kích thước tham số (tỷ) suy ra từ ID: 70b → 70, 8x7b → 56, 30b-a3b → 30. */
export function paramSizeB(id) {
  const s = String(id || '').toLowerCase();
  let best = null;
  for (const m of s.matchAll(/(\d+)x(\d+(?:\.\d+)?)b(?![a-z])/g)) best = Math.max(best ?? 0, Number(m[1]) * Number(m[2]));
  for (const m of s.matchAll(/(?<![a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/g)) best = Math.max(best ?? 0, Number(m[1]));
  return best;
}

export function isReasoningModel(id) {
  return /(?:^|[\/_-])(o[1-9](?:-|$)|gpt-5)|reason|thinking|(?:^|[\/_-])r1(?:$|[\/_-])/i.test(String(id || ''));
}

/** 1 = nhẹ/nhanh, 2 = cân bằng, 3 = mạnh/khó. Chỉ dựa vào ID (mô tả dễ gây nhận nhầm). */
export function classifyTier(id) {
  const s = String(id || '').toLowerCase();
  const size = paramSizeB(s);
  if (/flash-lite|nano|tiny|small|lite|haiku|instant|(?:^|[\/_-])mini(?:$|[\/_-])/.test(s)) return 1;
  if (size !== null && size <= 14) return 1;
  if (/opus|ultra|reasoner|thinking|(?:^|[\/_-])pro(?:$|[\/_-])|large|(?:^|[\/_-])max(?:$|[\/_-])|(?:^|[\/_-])o[134](?:$|[\/_-])|(?:^|[\/_-])r1(?:$|[\/_-])|gpt-5(?:$|[\/_-])(?!mini|nano)|sonnet/.test(s)) return 3;
  if (size !== null && size >= 65) return 3;
  return 2;
}

const NON_CHAT = new RegExp([
  'embed', 'whisper', '(?:^|[\\/_-])tts(?:$|[\\/_-])', 'speech', 'transcrib', 'moderation', 'rerank', 'guard',
  'image', 'audio', 'realtime', 'dall-e', 'sora', 'computer-use', 'davinci', 'babbage', 'search-preview',
  'deep-research', 'codex', 'o1-pro', 'o3-pro', 'gpt-3\\.5-turbo-instruct', '(?:^|[\\/_-])live(?:$|[\\/_-])', 'vision-only', 'search-only'
].join('|'), 'i');

function isSubscriptionOnly(raw, id, description = '') {
  const text = `${JSON.stringify(raw || {})} ${id} ${description}`.toLowerCase();
  return /(chatgpt[\s_-]*(plus|pro)|subscription[\s_-]*(only|required)|requires?[\s_-]*(chatgpt[\s_-]*)?(plus|pro)|plus[\s_-]*only|pro[\s_-]*only|consumer[\s_-]*only)/i.test(text);
}

function isChatModel(provider, raw, id) {
  if (NON_CHAT.test(id) || NON_CHAT.test(String(raw?.displayName || ''))) return false;
  const methods = Array.isArray(raw?.supportedGenerationMethods) ? raw.supportedGenerationMethods : [];
  if (provider === 'gemini' && methods.length && !methods.includes('generateContent')) return false;
  return true;
}

export function normalizeModel(provider, raw) {
  let id = raw?.id || raw?.name || raw?.model;
  if (!id) return null;
  id = String(id).replace(/^models\//, '');
  const description = String(raw?.description || raw?.displayName || raw?.display_name || `Model ${id}`).slice(0, 300);
  if (!isChatModel(provider, raw, id) || isSubscriptionOnly(raw, id, description)) return null;
  const pricing = raw?.pricing || raw?.top_provider?.pricing || {};
  const free = /:free$/i.test(id) ||
    (pricing.prompt !== undefined && pricing.completion !== undefined && Number(pricing.prompt) === 0 && Number(pricing.completion) === 0);
  const context = raw?.context_window || raw?.context_length || raw?.max_context_length || raw?.inputTokenLimit || raw?.top_provider?.context_length || null;
  const modalities = raw?.architecture?.input_modalities || [];
  const capabilities = [
    modalities.includes?.('image') ? 'vision' : '',
    modalities.includes?.('text') ? 'text' : '',
    raw?.supportedGenerationMethods?.includes?.('generateContent') ? 'generateContent' : ''
  ].filter(Boolean).join(',');
  return { id, name: id, description, context: Number(context) || null, free, tier: classifyTier(id), capabilities, hidden: false, source: 'remote' };
}

export function suggestedModels(providerName = null) {
  const suggestions = {
    gemini: [['gemini-2.5-flash-lite', 1, true, 'Nhanh, nhẹ, phù hợp chat thường.'], ['gemini-2.5-flash', 2, true, 'Cân bằng tốc độ và chất lượng.']],
    groq: [['llama-3.1-8b-instant', 1, true, 'Nhanh, phù hợp chat thường.']],
    openrouter: [['openrouter/free', 1, true, 'Điểm vào model miễn phí của OpenRouter. Model thực tế có thể thay đổi.']],
    deepseek: [['deepseek-chat', 2, false, 'Chat đa năng; quyền truy cập phụ thuộc API account.'], ['deepseek-reasoner', 3, false, 'Reasoning; dùng cho câu hỏi khó.']],
    openai: [['gpt-4o-mini', 1, false, 'Model nhẹ; API access phụ thuộc tài khoản.'], ['gpt-5', 3, false, 'Model mạnh; API access phụ thuộc tài khoản.']],
    anthropic: [['claude-haiku-4-5-20251001', 1, false, 'Nhanh/nhẹ; quyền truy cập phụ thuộc tài khoản.'], ['claude-sonnet-5-5', 3, false, 'Mạnh hơn cho tác vụ khó.']],
    mistral: [['mistral-small-latest', 1, false, 'Nhẹ và nhanh.'], ['mistral-large-latest', 3, false, 'Mạnh hơn cho tác vụ phức tạp.']],
    xai: [['grok-3-mini', 2, false, 'Model nhỏ hơn, phù hợp reasoning/chat.']],
    together: [['meta-llama/Llama-3.3-70B-Instruct-Turbo', 3, false, 'Open model mạnh.']],
    cerebras: [['llama-3.1-8b', 1, false, 'Nhanh, nhẹ.'], ['llama-3.3-70b', 3, false, 'Mạnh hơn.']],
    fireworks: [['accounts/fireworks/models/llama-v3p1-8b-instruct', 1, false, 'Open model nhẹ.'], ['accounts/fireworks/models/llama-v3p3-70b-instruct', 3, false, 'Open model mạnh.']],
    huggingface: [['Qwen/Qwen2.5-7B-Instruct', 1, true, 'Open model nhẹ; availability phụ thuộc router.']],
    nvidia: [['meta/llama-3.1-8b-instruct', 1, false, 'Open model nhẹ.'], ['meta/llama-3.3-70b-instruct', 3, false, 'Open model mạnh.']],
    sambanova: [['Meta-Llama-3.1-8B-Instruct', 1, false, 'Open model nhẹ.'], ['Meta-Llama-3.3-70B-Instruct', 3, false, 'Open model mạnh.']]
  };
  const toObj = (provider, x) => ({ provider, name: x[0], tier: x[1], free: x[2], description: x[3] });
  if (providerName) { const p = String(providerName).toLowerCase(); return (suggestions[p] || []).map(x => toObj(p, x)); }
  return Object.entries(suggestions).flatMap(([p, a]) => a.map(x => toObj(p, x)));
}

// ───────────────────────── HTTP ─────────────────────────

export function timeoutError(provider) {
  const err = new Error(`API ${provider || 'AI'} hết thời gian chờ.`);
  err.name = 'TimeoutError'; err.status = 408; err.provider = provider;
  return err;
}

function errorDetail(data, res) {
  const e = data?.error;
  const msg = (typeof e === 'string' ? e : e?.message) || e?.type || data?.message || data?.raw || `${res.status} ${res.statusText}`;
  return typeof msg === 'string' ? msg : JSON.stringify(msg);
}

/** 429 KHÔNG retry tại chỗ (để router chuyển tuyến ngay); chỉ retry lỗi mạng/5xx/timeout. */
export const abortedError = provider => Object.assign(new Error('Yêu cầu đã bị hủy.'), { name: 'AbortError', aborted: true, provider });

export async function requestJson(url, options = {}, { timeoutMs = 12000, retries = 0, provider = '', secrets = [], signal = null } = {}) {
  let lastErr;
  if (signal?.aborted) throw abortedError(provider);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, { ...options, signal: controller.signal, headers: { Accept: 'application/json', ...(options.headers || {}) } });
      const text = await res.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
      if (!res.ok) {
        const err = new Error(redact(`HTTP ${res.status}: ${errorDetail(data, res)}`, secrets));
        err.status = res.status; err.provider = provider;
        const ra = Number(res.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = Math.min(ra * 1000, 300000);
        throw err;
      }
      return data;
    } catch (err) {
      if (signal?.aborted) { lastErr = abortedError(provider); break; } // bị hủy chủ động → không retry
      lastErr = err?.name === 'AbortError' ? timeoutError(provider) : err;
      const status = Number(lastErr?.status || 0);
      const network = lastErr instanceof TypeError; // fetch failed / DNS / reset
      const retryable = network || lastErr.name === 'TimeoutError' || status === 408 || status === 409 || status >= 500;
      if (!retryable || attempt >= retries) break;
      await new Promise(r => setTimeout(r, 300 * 2 ** attempt));
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
  if (lastErr) lastErr.message = redact(lastErr.message, secrets);
  throw lastErr || new Error('Không thể kết nối API.');
}

export function isTransientError(err) {
  const status = Number(err?.status || 0);
  return err?.name === 'TimeoutError' || err?.name === 'AbortError' || status === 408 || status === 409 || status === 429 || status >= 500 ||
    err instanceof TypeError || /timeout|timed out|hết thời gian|ECONN|ENOTFOUND|fetch failed|socket/i.test(String(err?.message || ''));
}

// ───────────────────────── Catalog ─────────────────────────

const modelCache = new Map();
const MODEL_CACHE_TTL = 90_000;
export function clearModelCache(provider = null) { if (provider) modelCache.delete(String(provider).toLowerCase()); else modelCache.clear(); }

function modelsUrl(provider, base, cfg) {
  const url = join(base, cfg.modelsPath);
  if (provider === 'gemini') return `${url}?pageSize=1000`;      // mặc định chỉ 50 model/trang
  if (provider === 'anthropic') return `${url}?limit=1000`;      // mặc định chỉ 20 model/trang
  return url;
}

export async function listRemoteModels(providerName, { force = false } = {}) {
  const provider = String(providerName || '').toLowerCase();
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Provider '${provider}' chưa được hỗ trợ.`);
  const saved = await getProvider(provider);
  if (!saved?.api_key) throw new Error(`Chưa có API key cho ${cfg.label} (hoặc không giải mã được). Hãy lưu lại API trong /admin → API.`);
  const cached = modelCache.get(provider);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.models;
  const base = normalizeBase(provider, saved.base_url || cfg.baseUrl);
  const list = [];
  let pageToken = '', afterId = '';
  for (let page = 0; page < 10; page++) { // giới hạn an toàn 10 trang
    let url = modelsUrl(provider, base, cfg);
    if (provider === 'gemini' && pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    if (provider === 'anthropic' && afterId) url += `&after_id=${encodeURIComponent(afterId)}`;
    const data = await requestJson(url, { headers: headersFor(provider, saved.api_key) },
      { timeoutMs: 10000, retries: 1, provider, secrets: [saved.api_key] });
    list.push(...(Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []));
    if (provider === 'gemini' && data?.nextPageToken) { pageToken = data.nextPageToken; continue; }
    if (provider === 'anthropic' && data?.has_more && data?.last_id) { afterId = data.last_id; continue; }
    break;
  }
  const models = list.map(x => normalizeModel(provider, x)).filter(Boolean)
    .sort((a, b) => a.tier - b.tier || Number(b.free) - Number(a.free) || a.name.localeCompare(b.name));
  modelCache.set(provider, { expiresAt: Date.now() + MODEL_CACHE_TTL, models });
  return models;
}

// ───────────────────────── Chat ─────────────────────────

/** Gộp các lượt liên tiếp cùng role & đảm bảo lượt đầu là user (Anthropic/Gemini yêu cầu). */
export function normalizeTurns(messages) {
  const turns = [];
  for (const m of messages.filter(x => x.role !== 'system')) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m.content ?? '');
    if (!content.trim()) continue;
    if (turns.length && turns.at(-1).role === role) turns.at(-1).content += `\n\n${content}`;
    else turns.push({ role, content });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

/** Dựng request (thuần, không gọi mạng) → dễ test. */
export function buildChatRequest({ provider, model, messages, temperature = 0.7, maxTokens = 1200, base, apiKey }) {
  const cfg = PROVIDERS[provider];
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const turns = normalizeTurns(messages);
  const reasoning = isReasoningModel(model);
  const headers = { 'content-type': 'application/json', ...headersFor(provider, apiKey) };

  if (provider === 'gemini') {
    const thinking = /gemini-(2\.5|[3-9])/.test(model) && !/lite/.test(model);
    const body = {
      contents: turns.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { temperature, maxOutputTokens: maxTokens + (thinking ? 1500 : 0) } // chừa chỗ cho "thinking"
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    return { url: join(base, `models/${encodeURIComponent(model)}:generateContent`), headers, body };
  }
  if (provider === 'anthropic') {
    const body = { model, max_tokens: maxTokens, temperature, messages: turns };
    if (system) body.system = system;
    return { url: join(base, cfg.chatPath), headers, body };
  }
  const body = { model, messages: [...(system ? [{ role: 'system', content: system }] : []), ...turns] };
  if (provider === 'openai') {
    // Model mới của OpenAI từ chối max_tokens; reasoning chỉ nhận temperature mặc định.
    body.max_completion_tokens = maxTokens + (reasoning ? 2000 : 0);
    if (!reasoning) body.temperature = temperature; else body.reasoning_effort = 'low';
  } else {
    body.max_tokens = maxTokens + (reasoning ? 2000 : 0);
    if (!reasoning) body.temperature = temperature;
  }
  return { url: join(base, cfg.chatPath), headers, body };
}

export function parseChatResponse(provider, data) {
  let text = '', truncated = false;
  if (provider === 'gemini') {
    const c = data?.candidates?.[0];
    text = c?.content?.parts?.map(x => x.text || '').join('') || '';
    truncated = c?.finishReason === 'MAX_TOKENS';
    if (!text && data?.promptFeedback?.blockReason) throw new Error(`Gemini từ chối nội dung (${data.promptFeedback.blockReason}).`);
  } else if (provider === 'anthropic') {
    text = data?.content?.filter(x => x.type === 'text' || x.text).map(x => x.text || '').join('') || '';
    truncated = data?.stop_reason === 'max_tokens';
  } else {
    const c = data?.choices?.[0];
    const content = c?.message?.content ?? c?.text ?? '';
    text = Array.isArray(content) ? content.map(x => x?.text || '').join('') : String(content || '');
    truncated = c?.finish_reason === 'length';
  }
  return { text: stripThink(text), truncated };
}

export async function chat({ provider: providerName, model, messages, temperature = 0.7, maxTokens = 1200, timeoutMs = 12000, signal = null }) {
  const provider = String(providerName || '').toLowerCase();
  const cfg = PROVIDERS[provider];
  const saved = await getProvider(provider);
  if (!cfg || !saved?.api_key) throw new Error(`Provider ${provider || 'AI'} chưa được cấu hình API (hoặc key không giải mã được). Vào /admin → API để kiểm tra.`);
  if (String(saved.api_key).length < 8) throw new Error(`API key của ${cfg.label} không hợp lệ. Hãy nhập lại API key.`);
  if (!model) throw new Error(`Chưa có model cho ${cfg.label}.`);
  const base = normalizeBase(provider, saved.base_url || cfg.baseUrl);
  const started = Date.now();
  try {
    const req = buildChatRequest({ provider, model, messages, temperature, maxTokens, base, apiKey: saved.api_key });
    const data = await requestJson(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) },
      { timeoutMs, retries: 1, provider, secrets: [saved.api_key], signal });
    const { text, truncated } = parseChatResponse(provider, data);
    if (!text) throw new Error(`${cfg.label} không trả về nội dung.`);
    return { text, truncated, latencyMs: Date.now() - started };
  } catch (err) {
    err.provider = provider; err.model = model; err.latencyMs = Date.now() - started;
    err.message = redact(err.message, [saved.api_key]);
    throw err;
  }
}

export async function testProvider(providerName) {
  try {
    const models = await listRemoteModels(providerName, { force: true });
    return { ok: true, message: `Kết nối OK · ${models.length} model chat khả dụng`, models };
  } catch (catalogErr) {
    // Một số gateway hợp lệ không cho GET /models → thử chat với model gợi ý thay vì kết luận key hỏng.
    const provider = String(providerName || '').toLowerCase();
    const saved = await getProvider(provider);
    const fallback = suggestedModels(provider)[0]?.name;
    if (!PROVIDERS[provider] || !saved?.api_key || !fallback || catalogErr.status === 401 || catalogErr.status === 403) throw catalogErr;
    try {
      await chat({ provider, model: fallback, messages: [{ role: 'user', content: 'Trả lời đúng một từ: OK' }], temperature: 0, maxTokens: 16, timeoutMs: 8000 });
      return { ok: true, message: `Kết nối chat OK · catalog /models không khả dụng; xác thực bằng model thử ${fallback}`, models: [] };
    } catch (chatErr) { chatErr.catalogError = catalogErr; throw chatErr; }
  }
}
