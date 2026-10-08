import test from 'node:test';
import assert from 'node:assert/strict';
process.env.AI_SECRET_KEY ||= 'test-secret-key';
const pg = await import('pg');
const { encrypt } = await import('../src/crypto.js');

const mkProv = n => ({ id: 1, name: n, base_url: '', api_key_encrypted: encrypt(`key-${n}-1234567890`), last_ok_at: null, last_error: '', fail_count: 0, cooldown_until: null, avg_latency_ms: null, created_at: new Date(), updated_at: new Date() });
const providers = ['groq', 'gemini', 'mistral'].map(mkProv);
const mkModel = (provider, name, tier) => ({ id: Math.random(), provider, name, free: true, enabled: true, description: '', tier, context_length: 8000, capabilities: '', hidden: false });
const models = [mkModel('groq', 'big-70b', 3), mkModel('groq', 'small-8b', 1), mkModel('gemini', 'gem-pro', 3), mkModel('mistral', 'mistral-large-latest', 3)];

pg.default.Pool.prototype.query = async function (sql, params) {
  sql = String(sql);
  if (/api_key_encrypted,last_ok_at/.test(sql)) return { rows: providers.filter(p => p.name === String(params[0]).toLowerCase()) };
  if (/FROM ai_providers/.test(sql)) return { rows: providers.map(p => ({ ...p, api_key: p.api_key_encrypted })) };
  if (/FROM ai_models/.test(sql)) return { rows: models };
  return { rows: [] };
};

let behavior = () => ({ status: 200, text: 'ok' });
const calls = [];
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : {};
  const provider = /groq/.test(url) ? 'groq' : /googleapis/.test(url) ? 'gemini' : 'mistral';
  const model = body.model || decodeURIComponent((String(url).match(/models\/([^:]+):/) || [])[1] || '');
  const isJudge = JSON.stringify(body).includes('biên tập viên tổng hợp');
  calls.push({ provider, model, isJudge });
  const r = behavior({ provider, model, isJudge });
  const payload = provider === 'gemini'
    ? (r.status === 200 ? { candidates: [{ content: { parts: [{ text: r.text }] }, finishReason: 'STOP' }] } : { error: { message: 'boom' } })
    : (r.status === 200 ? { choices: [{ message: { content: r.text }, finish_reason: 'stop' }] } : { error: { message: 'boom' } });
  return { ok: r.status === 200, status: r.status, statusText: 'x', headers: { get: () => null }, text: async () => JSON.stringify(payload) };
};

const E = await import('../src/engine.js');
const H = await import('../src/health.js');
const settings = { freeFirst: true, autoRoute: true, council: true, councilJudge: true, defaultProvider: null, defaultModel: null };
const msgs = [{ role: 'user', content: 'Hãy phân tích kiến trúc hệ thống' }];
const prompt = 'Hãy phân tích kiến trúc hệ thống';
const reset = () => { H.clearHealth(); E.invalidateRoute(); calls.length = 0; };

test('routedChat: provider lỗi 503 → tự fallback sang provider khác và cooldown provider lỗi', async () => {
  reset();
  behavior = ({ provider }) => (provider === 'groq' ? { status: 503 } : { status: 200, text: 'Trả lời từ ' + provider + ' — đầy đủ và rõ ràng.' });
  const r = await E.routedChat({ messages: msgs, prompt, settings });
  assert.notEqual(r.provider, 'groq');
  assert.match(r.text, /Trả lời từ/);
  assert.equal(H.isProviderCooling('groq'), true);
  // lần gọi kế tiếp không đụng groq nữa
  calls.length = 0; E.invalidateRoute();
  await E.routedChat({ messages: msgs, prompt, settings });
  assert.ok(!calls.some(c => c.provider === 'groq'));
});

test('routedChat: 404 chỉ cooldown MODEL, provider vẫn dùng được cho model khác', async () => {
  reset();
  behavior = ({ provider, model }) => (provider === 'groq' && model === 'big-70b' ? { status: 404 } : { status: 200, text: `OK ${provider}/${model} — nội dung đầy đủ.` });
  // ép groq/big được chọn trước
  const s = { ...settings, defaultProvider: 'groq', defaultModel: 'big-70b' };
  const r = await E.routedChat({ messages: msgs, prompt, settings: s });
  assert.ok(r.text.startsWith('OK'));
  assert.equal(H.isModelCooling('groq', 'big-70b'), true);
  assert.equal(H.isProviderCooling('groq'), false);
});

test('routedChat: 401 → cooldown provider dài (≥5 phút)', async () => {
  reset();
  behavior = ({ provider }) => (provider === 'groq' ? { status: 401 } : { status: 200, text: 'OK ' + provider + ' đầy đủ nội dung.' });
  const s = { ...settings, defaultProvider: 'groq', defaultModel: 'big-70b' };
  await E.routedChat({ messages: msgs, prompt, settings: s });
  assert.ok(H.cooldownLeft('groq') >= 290_000);
});

test('routedChat: tất cả lỗi → ném lỗi có thông tin, không treo', async () => {
  reset();
  behavior = () => ({ status: 503 });
  await assert.rejects(E.routedChat({ messages: msgs, prompt, settings }), /đều lỗi|Chưa có AI/);
});

test('councilChat: nhiều AI trả lời → judge tổng hợp', async () => {
  reset();
  behavior = ({ provider, isJudge }) => ({ status: 200, text: isJudge ? 'BẢN TỔNG HỢP CUỐI CÙNG đã hợp nhất các ý đúng.' : `Ý kiến của ${provider}: phân tích khá dài và đầy đủ để được chọn.` });
  const r = await E.councilChat({ messages: msgs, prompt, settings });
  assert.equal(r.mode, 'council');
  assert.equal(r.council.judged, true);
  assert.match(r.text, /TỔNG HỢP/);
  assert.ok(r.council.members.length >= 2);
  assert.equal(calls.filter(c => c.isJudge).length, 1);
});

test('councilChat: judge lỗi → dùng câu trả lời xếp hạng cao nhất', async () => {
  reset();
  behavior = ({ provider, isJudge }) => (isJudge ? { status: 503 } : { status: 200, text: `Ý kiến của ${provider}: phân tích khá dài và đầy đủ để được chọn.` });
  const r = await E.councilChat({ messages: msgs, prompt, settings });
  assert.equal(r.mode, 'council'); assert.equal(r.council.judged, false);
  assert.match(r.text, /Ý kiến của/);
});

test('councilChat: tắt judge → không gọi judge', async () => {
  reset();
  behavior = ({ provider }) => ({ status: 200, text: `Ý kiến của ${provider}: phân tích khá dài và đầy đủ để được chọn.` });
  const r = await E.councilChat({ messages: msgs, prompt, settings: { ...settings, councilJudge: false } });
  assert.equal(r.council.judged, false);
  assert.equal(calls.filter(c => c.isJudge).length, 0);
});

test('councilChat: một provider lỗi vẫn hoạt động với số còn lại', async () => {
  reset();
  behavior = ({ provider, isJudge }) => (provider === 'mistral' ? { status: 500 } : { status: 200, text: isJudge ? 'TỔNG HỢP từ hai AI còn lại, đầy đủ.' : `Ý kiến của ${provider} khá dài và đầy đủ.` });
  const r = await E.councilChat({ messages: msgs, prompt, settings });
  assert.ok(!r.council.members.includes('Mistral AI'));
  assert.match(r.text, /TỔNG HỢP/);
});
