import { normalizeUserLanguage } from './language.js';

const IMAGE_WORDS = /(tạo|vẽ|generate|draw|làm|cho)\s*(một|1)?\s*(ảnh|hình|image|picture)|text.?to.?image|chỉnh ảnh|edit ảnh|inpaint|avatar|poster/i;
const CODE_WORDS = /(code|lập trình|html|css|javascript|typescript|python|java|c\+\+|node\.js|sql|postgres|discord\.js|bug|debug|sửa lỗi|fix lỗi|api|json|regex|script|project|dự án|source|repo|github)/i;
const RESEARCH_WORDS = /(tìm kiếm|tra cứu|nghiên cứu|mới nhất|latest|hôm nay|nguồn|source|so sánh|review|thông tin về|search|tìm hiểu)/i;
const FILE_WORDS = /(xuất file|tạo file|gửi file|đính kèm file|export file|download|cho tôi file|lưu thành file|file giúp|gửi bản)/i;
const MATH_WORDS = /(tính|giải phương trình|equation|toán|calculate|calculator|công thức|phần trăm)/i;
const EXPLAIN_WORDS = /(giải thích|explain|hướng dẫn|how to|tại sao|vì sao|là gì|cách làm|chỉ cách)/i;
const TRANSLATE_WORDS = /(dịch|translate|dịch sang|dịch qua|english|tiếng anh|tiếng việt|korean|japanese|trung|chinese)/i;
const SUMMARY_WORDS = /(tóm tắt|tóm gọn|rút gọn|summary|summarize|nói ngắn gọn)/i;
const CREATIVE_WORDS = /(viết truyện|kịch bản|thơ|shayari|caption|meme|ý tưởng|sáng tạo|story|script)/i;
const ADMIN_WORDS = /(quản lý|phân quyền|role|permission|discord|moderator|admin|kick|ban|mute|channel|server)/i;
const WEB_WORDS = /(tìm web|tìm trên web|tìm trên mạng|tìm kiếm web|search web|web search|google|tra web|lên mạng tìm|tìm nguồn|nguồn mới|tin mới|news|tin tức|bài báo|website|trang web|link|url|đọc trang|đọc website|mở link|crawl|scrape|duyệt web|research sâu|deep research)/i;
const URL_WORDS = /https?:\/\/[^\s<>]+/i;

const AI_ALIASES = [
  { provider: 'openai', aliases: ['chatgpt','chat gpt','gpt','openai','open ai'] },
  { provider: 'anthropic', aliases: ['claude','anthropic'] },
  { provider: 'gemini', aliases: ['gemini','google gemini','bard'] },
  { provider: 'deepseek', aliases: ['deepseek','deep seek'] },
  { provider: 'groq', aliases: ['groq'] },
  { provider: 'mistral', aliases: ['mistral','le chat'] },
  { provider: 'openrouter', aliases: ['openrouter'] },
  { provider: 'xai', aliases: ['grok','xai'] },
  { provider: 'together', aliases: ['together ai','together'] },
  { provider: 'fireworks', aliases: ['fireworks ai','fireworks'] },
  { provider: 'cerebras', aliases: ['cerebras'] },
  { provider: 'perplexity', aliases: ['perplexity'] },
  { provider: 'sambanova', aliases: ['sambanova','samba nova'] },
  { provider: 'nvidia', aliases: ['nvidia','nvidia ai'] },
  { provider: 'omniroute', aliases: ['omniroute','omni route','omni-router','omni router','qwen','qwen ai','kimi','moonshot','glm','zhipu','minimax','command r'] }
];

function aliasRegex(alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu');
}

export function detectTargetAIs(text = '') {
  const found = [];
  for (const entry of AI_ALIASES) {
    let best = null;
    for (const alias of entry.aliases) {
      const match = text.match(aliasRegex(alias));
      if (match && (!best || (match.index ?? 0) < best.index)) best = { provider: entry.provider, alias, index: match.index ?? 0 };
    }
    if (best) found.push(best);
  }
  return found.sort((a,b) => a.index - b.index);
}

export function resolveTargetProviders(providers, targets) {
  const byName = new Map(providers.map(p => [p.name.toLowerCase(), p]));
  const selected = [], unavailable = [];
  for (const target of targets) {
    const provider = byName.get(target.provider);
    if (provider) selected.push(provider); else unavailable.push(target);
  }
  return { selected: [...new Map(selected.map(p => [p.name, p])).values()], unavailable };
}

export function classify(text = '') {
  const language = normalizeUserLanguage(text);
  const analysisText = `${text}\n${language.normalized}`;
  const targetAIs = detectTargetAIs(text);
  const kinds = [];
  if (IMAGE_WORDS.test(analysisText)) kinds.push('image');
  if (CODE_WORDS.test(analysisText)) kinds.push('coding');
  if (RESEARCH_WORDS.test(analysisText)) kinds.push('research');
  if (FILE_WORDS.test(analysisText)) kinds.push('file');
  if (MATH_WORDS.test(analysisText)) kinds.push('math');
  if (EXPLAIN_WORDS.test(analysisText)) kinds.push('explain');
  if (TRANSLATE_WORDS.test(analysisText)) kinds.push('translate');
  if (SUMMARY_WORDS.test(analysisText)) kinds.push('summary');
  if (CREATIVE_WORDS.test(analysisText)) kinds.push('creative');
  if (ADMIN_WORDS.test(analysisText)) kinds.push('discord');
  if (WEB_WORDS.test(analysisText) || URL_WORDS.test(text) || kinds.includes('research')) kinds.push('web');
  if (!kinds.length) kinds.push('chat');

  let score = 8 + Math.min(18, Math.floor(text.length / 180) * 4);
  if (kinds.includes('coding')) score += 18;
  if (kinds.includes('research')) score += 12;
  if (kinds.includes('web')) score += 8;
  if (kinds.includes('math')) score += 12;
  if (kinds.includes('file')) score += 8;
  if (kinds.includes('translate') || kinds.includes('summary')) score += 5;
  if (kinds.length >= 2) score += 10;
  if (/(kiến trúc|architecture|hệ thống|multi|database|scale|distributed|bảo mật|security|tối ưu|optimize|algorithm|production|deploy|triển khai)/i.test(analysisText)) score += 20;
  if (text.split(/[.!?\n]/).filter(Boolean).length >= 4) score += 8;
  if (language.hasImperative && text.length > 80) score += 4;
  score = Math.max(0, Math.min(100, score));
  const difficulty = score <= 30 ? 'easy' : score <= 65 ? 'medium' : 'hard';
  const wantsWeb = kinds.includes('web');
  const url = text.match(URL_WORDS)?.[0] || null;
  const webMode = /(deep research|research sâu|nghiên cứu sâu|so sánh nhiều nguồn)/i.test(analysisText) ? 'deep' : (url ? 'url' : (/(news|tin tức|tin mới|bài báo)/i.test(analysisText) ? 'news' : 'search'));
  return { kinds, difficulty, score, mode: kinds.includes('image') ? 'image' : difficulty, wantsFile: FILE_WORDS.test(analysisText), wantsWeb, webMode, url, targetAIs, explicitAI: targetAIs.length > 0, language };
}

export function chooseProviders(providers, analysis, statsMap) {
  if (analysis.explicitAI) return resolveTargetProviders(providers, analysis.targetAIs).selected;
  const scored = providers.map(p => {
    let s = p.quality * 10 + p.speed * 2;
    if (analysis.kinds.includes('coding') && /deepseek|openai|anthropic|mistral|xai|omniroute/i.test(p.name)) s += 18;
    if (analysis.kinds.includes('research') && /perplexity|gemini|openrouter|omniroute/i.test(p.name)) s += 15;
    if (analysis.kinds.includes('math') && /openai|anthropic|gemini|omniroute/i.test(p.name)) s += 10;
    if (analysis.kinds.includes('chat') && /openai|gemini|anthropic|xai|omniroute/i.test(p.name)) s += 8;
    if (p.gateway && analysis.difficulty === 'hard') s += 6;
    const st = statsMap?.[p.name];
    if (st) { s += Number(st.success_rate || 0) * 25; s += Math.max(0, 8 - Number(st.avg_latency || 0) / 2000); }
    return { p, s };
  }).sort((a,b) => b.s - a.s);
  if (analysis.difficulty === 'easy') return scored.slice(0,1).map(x => x.p);
  if (analysis.difficulty === 'medium') return scored.slice(0,2).map(x => x.p);
  return scored.slice(0, Math.max(2, Math.min(4, Number(process.env.MAX_DEBATE_MODELS || 4)))).map(x => x.p);
}
