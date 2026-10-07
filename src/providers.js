import { getProvider } from './db.js';

export const PROVIDERS = {
  gemini: { label:'Google Gemini', baseUrl:'https://generativelanguage.googleapis.com/v1beta', modelsPath:'/models', description:'AI đa năng của Google; hỗ trợ chat, code, phân tích và đa phương thức.' },
  groq: { label:'Groq', baseUrl:'https://api.groq.com/openai/v1', modelsPath:'/models', chatPath:'/chat/completions', description:'API tương thích OpenAI, nổi bật về tốc độ phản hồi.' },
  openrouter: { label:'OpenRouter', baseUrl:'https://openrouter.ai/api/v1', modelsPath:'/models', chatPath:'/chat/completions', description:'Cổng truy cập nhiều nhà cung cấp và model AI.' },
  deepseek: { label:'DeepSeek', baseUrl:'https://api.deepseek.com', modelsPath:'/models', chatPath:'/chat/completions', description:'Mạnh về lập trình, chat và suy luận.' },
  openai: { label:'OpenAI', baseUrl:'https://api.openai.com/v1', modelsPath:'/models', chatPath:'/chat/completions', description:'Hệ sinh thái model AI tổng quát của OpenAI.' },
  anthropic: { label:'Anthropic Claude', baseUrl:'https://api.anthropic.com/v1', modelsPath:'/models', chatPath:'/messages', description:'Claude; mạnh về phân tích, viết và lập luận.' }
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
      u.pathname = path.replace(/\/v1$/i,'') || '/';
    } else if (provider === 'groq') {
      if (!/\/openai\/v1$/i.test(path)) u.pathname = /api\.groq\.com$/i.test(host) ? '/openai/v1' : `${path}/openai/v1`;
    } else if (provider === 'openrouter') {
      if (!/\/api\/v1$/i.test(path)) u.pathname = /openrouter\.ai$/i.test(host) ? '/api/v1' : `${path}/api/v1`;
    } else if (provider === 'openai') {
      if (!/\/v1$/i.test(path)) u.pathname = /api\.openai\.com$/i.test(host) ? '/v1' : `${path}/v1`;
    } else if (provider === 'anthropic') {
      if (!/\/v1$/i.test(path)) u.pathname = /api\.anthropic\.com$/i.test(host) ? '/v1' : `${path}/v1`;
    }
    return clean(u.toString());
  } catch {
    return clean(b);
  }
}

function join(base, path) { return `${clean(base)}/${String(path || '').replace(/^\/+/, '')}`; }

function headersFor(provider, key) {
  if (provider === 'gemini') return {};
  if (provider === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  return { Authorization: `Bearer ${key}` };
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, headers:{Accept:'application/json', ...(options.headers || {})} });
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw:text }; }
    if (!res.ok) {
      const detail = data?.error?.message || data?.error?.type || data?.message || data?.raw || `${res.status} ${res.statusText}`;
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('Hết thời gian chờ API (20 giây).');
    throw err;
  } finally { clearTimeout(timer); }
}

function normalizeModel(provider, raw) {
  let id = raw?.id || raw?.name;
  if (!id) return null;
  id = String(id).replace(/^models\//,'');
  const methods = Array.isArray(raw?.supportedGenerationMethods) ? raw.supportedGenerationMethods : [];
  const lower = id.toLowerCase();
  const nonChat = /(embedding|embed|whisper|tts|speech|moderation|rerank|guard|image|audio)/i.test(lower);
  if (provider === 'gemini' && !methods.includes('generateContent')) return null;
  if (nonChat) return null;
  const pricingPrompt = raw?.pricing?.prompt;
  return {
    id,
    name:id,
    description:String(raw?.description || raw?.displayName || `Model ${id}`).slice(0,300),
    context:raw?.context_window || raw?.context_length || raw?.inputTokenLimit || raw?.top_provider?.context_length || null,
    free: provider === 'openrouter' && (/:free$/i.test(id) || Number(pricingPrompt || 1) === 0)
  };
}

export async function listRemoteModels(providerName) {
  const provider = String(providerName || '').toLowerCase();
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Provider '${provider}' chưa được hỗ trợ.`);
  const saved = await getProvider(provider);
  if (!saved?.api_key) throw new Error(`Chưa có API key cho ${cfg.label}.`);
  const base = normalizeBase(provider, saved.base_url || cfg.baseUrl);
  const url = provider === 'gemini'
    ? `${join(base,'models')}?key=${encodeURIComponent(saved.api_key)}`
    : join(base,cfg.modelsPath);
  const data = await requestJson(url,{headers:headersFor(provider,saved.api_key)});
  const list = Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return list.map(x=>normalizeModel(provider,x)).filter(Boolean);
}

export async function testProvider(providerName) {
  const models = await listRemoteModels(providerName);
  return {ok:true,message:`Kết nối OK · tìm thấy ${models.length} model chat`,models};
}

export async function chat({provider:providerName,model,messages,temperature=.7,maxTokens=1200}) {
  const provider=String(providerName||'').toLowerCase();
  const cfg=PROVIDERS[provider]; const saved=await getProvider(provider);
  if(!cfg||!saved?.api_key) throw new Error(`Provider ${provider} chưa được cấu hình API.`);
  const base=normalizeBase(provider,saved.base_url||cfg.baseUrl);
  if(provider==='gemini'){
    const contents=messages.filter(m=>m.role!=='system').map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:String(m.content??'')}]}));
    const system=messages.find(m=>m.role==='system')?.content;
    const body={contents,generationConfig:{temperature,maxOutputTokens:maxTokens}};
    if(system) body.systemInstruction={parts:[{text:String(system)}]};
    const data=await requestJson(`${join(base,`models/${encodeURIComponent(model)}:generateContent`)}?key=${encodeURIComponent(saved.api_key)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return data?.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('')||'';
  }
  if(provider==='anthropic'){
    const system=messages.find(m=>m.role==='system')?.content;
    const body={model,max_tokens:maxTokens,temperature,messages:messages.filter(m=>m.role!=='system').map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content??'')}))};
    if(system) body.system=String(system);
    const data=await requestJson(join(base,cfg.chatPath),{method:'POST',headers:{'content-type':'application/json',...headersFor(provider,saved.api_key)},body:JSON.stringify(body)});
    return data?.content?.map(x=>x.text||'').join('')||'';
  }
  const data=await requestJson(join(base,cfg.chatPath),{method:'POST',headers:{'content-type':'application/json',...headersFor(provider,saved.api_key)},body:JSON.stringify({model,messages,temperature,max_tokens:maxTokens})});
  return data?.choices?.[0]?.message?.content||'';
}

export function suggestedModels(providerName=null){
  const all=[
    {provider:'gemini',name:'gemini-2.5-flash',free:true,description:'Model đa năng nhanh, phù hợp chat và code.'},
    {provider:'gemini',name:'gemini-2.5-flash-lite',free:true,description:'Bản nhẹ, ưu tiên tốc độ và tiết kiệm.'},
    {provider:'groq',name:'llama-3.1-8b-instant',free:true,description:'Model nhỏ, phản hồi nhanh; phù hợp chatbot.'},
    {provider:'deepseek',name:'deepseek-chat',free:true,description:'Model chat đa năng của DeepSeek; quyền dùng phụ thuộc tài khoản.'},
    {provider:'deepseek',name:'deepseek-reasoner',free:true,description:'Model thiên về suy luận; quyền dùng phụ thuộc tài khoản.'},
    {provider:'openrouter',name:'openrouter/free',free:true,description:'Điểm vào model miễn phí của OpenRouter; model thực tế có thể thay đổi.'},
    {provider:'openai',name:'gpt-5',free:false,description:'Model OpenAI; yêu cầu quyền truy cập phù hợp.'},
    {provider:'anthropic',name:'claude-sonnet',free:false,description:'Claude; tên model thực tế phụ thuộc danh mục API hiện tại.'}
  ];
  return providerName?all.filter(x=>x.provider===String(providerName).toLowerCase()):all;
}
