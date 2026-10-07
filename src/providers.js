import { getProvider } from './db.js';

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    modelsPath: '/models',
    description: 'AI đa năng của Google; hỗ trợ chat, code, phân tích và nhiều khả năng đa phương thức.'
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    description: 'Hạ tầng suy luận tốc độ cao với API tương thích OpenAI.'
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    description: 'Cổng truy cập nhiều nhà cung cấp và model AI.'
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    description: 'Mạnh về lập trình, chat và suy luận.'
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    description: 'Hệ sinh thái model AI tổng quát của OpenAI.'
  },
  anthropic: {
    label: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    modelsPath: '/models',
    chatPath: '/messages',
    description: 'Claude; mạnh về phân tích, viết và lập luận.'
  }
};

function cleanBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function endpoint(base, path) {
  const b = cleanBase(base);
  const p = String(path || '').replace(/^\/+/, '');
  return `${b}/${p}`;
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, headers: { Accept: 'application/json', ...(options.headers || {}) } });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const detail = data?.error?.message || data?.error?.type || data?.message || data?.raw || `${res.status} ${res.statusText}`;
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    return data;
  } finally { clearTimeout(timer); }
}


function normalizeBase(provider, url) {
  let b = cleanBase(url);
  if (provider === 'gemini') {
    if (/generativelanguage\.googleapis\.com$/i.test(b)) b += '/v1beta';
  } else if (provider === 'deepseek') {
    b = b.replace(/\/v1$/i, '');
  } else if (provider === 'groq') {
    if (/api\.groq\.com$/i.test(b)) b += '/openai/v1';
  } else if (provider === 'openrouter') {
    if (/openrouter\.ai$/i.test(b)) b += '/api/v1';
  } else if (provider === 'openai') {
    if (/api\.openai\.com$/i.test(b)) b += '/v1';
  } else if (provider === 'anthropic') {
    if (/api\.anthropic\.com$/i.test(b)) b += '/v1';
  }
  return b;
}
function headersFor(provider, key) {
  if (provider === 'gemini') return {};
  if (provider === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  return { Authorization: `Bearer ${key}` };
}

function normalizeModel(provider, raw) {
  const id = raw?.id || raw?.name?.replace(/^models\//, '');
  if (!id) return null;
  const description = raw?.description || raw?.name || '';
  const context = raw?.context_window || raw?.context_length || raw?.inputTokenLimit || raw?.top_provider?.context_length;
  const supported = raw?.supportedGenerationMethods || raw?.supported_actions || [];
  const text = JSON.stringify(raw).toLowerCase();
  const likelyChat = provider === 'gemini'
    ? supported.includes('generateContent')
    : provider === 'anthropic'
      ? true
      : provider === 'openrouter'
        ? (raw?.architecture?.output_modalities?.includes('text') ?? true)
        : !/(embedding|embed|whisper|tts|speech|moderation|guard|image|audio)/i.test(id);
  if (!likelyChat) return null;
  return {
    id,
    name: raw?.name || id,
    description: description.slice(0, 300),
    context: context || null,
    free: provider === 'openrouter' ? /(^|:)free$/i.test(id) || Number(raw?.pricing?.prompt || 0) === 0 : false,
    rawText: text
  };
}

export async function listRemoteModels(providerName) {
  const provider = String(providerName || '').toLowerCase();
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Provider '${provider}' chưa được hỗ trợ.`);
  const saved = await getProvider(provider);
  if (!saved?.api_key) throw new Error(`Chưa có API key cho ${cfg.label}.`);
  const base = normalizeBase(provider, saved.base_url || cfg.baseUrl);
  const url = provider === 'gemini' ? `${base}/models?key=${encodeURIComponent(saved.api_key)}` : endpoint(base, cfg.modelsPath);
  const data = await requestJson(url, { headers: headersFor(provider, saved.api_key) });
  const list = Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return list.map(x => normalizeModel(provider, x)).filter(Boolean);
}

export async function testProvider(providerName) {
  const models = await listRemoteModels(providerName);
  return { ok: true, message: `Kết nối OK · tìm thấy ${models.length} model chat`, models };
}

export async function chat({ provider: providerName, model, messages, temperature = 0.7, maxTokens = 1200 }) {
  const provider = String(providerName || '').toLowerCase();
  const cfg = PROVIDERS[provider];
  const saved = await getProvider(provider);
  if (!cfg || !saved?.api_key) throw new Error(`Provider ${provider} chưa được cấu hình API.`);
  const base = normalizeBase(provider, saved.base_url || cfg.baseUrl);

  if (provider === 'gemini') {
    const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content ?? '') }] }));
    const system = messages.find(m => m.role === 'system')?.content;
    const body = { contents, generationConfig: { temperature, maxOutputTokens: maxTokens } };
    if (system) body.systemInstruction = { parts: [{ text: String(system) }] };
    const data = await requestJson(`${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(saved.api_key)}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
    return data?.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('') || '';
  }

  if (provider === 'anthropic') {
    const system = messages.find(m => m.role === 'system')?.content;
    const body = { model, max_tokens: maxTokens, temperature, messages: messages.filter(m=>m.role!=='system').map(m=>({ role:m.role==='assistant'?'assistant':'user', content:String(m.content??'') })) };
    if (system) body.system = String(system);
    const data = await requestJson(`${base}${cfg.chatPath}`, { method:'POST', headers:{'content-type':'application/json', ...headersFor(provider,saved.api_key)}, body:JSON.stringify(body) });
    return data?.content?.map(x=>x.text||'').join('') || '';
  }

  const data = await requestJson(`${base}${cfg.chatPath}`, { method:'POST', headers:{'content-type':'application/json', ...headersFor(provider,saved.api_key)}, body:JSON.stringify({ model, messages, temperature, max_tokens:maxTokens }) });
  return data?.choices?.[0]?.message?.content || '';
}

export function suggestedModels(providerName = null) {
  const all = [
    {provider:'gemini',name:'gemini-3.8-flash',free:true,description:'Model Flash mới, ưu tiên tốc độ và tác vụ đa năng.'},
    {provider:'gemini',name:'gemini-2.5-flash-lite',free:true,description:'Model nhẹ, phù hợp tác vụ nhanh và tiết kiệm.'},
    {provider:'groq',name:'llama-3.1-8b-instant',free:true,description:'Model nhỏ, phản hồi nhanh; phù hợp chatbot.'},
    {provider:'deepseek',name:'deepseek-chat',free:true,description:'Model chat đa năng của DeepSeek.'},
    {provider:'deepseek',name:'deepseek-reasoner',free:true,description:'Model thiên về suy luận; tình trạng miễn phí phụ thuộc tài khoản.'},
    {provider:'openrouter',name:'openrouter/free',free:true,description:'Điểm vào model miễn phí do OpenRouter cung cấp; model thực tế có thể thay đổi.'},
    {provider:'openai',name:'gpt-5.2',free:false,description:'Model OpenAI; yêu cầu quyền truy cập và thanh toán phù hợp.'},
    {provider:'anthropic',name:'claude-sonnet-4-6',free:false,description:'Claude mạnh về phân tích và lập luận; yêu cầu API phù hợp.'}
  ];
  return providerName ? all.filter(x=>x.provider===String(providerName).toLowerCase()) : all;
}
