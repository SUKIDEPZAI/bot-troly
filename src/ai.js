import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import { saveAiRun } from './db.js';
import { compressMessages } from './headroom.js';
import { createHash } from 'node:crypto';
import { shouldEnableSemanticCache, buildProfessionalSystem } from './integrations/ecosystem.js';

const cache = new Map();
const providerHealth = new Map();
const semanticCache = new Map();

function healthState(name) {
  const state = providerHealth.get(name) || { failures: 0, cooldownUntil: 0 };
  providerHealth.set(name, state);
  return state;
}

function markProviderSuccess(name) {
  const state = healthState(name);
  state.failures = 0;
  state.cooldownUntil = 0;
}

function markProviderFailure(name) {
  const state = healthState(name);
  state.failures += 1;
  if (state.failures >= 2) state.cooldownUntil = Date.now() + config.routing.providerCooldownMs;
}

function isEmptyAnswer(text) {
  return !String(text || '').trim();
}

export function providerAvailable(provider) {
  return healthState(provider.name).cooldownUntil <= Date.now();
}

export function providerHealthSnapshot() {
  return Object.fromEntries([...providerHealth.entries()].map(([name, state]) => [name, { ...state, available: state.cooldownUntil <= Date.now() }]));
}

function timeout(promise, ms, label='AI') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms))
  ]);
}

function openaiClient(p) {
  const key = `${p.name}:openai`;
  if (!cache.has(key)) cache.set(key, new OpenAI({ apiKey: p.apiKey, ...(p.baseURL ? { baseURL: p.baseURL } : {}) }));
  return cache.get(key);
}

function messagesToText(messages) {
  return messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
}

async function callOnce(provider, messages, system) {
  // Headroom is provider-neutral: compress the same context before OpenAI-compatible,
  // Anthropic, Gemini, and custom providers. This is not a Claude-only integration.
  const input = [{ role: 'system', content: system }, ...messages];
  const optimized = await compressMessages(input, provider.model);
  const compressed = optimized.messages || input;
  const systemMessage = compressed.find(m => m.role === 'system');
  const bodyMessages = compressed.filter(m => m.role !== 'system');

  if (provider.family === 'anthropic') {
    const client = cache.get(`anthropic:${provider.apiKey}`) || new Anthropic({ apiKey: provider.apiKey });
    cache.set(`anthropic:${provider.apiKey}`, client);
    const clean = bodyMessages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
    const res = await client.messages.create({
      model: provider.model,
      max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 5000),
      system: typeof systemMessage?.content === 'string' ? systemMessage.content : system,
      messages: clean
    });
    return res.content.filter(x => x.type === 'text').map(x => x.text).join('\n').trim();
  }

  if (provider.family === 'gemini') {
    const client = cache.get(`gemini:${provider.apiKey}`) || new GoogleGenAI({ apiKey: provider.apiKey });
    cache.set(`gemini:${provider.apiKey}`, client);
    const contents = bodyMessages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
    }));
    const res = await client.models.generateContent({
      model: provider.model,
      config: { systemInstruction: typeof systemMessage?.content === 'string' ? systemMessage.content : system, temperature: 0.7 },
      contents
    });
    return (res.text || '').trim();
  }

  const client = openaiClient(provider);
  const res = await client.chat.completions.create({
    model: provider.model,
    temperature: 0.7,
    messages: compressed
  });
  return res.choices?.[0]?.message?.content?.trim() || '';
}

export async function ask(provider, { system, messages, intent='chat', difficulty=0, analysis=null }) {
  const effectiveAnalysis = analysis || { difficulty: difficulty <= 30 ? 'easy' : difficulty <= 65 ? 'medium' : 'hard', kinds: [intent] };
  const cacheable = shouldEnableSemanticCache(effectiveAnalysis);
  const cacheKey = cacheable ? createHash('sha256').update(JSON.stringify({provider:provider.name, model:provider.model, system, messages})).digest('hex') : null;
  if (cacheKey) { const hit = semanticCache.get(cacheKey); if (hit && hit.expiresAt > Date.now()) return { provider, text: hit.text, latencyMs: 0, cached: true }; semanticCache.delete(cacheKey); }
  if (!providerAvailable(provider)) throw new Error(`${provider.name} đang tạm cooldown sau các lỗi liên tiếp.`);
  const started = Date.now();
  let lastError;
  for (let attempt=0; attempt<=config.routing.maxRetries; attempt++) {
    try {
      const text = await timeout(callOnce(provider, messages, system), config.routing.timeoutMs, provider.name);
      if (isEmptyAnswer(text)) throw new Error(`${provider.name} trả về nội dung rỗng.`);
      const latencyMs = Date.now() - started;
      markProviderSuccess(provider.name);
      await saveAiRun({provider: provider.name, model: provider.model, intent, difficulty, ok: true, latencyMs}).catch(()=>{});
      if (cacheKey) { semanticCache.set(cacheKey, { text, expiresAt: Date.now() + config.ecosystem.semanticCache.ttlMs }); while (semanticCache.size > config.ecosystem.semanticCache.maxEntries) semanticCache.delete(semanticCache.keys().next().value); }
      return { provider, text, latencyMs, cached: false };
    } catch (err) {
      lastError = err;
      if (attempt === config.routing.maxRetries) markProviderFailure(provider.name);
      const delay = 500 * (attempt + 1) * (attempt + 1);
      if (attempt < config.routing.maxRetries) await new Promise(r => setTimeout(r, delay));
    }
  }
  const latencyMs = Date.now() - started;
  await saveAiRun({provider: provider.name, model: provider.model, intent, difficulty, ok: false, latencyMs}).catch(()=>{});
  throw lastError;
}

export async function askWithFallback(providers, ctx) {
  const candidates = providers.filter(providerAvailable);
  if (!candidates.length) throw new Error('Tất cả AI khả dụng đang cooldown.');
  let lastError;
  for (const provider of candidates) {
    try { return await ask(provider, ctx); }
    catch (err) { lastError = err; }
  }
  throw lastError || new Error('Không có AI nào phản hồi.');
}


function buildAdaptivePersona(analysis) {
  const style = analysis.language?.style || 'standard';
  const speech = analysis.language?.speechAct || 'statement';
  const kinds = new Set(analysis.kinds || []);
  const lines = [];
  if (style === 'young_slang' || style === 'abbreviated') lines.push('- Người dùng nói kiểu đời thường/giới trẻ: hiểu đúng ý nhưng trả lời sạch, tự nhiên; chỉ dùng slang nhẹ khi phù hợp, không cố bắt chước quá mức.');
  else lines.push('- Giữ giọng tự nhiên, thân thiện và chuyên nghiệp; tránh văn phong robot.');
  if (speech === 'question') lines.push('- Đây là câu hỏi: trả lời thẳng đáp án trước, sau đó mới giải thích.');
  if (speech === 'request') lines.push('- Đây là yêu cầu: ưu tiên hành động/kết quả cụ thể thay vì mô tả dài dòng.');
  if (kinds.has('coding')) lines.push('- Chế độ kỹ thuật: suy nghĩ theo yêu cầu, ràng buộc, kiến trúc, lỗi có thể xảy ra và cách kiểm thử; không bịa kết quả chạy.');
  if (kinds.has('research') || kinds.has('web')) lines.push('- Chế độ web/research: ưu tiên nguồn mới và nguồn gốc; phân biệt dữ kiện, suy luận và ý kiến; không bịa nguồn; nếu có nguồn web thì trích dẫn [1], [2] đúng theo context.');
  if (kinds.has('creative')) lines.push('- Chế độ sáng tạo: ưu tiên giọng có cá tính, nhưng vẫn bám đúng yêu cầu.');
  lines.push('- Khi có nhiều AI cộng tác, hãy xem họ như đồng nghiệp: phản biện bằng lý do cụ thể, cập nhật quan điểm khi có bằng chứng tốt hơn và không tạo đồng thuận giả.');
  return lines.join('\n');
}

export function buildSystem({ botName, analysis, memories, profile = null }) {
  const language = analysis.language || { normalized: '', style: 'standard', speechAct: 'statement' };
  const targetLine = analysis.explicitAI
    ? `AI được người dùng chỉ đích danh: ${analysis.targetAIs.map(x => x.alias).join(', ')}. Nếu chỉ có một AI được chỉ định, hãy tự mình hoàn thành nhiệm vụ; không yêu cầu AI khác và không nhắc đến router nội bộ.`
    : 'Người dùng không chỉ đích danh AI; hệ thống đã tự chọn AI phù hợp.';
  const persona = buildAdaptivePersona(analysis);
  const professional = config.ecosystem.professionalMode ? `\n\n${buildProfessionalSystem(analysis)}` : '';
  const profileLine = profile ? `Hồ sơ giao tiếp đã học (chỉ dùng để cá nhân hóa, không được nhắc ra): ngôn ngữ=${profile.preferred_language || 'chưa rõ'}, phong cách=${profile.communication_style || 'chưa rõ'}, ý định gần nhất=${profile.last_intent || 'chưa rõ'}.` : 'Chưa có hồ sơ giao tiếp lâu dài.';
  return `Bạn là ${botName}, một trợ lý Discord nói chuyện tự nhiên như một người dùng thật nhưng lịch sự, rõ ràng và hữu ích. Người dùng có thể viết tiếng Việt hoặc ngôn ngữ khác; hãy trả lời cùng ngôn ngữ chủ đạo của họ. Không nhắc rằng bạn là "hội đồng" trừ khi điều đó hữu ích. Không bịa nguồn, kết quả chạy code, hay việc đã làm mà chưa làm.

Nhận diện cách nói của người dùng:
- Kiểu câu: ${language.speechAct}
- Phong cách: ${language.style}
- Câu đã chuẩn hóa để hiểu ý (chỉ dùng làm gợi ý, không được thay thế nội dung gốc): ${language.normalized || '(trống)'}
- ${targetLine}

Phong cách:
${persona}
- Ưu tiên câu trả lời tự nhiên, không máy móc.
- Với chat thường: ngắn gọn nhưng có chiều sâu khi cần.
- Với coding: code hoàn chỉnh, chú thích vừa đủ, chỉ ra lỗi và cách dùng.
- Không tự ý tạo file trừ khi người dùng yêu cầu xuất/tạo/gửi file.
- Khi yêu cầu file, hãy đặt phần code chính trong fenced code block và ghi một dòng đầu tiên của block là tên file nếu hợp lý.
- Nếu thiếu dữ kiện quan trọng, nêu giả định rõ ràng và tiếp tục bằng best-effort.

Phân loại hiện tại: ${analysis.kinds.join(', ')}; độ khó ${analysis.difficulty} (${analysis.score}/100).
${profileLine}${professional}
Ký ức người dùng (nếu có): ${memories.length ? memories.map(x => `- ${x}`).join('\n') : '(không có)'}
`;
}

export function extractFileCandidates(text, fallbackKind='txt') {
  const blocks = [...text.matchAll(/```(?:([\w#+.-]+))?\s*\n([\s\S]*?)```/g)].map(m => ({ lang: (m[1]||fallbackKind).toLowerCase(), code: m[2].trim() })).filter(x => x.code);
  if (!blocks.length) return [];
  const ext = ({javascript:'js',js:'js',typescript:'ts',ts:'ts',html:'html',css:'css',python:'py',py:'py',json:'json',sql:'sql',bash:'sh',sh:'sh',markdown:'md',md:'md',text:'txt',txt:'txt',jsx:'jsx',tsx:'tsx'});
  return blocks.map((b,i) => ({ name: `ai-output-${i+1}.${ext[b.lang] || 'txt'}`, content: b.code, language: b.lang }));
}
