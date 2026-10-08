import test from 'node:test';
import assert from 'node:assert/strict';
process.env.AI_SECRET_KEY ||= 'test-secret-key';
const U = await import('../src/utils.js');
const R = await import('../src/routing.js');
const H = await import('../src/health.js');
const C = await import('../src/crypto.js');

// ── chunkText ──
test('chunkText: mọi đoạn ≤ giới hạn và code fence luôn cân bằng', () => {
  const code = Array.from({ length: 200 }, (_, i) => `console.log(${i}); // dòng số ${i}`).join('\n');
  const text = `Mở đầu\n\n\`\`\`js\n${code}\n\`\`\`\n\nKết thúc ${'abc '.repeat(100)}`;
  const parts = U.chunkText(text, 500);
  assert.ok(parts.length > 3);
  for (const p of parts) {
    assert.ok(p.length <= 500, `đoạn dài ${p.length}`);
    assert.equal((p.match(/```/g) || []).length % 2, 0, 'fence lẻ trong:\n' + p.slice(0, 80));
  }
  assert.ok(parts.join('').includes('console.log(199)'));
});
test('chunkText: văn bản ngắn giữ nguyên, chuỗi rỗng không lỗi', () => {
  assert.deepEqual(U.chunkText('xin chào', 1900), ['xin chào']);
  assert.deepEqual(U.chunkText('', 1900), ['']);
});
test('chunkText: từ cực dài không có khoảng trắng vẫn bị cắt', () => {
  const parts = U.chunkText('x'.repeat(5000), 1000);
  assert.ok(parts.every(p => p.length <= 1000)); assert.equal(parts.join('').length, 5000);
});

// ── collectAnswers ──
test('collectAnswers: trả sớm khi đủ kết quả + grace, bỏ qua lỗi', async () => {
  const d = (ms, v, rej) => new Promise((res, rj) => setTimeout(() => (rej ? rj(new Error(v)) : res(v)), ms));
  const t0 = Date.now();
  const r = await U.collectAnswers([d(10, 'a'), d(20, 'b', true), d(30, 'c'), d(40, 'd'), d(5000, 'slow')], { deadlineMs: 4000, enough: 3, graceMs: 100 });
  assert.deepEqual(r.sort(), ['a', 'c', 'd']);
  assert.ok(Date.now() - t0 < 1000);
});
test('collectAnswers: hết hạn thì trả những gì có', async () => {
  const r = await U.collectAnswers([new Promise(r => setTimeout(() => r('x'), 10)), new Promise(() => {})], { deadlineMs: 100, enough: 5 });
  assert.deepEqual(r, ['x']);
});
test('collectAnswers: tất cả lỗi → mảng rỗng', async () => {
  assert.deepEqual(await U.collectAnswers([Promise.reject(new Error('1')), Promise.reject(new Error('2'))]), []);
});

// ── limiter / cooldown ──
test('createLimiter: không vượt quá số đồng thời và từ chối khi hàng đợi đầy', async () => {
  const lim = U.createLimiter(2, 2);
  let active = 0, peak = 0;
  const job = () => lim.run(async () => { active++; peak = Math.max(peak, active); await U.sleep(20); active--; });
  await Promise.all([job(), job(), job(), job()]);
  assert.equal(peak, 2);
  const blocked = [job(), job(), job(), job(), job()];
  const res = await Promise.allSettled(blocked);
  assert.ok(res.some(r => r.status === 'rejected' && r.reason.code === 'BUSY'));
});
test('Cooldowns: lần 2 trong khoảng cooldown bị chặn', () => {
  const c = new U.Cooldowns();
  assert.equal(c.hit('u', 1000, 0), 0);
  assert.equal(c.hit('u', 1000, 400), 600);
  assert.equal(c.hit('u', 1000, 1001), 0);
});

// ── routing ──
test('difficulty: nhận diện tiếng Việt có dấu (trước đây \\b làm hỏng "đánh giá", "toàn bộ")', () => {
  assert.equal(R.difficulty('hello').name, 'DỄ');
  assert.equal(R.difficulty('xin chào bạn').name, 'DỄ');
  // "đánh giá" bắt đầu/kết thúc bằng ký tự non-ASCII nên regex \b cũ KHÔNG BAO GIỜ khớp → điểm 0.
  assert.ok(R.difficulty('đánh giá toàn bộ').score >= 4);
  assert.equal(R.difficulty('Hãy phân tích và đánh giá toàn bộ kiến trúc hệ thống, viết code fix lỗi từng bước').name, 'KHÓ');
  assert.equal(R.difficulty('```js\nconsole.log(1)\n``` sửa lỗi giúp mình').tier >= 2, true);
});

const mkState = () => ({
  providers: [
    { name: 'groq', api_key: 'k'.repeat(10), avg_latency_ms: 300, fail_count: 0 },
    { name: 'gemini', api_key: 'k'.repeat(10), avg_latency_ms: 1200, fail_count: 0 },
    { name: 'nokey', api_key: '', avg_latency_ms: 100, fail_count: 0 },
    { name: 'cool', api_key: 'k'.repeat(10), avg_latency_ms: 100, fail_count: 0, cooldown_until: new Date(Date.now() + 60000) }
  ],
  models: [
    { provider: 'groq', name: 'small', tier: 1, free: true, enabled: true, hidden: false },
    { provider: 'groq', name: 'big', tier: 3, free: true, enabled: true, hidden: false },
    { provider: 'gemini', name: 'mid', tier: 2, free: true, enabled: true, hidden: false },
    { provider: 'gemini', name: 'hiddenone', tier: 3, free: true, enabled: true, hidden: true },
    { provider: 'gemini', name: 'off', tier: 3, free: true, enabled: false, hidden: false },
    { provider: 'nokey', name: 'x', tier: 3, free: true, enabled: true, hidden: false },
    { provider: 'cool', name: 'x', tier: 3, free: true, enabled: true, hidden: false }
  ],
  settings: { freeFirst: true, defaultProvider: null, defaultModel: null }
});

test('rankCandidates: loại key rỗng / cooldown / ẩn / tắt và ưu tiên đúng tầng', () => {
  const s = mkState();
  const r = R.rankCandidates({ ...s, tier: 3 });
  assert.deepEqual(r.map(c => `${c.provider}/${c.model}`).sort(), ['gemini/mid', 'groq/big', 'groq/small']);
  assert.equal(r[0].model, 'big');
  assert.equal(R.rankCandidates({ ...s, tier: 1 })[0].model, 'small');
});
test('rankCandidates: model đang cooldown bị loại', () => {
  const s = mkState();
  const r = R.rankCandidates({ ...s, tier: 3, modelCooling: (p, m) => p === 'groq' && m === 'big' });
  assert.ok(!r.some(c => c.model === 'big'));
});
test('pickAttempts: ưu tiên provider khác nhau trước khi lặp lại provider', () => {
  const ranked = [{ provider: 'a', model: '1' }, { provider: 'a', model: '2' }, { provider: 'b', model: '3' }, { provider: 'c', model: '4' }];
  assert.deepEqual(R.pickAttempts(ranked, 3).map(c => c.provider), ['a', 'b', 'c']);
  assert.deepEqual(R.pickCouncil(ranked, 2).map(c => c.provider), ['a', 'b']);
});
test('rankAnswer: phạt câu bị cắt/từ chối/nhắc cấu hình, thưởng câu đầy đủ', () => {
  const good = 'Đây là câu trả lời đầy đủ và chi tiết về vấn đề bạn hỏi, được kết thúc đúng cách.';
  assert.ok(R.rankAnswer(good, 'hỏi') > R.rankAnswer('Xin lỗi, tôi không thể giúp việc này được.', 'hỏi'));
  assert.ok(R.rankAnswer(good, 'hỏi') > R.rankAnswer(good, 'hỏi', true));
  assert.ok(R.rankAnswer(good, 'hỏi') > R.rankAnswer('Hãy cấu hình API key của bạn trước khi sử dụng dịch vụ này nhé', 'hỏi'));
});

// ── health ──
test('classifyFailure: phạm vi cooldown đúng', () => {
  const f = s => H.classifyFailure(Object.assign(new Error('x'), { status: s }), 0);
  assert.equal(f(401).scope, 'provider'); assert.ok(f(401).cooldownMs >= 300000);
  assert.equal(f(404).scope, 'model'); assert.equal(f(404).refreshCatalog, true);
  assert.equal(f(403).scope, 'model'); assert.equal(f(400).scope, 'model');
  assert.equal(f(429).scope, 'provider'); assert.equal(f(503).scope, 'provider');
  const backoff = H.classifyFailure(Object.assign(new Error('x'), { status: 503 }), 3).cooldownMs;
  assert.ok(backoff > f(503).cooldownMs);
});
test('health: cooldown model/provider áp dụng tức thì', () => {
  H.clearHealth();
  H.coolModel('Groq', 'm', 1000, 0); H.coolProvider('GEMINI', 1000, 0);
  assert.equal(H.isModelCooling('groq', 'm', 500), true);
  assert.equal(H.isModelCooling('groq', 'm', 1500), false);
  assert.equal(H.isProviderCooling('gemini', 500), true);
});

// ── crypto ──
test('crypto: mã hóa khứ hồi + nhận diện ciphertext', () => {
  const enc = C.encrypt('sk-secret-123456');
  assert.equal(C.decrypt(enc), 'sk-secret-123456');
  assert.equal(C.looksEncrypted(enc), true);
  assert.equal(C.looksEncrypted('sk-ant-api03-abcdef'), false);
  assert.equal(C.looksEncrypted('AIzaSyD-plaintextkey.with.dots'), false);
});

// ── redact / stripThink ──
test('redact & stripThink', () => {
  assert.equal(U.redact('lỗi với key SECRETKEY99 ở đây', ['SECRETKEY99']), 'lỗi với key *** ở đây');
  assert.equal(U.stripThink('<think>a\nb</think>\nKết quả'), 'Kết quả');
  assert.equal(U.stripThink('suy nghĩ</think>Đáp án'), 'Đáp án');
});

test('crypto v2: ghi bằng scrypt (tiền tố v2.) và vẫn đọc được dữ liệu cũ SHA-256', async () => {
  const nodeCrypto = await import('node:crypto');
  const iv = nodeCrypto.randomBytes(12);
  const key = nodeCrypto.createHash('sha256').update(process.env.AI_SECRET_KEY).digest();
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update('sk-legacy-key-123456', 'utf8'), cipher.final()]);
  const legacy = `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
  assert.equal(C.decrypt(legacy), 'sk-legacy-key-123456');
  assert.equal(C.isLegacyCiphertext(legacy), true);
  const fresh = C.encrypt('sk-new-key-123456');
  assert.ok(fresh.startsWith('v2.'));
  assert.equal(C.isLegacyCiphertext(fresh), false);
  assert.equal(C.looksEncrypted(fresh), true);
  assert.equal(C.decrypt(fresh), 'sk-new-key-123456');
  assert.notEqual(C.encrypt('same'), C.encrypt('same'));
});

test('history: mặc định tách theo (kênh, người dùng) — người sau không thấy ngữ cảnh người trước', async () => {
  const Hs = await import('../src/history.js');
  const kA = Hs.historyKey('chan', 'A'), kB = Hs.historyKey('chan', 'B');
  assert.notEqual(kA, kB);
  Hs.addTurn(kA, 'A: bí mật của A', 'trả lời cho A');
  assert.equal(Hs.getHistory(kA).length, 2);
  assert.equal(Hs.getHistory(kB).length, 0);
  Hs.clearHistory('chan', 'A');
  assert.equal(Hs.getHistory(kA).length, 0);
});

test('requestJson: AbortSignal hủy ngay, không retry, đánh dấu aborted', async () => {
  const P = await import('../src/providers.js');
  const ac = new AbortController();
  globalThis.fetch = (url, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
  const p = P.requestJson('http://x', {}, { timeoutMs: 5000, retries: 3, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, e => e.aborted === true && e.name === 'AbortError');
  await assert.rejects(P.requestJson('http://x', {}, { signal: ac.signal }), e => e.aborted === true);
});
