import 'dotenv/config';

const n = (key, fallback, min = -Infinity, max = Infinity) => {
  const value = Number(process.env[key] ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
};
const b = (key, fallback) => String(process.env[key] ?? fallback).toLowerCase() === 'true';
const s = (key, fallback = '') => String(process.env[key] ?? fallback).trim();

const compatible = [
  ['deepseek', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'https://api.deepseek.com/v1', 8, 9],
  ['groq', 'GROQ_API_KEY', 'GROQ_MODEL', 'https://api.groq.com/openai/v1', 10, 7],
  ['mistral', 'MISTRAL_API_KEY', 'MISTRAL_MODEL', 'https://api.mistral.ai/v1', 8, 8],
  ['openrouter', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'https://openrouter.ai/api/v1', 8, 9],
  ['xai', 'XAI_API_KEY', 'XAI_MODEL', 'https://api.x.ai/v1', 8, 9],
  ['together', 'TOGETHER_API_KEY', 'TOGETHER_MODEL', 'https://api.together.xyz/v1', 8, 8],
  ['fireworks', 'FIREWORKS_API_KEY', 'FIREWORKS_MODEL', 'https://api.fireworks.ai/inference/v1', 8, 8],
  ['cerebras', 'CEREBRAS_API_KEY', 'CEREBRAS_MODEL', 'https://api.cerebras.ai/v1', 10, 7],
  ['perplexity', 'PERPLEXITY_API_KEY', 'PERPLEXITY_MODEL', 'https://api.perplexity.ai', 8, 8],
  ['sambanova', 'SAMBANOVA_API_KEY', 'SAMBANOVA_MODEL', 'https://api.sambanova.ai/v1', 9, 7],
  ['nvidia', 'NVIDIA_API_KEY', 'NVIDIA_MODEL', 'https://integrate.api.nvidia.com/v1', 7, 8]
];

const configOmniRouteEnabled = () => b('OMNIROUTE_ENABLED', false);

const custom = (() => {
  try {
    return JSON.parse(process.env.CUSTOM_AI_PROVIDERS_JSON || '[]').map(p => ({
      ...p,
      family: p.family || 'compatible',
      apiKey: process.env[p.apiKeyEnv] || p.apiKey,
      model: process.env[p.modelEnv] || p.model
    }));
  } catch { return []; }
})().filter(p => p.name && p.apiKey && p.model);

export const config = {
  botName: process.env.BOT_NAME || 'AI Council',
  discord: {
    token: process.env.DISCORD_TOKEN,
    replyAll: b('DISCORD_REPLY_ALL_MESSAGES', true),
    allowedChannels: new Set((process.env.DISCORD_ALLOWED_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean)),
    allowedGuilds: new Set((process.env.DISCORD_ALLOWED_GUILD_IDS || '').split(',').map(s => s.trim()).filter(Boolean)),
    adminUsers: new Set((process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)),
    adminRoles: new Set((process.env.ADMIN_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean)),
    moderatorRoles: new Set((process.env.MODERATOR_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean)),
    requireMentionForNonAdmins: b('REQUIRE_MENTION_FOR_NON_ADMINS', false),
    allowDM: b('ALLOW_DMS', true),
    clientId: process.env.DISCORD_CLIENT_ID || ''
  },
  db: {
    url: process.env.DATABASE_URL,
    ssl: b('PGSSL', true)
  },
  omniroute: {
    enabled: b('OMNIROUTE_ENABLED', false),
    url: process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1',
    apiKey: process.env.OMNIROUTE_API_KEY || '',
    model: process.env.OMNIROUTE_MODEL || 'auto',
    timeoutMs: n('OMNIROUTE_TIMEOUT_MS', 90000)
  },
  web: {
    enabled: b('WEB_ENABLED', true),
    provider: process.env.WEB_PROVIDER || 'auto',
    firecrawlUrl: process.env.FIRECRAWL_BASE_URL || 'https://api.firecrawl.dev/v2',
    firecrawlKey: process.env.FIRECRAWL_API_KEY || '',
    searxngUrl: process.env.SEARXNG_URL || '',
    timeoutMs: n('WEB_TIMEOUT_MS', 30000),
    maxResults: n('WEB_MAX_RESULTS', 6),
    deepMaxResults: n('WEB_DEEP_MAX_RESULTS', 10),
    cacheTtlMs: n('WEB_CACHE_TTL_MS', 300000)
  },
  headroom: {
    enabled: b('HEADROOM_ENABLED', true),
    url: process.env.HEADROOM_BASE_URL || process.env.HEADROOM_URL || 'http://127.0.0.1:8787',
    apiKey: process.env.HEADROOM_API_KEY || '',
    timeoutMs: n('HEADROOM_TIMEOUT_MS', 30000),
    retries: n('HEADROOM_RETRIES', 1),
    failOpen: b('HEADROOM_FAIL_OPEN', true),
    tokenBudget: n('HEADROOM_TOKEN_BUDGET', 0)
  },
  ecosystem: {
    semanticCache: { enabled: b('SEMANTIC_CACHE_ENABLED', true), ttlMs: n('SEMANTIC_CACHE_TTL_MS', 300000), maxEntries: n('SEMANTIC_CACHE_MAX_ENTRIES', 500) },
    professionalMode: b('PROFESSIONAL_MODE', true),
    memoryStyle: process.env.MEMORY_STYLE || 'hybrid',
    evalSampling: n('EVAL_SAMPLING_RATE', 0.15)
  },
  environments: {
    reasoning: { enabled: b('REASONING_ENV_ENABLED', true), maxChars: n('REASONING_ENV_MAX_CHARS', 3500) },
    critique: { enabled: b('CRITIQUE_ENV_ENABLED', true), maxChars: n('CRITIQUE_ENV_MAX_CHARS', 4500) },
    test: { enabled: b('TEST_ENV_ENABLED', true), maxChars: n('TEST_ENV_MAX_CHARS', 4500) }
  },
  routing: {
    easy: n('EASY_THRESHOLD', 30),
    medium: n('MEDIUM_THRESHOLD', 65),
    maxDebateModels: n('MAX_DEBATE_MODELS', 4),
    maxCharsPerAI: n('DEBATE_MAX_CHARS_PER_AI', 6500),
    timeoutMs: n('AI_TIMEOUT_MS', 60000),
    maxRetries: n('AI_MAX_RETRIES', 2),
    memoryMessages: n('MEMORY_MESSAGES', 14),
    collabContextTtlSec: n('COLLAB_CONTEXT_TTL_SEC', 3600),
    collabMaxEntries: n('COLLAB_CONTEXT_MAX_ENTRIES', 100),
    providerCooldownMs: n('PROVIDER_COOLDOWN_MS', 30000),
    maxParallelAI: n('MAX_PARALLEL_AI', 4),
    headroomMinChars: n('HEADROOM_MIN_CHARS', 1200)
  },
  image: {
    url: process.env.COMFYUI_URL || 'http://127.0.0.1:8188',
    workflow: process.env.COMFYUI_WORKFLOW || 'workflows/txt2img_api.json',
    checkpoint: process.env.COMFYUI_CHECKPOINT || 'YOUR_CHECKPOINT.safetensors',
    timeoutMs: n('IMAGE_TIMEOUT_MS', 180000)
  },
  providers: [
    {
      name: 'openai', family: 'openai', apiKey: process.env.OPENAI_API_KEY,
      model: s('OPENAI_MODEL'), speed: 8, quality: 10
    },
    {
      name: 'anthropic', family: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY,
      model: s('ANTHROPIC_MODEL'), speed: 7, quality: 10
    },
    {
      name: 'gemini', family: 'gemini', apiKey: process.env.GEMINI_API_KEY,
      model: s('GEMINI_MODEL', 'gemini-2.5-flash'), speed: 9, quality: 9
    },
    ...(configOmniRouteEnabled() && process.env.OMNIROUTE_API_KEY ? [{
      name: 'omniroute', family: 'compatible', apiKey: process.env.OMNIROUTE_API_KEY,
      model: process.env.OMNIROUTE_MODEL || 'auto',
      baseURL: process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1',
      speed: 9, quality: 9, gateway: true
    }] : []),
    ...compatible.map(([name, apiKeyEnv, modelEnv, baseURL, speed, quality]) => ({
      name, family: 'compatible', apiKey: process.env[apiKeyEnv], model: process.env[modelEnv], baseURL, speed, quality,
      gateway: name === 'omniroute'
    })).filter(p => p.name !== 'omniroute' || configOmniRouteEnabled()),
    ...custom
  ].filter(p => p.apiKey && p.model)
};

if (!config.discord.token) console.warn('[config] DISCORD_TOKEN chưa được cấu hình.');
if (!config.db.url) console.warn('[config] DATABASE_URL chưa được cấu hình.');
