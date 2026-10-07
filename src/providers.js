import { getProvider } from './db.js';

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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const modelCache = new Map();
const modelCacheTtl = 90_000;

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
      if (/\/v1$/i.test(path)) u.pathname = path.replace(/\/v1$/i,'');
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
  if (provider === 'gemini') return {};
  if (provider === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  return { Authorization: `Bearer ${key}` };
}

function classifyTier(id, description='') {
  const s = `${id} ${description}`.toLowerCase();
  if (/(?:^|[\/_-])(tiny|nano|mini|lite|small|\d+b)(?:$|[\/_-])/.test(s) || /flash-lite|haiku|8b|7b|3b/.test(s)) return 1;
  if (/reasoner|reasoning|opus|ultra|70b|72b|405b|large|max|pro/.test(s)) return 3;
  return 2;
}

function isSubscriptionOnly(raw, id, description='') {
  const text = JSON.stringify(raw || {}).toLowerCase() + ` ${id} ${description}`.toLowerCase();
  return /(chatgpt[\s_-]*(plus|pro)|subscription[\s_-]*(only|required)|requires?[\s_-]*(chatgpt[\s_-]*)?(plus|pro)|plus[\s_-]*only|pro[\s_-]*only|consumer[\s_-]*only)/i.test(text);
}

function isChatModel(provider, raw, id) {
  const s = `${id} ${raw?.description || raw?.displayName || ''}`.toLowerCase();
  const nonChat = /(embedding|embed|whisper|tts|speech|transcrib|moderation|rerank|guard|image|audio|vision-only|search-only)/i.test(s);
  if (nonChat) return false;
  const methods = Array.isArray(raw?.supportedGenerationMethods) ? raw.supportedGenerationMethods : [];
  if (provider === 'gemini' && methods.length && !methods.includes('generateContent')) return false;
  return true;
}

function normalizeModel(provider, raw) {
  let id = raw?.id || raw?.name || raw?.model;
  if (!id) return null;
  id = String(id).replace(/^models\//,'');
  const description = String(raw?.description || raw?.displayName || raw?.name || `Model ${id}`).slice(0,300);
  if (!isChatModel(provider,raw,id) || isSubscriptionOnly(raw,id,description)) return null;
  const pricing = raw?.pricing || raw?.top_provider?.pricing || {};
  const promptPrice = pricing?.prompt;
  const completionPrice = pricing?.completion;
  const free = /:free$/i.test(id) || (promptPrice !== undefined && completionPrice !== undefined && Number(promptPrice)===0 && Number(completionPrice)===0);
  const context = raw?.context_window || raw?.context_length || raw?.max_context_length || raw?.inputTokenLimit || raw?.top_provider?.context_length || null;
  const capabilities = [
    raw?.architecture?.input_modalities?.includes?.('image') ? 'vision' : '',
    raw?.architecture?.input_modalities?.includes?.('text') ? 'text' : '',
    raw?.supportedGenerationMethods?.includes?.('generateContent') ? 'generateContent' : ''
  ].filter(Boolean).join(',');
  return {
    id,
    name:id,
    description,
    context: Number(context) || null,
    free,
    tier: classifyTier(id,description),
    capabilities,
    hidden:false,
    source:'remote'
  };
}

export function suggestedModels(providerName=null) {
  const suggestions = {
    gemini:[['gemini-2.5-flash-lite',1,true,'Nhanh, nhẹ, phù hợp chat thường.'],['gemini-2.5-flash',2,true,'Cân bằng tốc độ và chất lượng.']],
    groq:[['llama-3.1-8b-instant',1,true,'Nhanh, phù hợp chat thường.']],
    openrouter:[['openrouter/free',1,true,'Điểm vào model miễn phí của OpenRouter. Model thực tế có thể thay đổi.']],
    deepseek:[['deepseek-chat',2,false,'Chat đa năng; quyền truy cập phụ thuộc API account.'],['deepseek-reasoner',3,false,'Reasoning; dùng cho câu hỏi khó.']],
    openai:[['gpt-4o-mini',1,false,'Model nhẹ; API access phụ thuộc tài khoản.'],['gpt-5',3,false,'Model mạnh; API access phụ thuộc tài khoản.']],
    anthropic:[['claude-3-5-haiku-latest',1,false,'Nhanh/nhẹ; quyền truy cập phụ thuộc tài khoản.'],['claude-3-5-sonnet-latest',3,false,'Mạnh hơn cho tác vụ khó.']],
    mistral:[['mistral-small-latest',1,false,'Nhẹ và nhanh.'],['mistral-large-latest',3,false,'Mạnh hơn cho tác vụ phức tạp.']],
    xai:[['grok-3-mini',2,false,'Model nhỏ hơn, phù hợp reasoning/chat.']],
    together:[['meta-llama/Llama-3.3-70B-Instruct-Turbo',3,false,'Open model mạnh.']],
    cerebras:[['llama-3.1-8b',1,false,'Nhanh, nhẹ.'],['llama-3.3-70b',3,false,'Mạnh hơn.']],
    fireworks:[['accounts/fireworks/models/llama-v3p1-8b-instruct',1,false,'Open model nhẹ.'],['accounts/fireworks/models/llama-v3p3-70b-instruct',3,false,'Open model mạnh.']],
    huggingface:[['Qwen/Qwen2.5-7B-Instruct',1,true,'Open model nhẹ; availability phụ thuộc router.']],
    nvidia:[['meta/llama-3.1-8b-instruct',1,false,'Open model nhẹ.'],['meta/llama-3.3-70b-instruct',3,false,'Open model mạnh.']],
    sambanova:[['Meta-Llama-3.1-8B-Instruct',1,false,'Open model nhẹ.'],['Meta-Llama-3.3-70B-Instruct',3,false,'Open model mạnh.']]
  };
  const rows=providerName? (suggestions[String(providerName).toLowerCase()]||[]) : Object.entries(suggestions).flatMap(([provider,a])=>a.map(x=>({provider,name:x[0],tier:x[1],free:x[2],description:x[3]})));
  return providerName ? rows.map(x=>({provider:String(providerName).toLowerCase(),name:x[0],tier:x[1],free:x[2],description:x[3]})) : rows;
}

export async function requestJson(url, options = {}, { timeoutMs=12000, retries=0, provider='' } = {}) {
  let lastErr;
  for (let attempt=0; attempt<=retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers:{Accept:'application/json', ...(options.headers || {})}
      });
      const text = await res.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw:text }; }
      if (!res.ok) {
        const detail = data?.error?.message || data?.error?.type || data?.message || data?.raw || `${res.status} ${res.statusText}`;
        const err = new Error(`HTTP ${res.status}: ${detail}`);
        err.status = res.status;
        err.provider = provider;
        throw err;
      }
      return data;
    } catch (err) {
      lastErr = err;
      const status = Number(err?.status || 0);
      const retryable = err?.name==='AbortError' || status===408 || status===409 || status===429 || status>=500;
      if (!retryable || attempt>=retries) break;
      await sleep(250 * 2 ** attempt);
    } finally { clearTimeout(timer); }
  }
  if (lastErr?.name==='AbortError') throw new Error(`API ${provider||'AI'} hết thời gian chờ.`);
  throw lastErr || new Error('Không thể kết nối API.');
}

export async function listRemoteModels(providerName, {force=false}={}) {
  const provider = String(providerName || '').toLowerCase();
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Provider '${provider}' chưa được hỗ trợ.`);
  const saved = await getProvider(provider);
  if (!saved?.api_key) throw new Error(`Chưa có API key cho ${cfg.label}.`);
  const cached = modelCache.get(provider);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.models;
  const base = normalizeBase(provider, saved.base_url || cfg.baseUrl);
  const url = provider === 'gemini'
    ? `${join(base,'models')}?key=${encodeURIComponent(saved.api_key)}`
    : join(base,cfg.modelsPath);
  const data = await requestJson(url,{headers:headersFor(provider,saved.api_key)},{timeoutMs:10000,retries:1,provider});
  const list = Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const models = list.map(x=>normalizeModel(provider,x)).filter(Boolean)
    .sort((a,b)=>Number(a.tier)-Number(b.tier) || Number(b.free)-Number(a.free) || a.name.localeCompare(b.name));
  modelCache.set(provider,{expiresAt:Date.now()+modelCacheTtl,models});
  return models;
}

export async function testProvider(providerName) {
  const models = await listRemoteModels(providerName,{force:true});
  return {ok:true,message:`Kết nối OK · ${models.length} model chat khả dụng`,models};
}

export function isTransientError(err) {
  const status=Number(err?.status||0);
  return err?.name==='AbortError' || status===408 || status===409 || status===429 || status>=500 || /timeout|timed out|ECONN|ENOTFOUND|fetch failed|socket/i.test(String(err?.message||''));
}

export async function chat({provider:providerName,model,messages,temperature=.7,maxTokens=1200,timeoutMs=12000}) {
  const provider=String(providerName||'').toLowerCase();
  const cfg=PROVIDERS[provider];
  const saved=await getProvider(provider);
  if(!cfg||!saved?.api_key) throw new Error(`Provider ${provider||'AI'} chưa được cấu hình API.`);
  if(!model) throw new Error(`Chưa có model cho ${cfg.label}.`);
  const base=normalizeBase(provider,saved.base_url||cfg.baseUrl);
  const started=Date.now();
  try {
    let output='';
    if(provider==='gemini'){
      const contents=messages.filter(m=>m.role!=='system').map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:String(m.content??'')}]}));
      const system=messages.find(m=>m.role==='system')?.content;
      const body={contents,generationConfig:{temperature,maxOutputTokens:maxTokens}};
      if(system) body.systemInstruction={parts:[{text:String(system)}]};
      const data=await requestJson(`${join(base,`models/${encodeURIComponent(model)}:generateContent`)}?key=${encodeURIComponent(saved.api_key)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)},{timeoutMs,retries:1,provider});
      output=data?.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('')||'';
    } else if(provider==='anthropic'){
      const system=messages.find(m=>m.role==='system')?.content;
      const body={model,max_tokens:maxTokens,temperature,messages:messages.filter(m=>m.role!=='system').map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content??'')}))};
      if(system) body.system=String(system);
      const data=await requestJson(join(base,cfg.chatPath),{method:'POST',headers:{'content-type':'application/json',...headersFor(provider,saved.api_key)},body:JSON.stringify(body)},{timeoutMs,retries:1,provider});
      output=data?.content?.map(x=>x.text||'').join('')||'';
    } else {
      const body={model,messages,temperature,max_tokens:maxTokens};
      const data=await requestJson(join(base,cfg.chatPath),{method:'POST',headers:{'content-type':'application/json',...headersFor(provider,saved.api_key)},body:JSON.stringify(body)},{timeoutMs,retries:1,provider});
      output=data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
    }
    if(!String(output).trim()) throw new Error(`${cfg.label} không trả về nội dung.`);
    return {text:String(output).trim(),latencyMs:Date.now()-started};
  } catch(err) {
    err.provider=provider;
    err.model=model;
    err.latencyMs=Date.now()-started;
    throw err;
  }
}
