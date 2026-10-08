import test from 'node:test';
import assert from 'node:assert/strict';
process.env.AI_SECRET_KEY ||= 'test-secret-key';
const P = await import('../src/providers.js');

test('classifyTier: model lớn không bị xếp nhầm vào tầng nhẹ', () => {
  const t = id => P.classifyTier(id);
  assert.equal(t('llama-3.3-70b-versatile'), 3);
  assert.equal(t('meta-llama/llama-3.1-405b-instruct'), 3);
  assert.equal(t('gpt-oss-120b'), 3);
  assert.equal(t('llama-3.1-8b-instant'), 1);
  assert.equal(t('gemini-2.5-flash-lite'), 1);
  assert.equal(t('gemini-2.5-flash'), 2);
  assert.equal(t('gemini-2.5-pro'), 3);
  assert.equal(t('deepseek-reasoner'), 3);
  assert.equal(t('deepseek-chat'), 2);
  assert.equal(t('qwen/qwen3-32b'), 2);
  assert.equal(t('mixtral-8x7b-instruct'), 2);
  assert.equal(t('claude-haiku-4-5-20251001'), 1);
});

test('paramSizeB đọc đúng kích thước', () => {
  assert.equal(P.paramSizeB('llama-3.3-70b-versatile'), 70);
  assert.equal(P.paramSizeB('mixtral-8x7b'), 56);
  assert.equal(P.paramSizeB('qwen3-30b-a3b'), 30);
  assert.equal(P.paramSizeB('deepseek-chat'), null);
});

test('timeout được coi là lỗi tạm thời; 401/404 thì không', () => {
  assert.equal(P.isTransientError(P.timeoutError('groq')), true);
  assert.equal(P.isTransientError(Object.assign(new Error('x'), { status: 429 })), true);
  assert.equal(P.isTransientError(Object.assign(new Error('x'), { status: 503 })), true);
  assert.equal(P.isTransientError(Object.assign(new Error('x'), { status: 401 })), false);
  assert.equal(P.isTransientError(Object.assign(new Error('x'), { status: 404 })), false);
});

test('normalizeModel lọc model không chat / subscription-only', () => {
  assert.equal(P.normalizeModel('openai', { id: 'text-embedding-3-small' }), null);
  assert.equal(P.normalizeModel('openai', { id: 'gpt-4o-realtime-preview' }), null);
  assert.equal(P.normalizeModel('openai', { id: 'whisper-1' }), null);
  assert.equal(P.normalizeModel('gemini', { name: 'models/x', supportedGenerationMethods: ['embedContent'] }), null);
  const m = P.normalizeModel('openrouter', { id: 'meta-llama/llama-3.3-70b-instruct:free', pricing: { prompt: '0', completion: '0' }, context_length: 131072 });
  assert.equal(m.free, true); assert.equal(m.tier, 3); assert.equal(m.context, 131072);
});

test('OpenAI gpt-5 dùng max_completion_tokens, không gửi temperature', () => {
  const r = P.buildChatRequest({ provider: 'openai', model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], maxTokens: 500, base: 'https://api.openai.com/v1', apiKey: 'k'.repeat(10) });
  assert.ok(r.body.max_completion_tokens >= 500);
  assert.equal(r.body.max_tokens, undefined);
  assert.equal(r.body.temperature, undefined);
});

test('Groq giữ max_tokens + temperature', () => {
  const r = P.buildChatRequest({ provider: 'groq', model: 'llama-3.1-8b-instant', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }], maxTokens: 300, base: 'https://api.groq.com/openai/v1', apiKey: 'k'.repeat(10) });
  assert.equal(r.body.max_tokens, 300);
  assert.equal(r.body.temperature, 0.7);
  assert.equal(r.body.messages[0].role, 'system');
});

test('Gemini: key đi bằng header, không nằm trong URL', () => {
  const r = P.buildChatRequest({ provider: 'gemini', model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], base: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'SECRETKEY123' });
  assert.ok(!r.url.includes('SECRETKEY123'));
  assert.equal(r.headers['x-goog-api-key'], 'SECRETKEY123');
});

test('Anthropic: gộp lượt liên tiếp, bỏ assistant đứng đầu, tách system', () => {
  const r = P.buildChatRequest({ provider: 'anthropic', model: 'claude-sonnet-5-5', messages: [
    { role: 'system', content: 'SYS' }, { role: 'assistant', content: 'old' }, { role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'c' }, { role: 'user', content: 'd' }
  ], base: 'https://api.anthropic.com/v1', apiKey: 'k'.repeat(10) });
  assert.equal(r.body.system, 'SYS');
  assert.deepEqual(r.body.messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.match(r.body.messages[0].content, /a\n\nb/);
});

test('parseChatResponse: bỏ <think>, nhận biết bị cắt', () => {
  const a = P.parseChatResponse('groq', { choices: [{ message: { content: '<think>nghĩ</think>Xin chào' }, finish_reason: 'length' }] });
  assert.equal(a.text, 'Xin chào'); assert.equal(a.truncated, true);
  const g = P.parseChatResponse('gemini', { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
  assert.equal(g.text, 'ok'); assert.equal(g.truncated, false);
});
