import test from 'node:test';
import assert from 'node:assert/strict';
process.env.AI_SECRET_KEY ||= 'test-secret-key';
const UI = await import('../src/ui.js');

const long = Array.from({ length: 300 }, (_, i) => `Dòng ${i}: nội dung khá dài để buộc chia nhiều phần ${'x'.repeat(30)}`).join('\n');
const auto = { text: long, provider: 'groq', model: 'meta-llama/llama-3.3-70b-versatile', difficulty: { name: 'KHÓ' }, mode: 'auto', truncated: true };
const council = { text: 'Ngắn gọn.', provider: 'gemini', model: 'gemini-2.5-flash', difficulty: { name: 'DỄ' }, mode: 'council', council: { members: ['Groq', 'Google Gemini'], total: 3, judged: true } };

test('renderAnswer (embed): chia phần ≤ giới hạn, nút chỉ ở phần cuối', () => {
  const out = UI.renderAnswer({ result: auto, elapsedMs: 2300, canEmbed: true, requesterId: '1', token: 'abc' });
  assert.ok(out.length > 1);
  out.forEach((p, i) => { p.embeds[0].toJSON(); assert.equal(p.components.length, i === out.length - 1 ? 1 : 0); });
});
test('renderAnswer (plain): ≤ 2000 ký tự/tin nhắn', () => {
  const out = UI.renderAnswer({ result: auto, elapsedMs: 100, canEmbed: false, requesterId: '1', token: 'abc' });
  assert.ok(out.every(p => p.content.length <= 2000));
});
test('renderAnswer: council hiển thị số AI + judge', () => {
  const [p] = UI.renderAnswer({ result: council, elapsedMs: 5000, canEmbed: true, requesterId: '1', token: 't' });
  const e = p.embeds[0].toJSON();
  assert.match(e.footer.text, /2\/3 AI/); assert.match(e.footer.text, /tổng hợp/);
});
test('errorPayload không lộ tên provider/HTTP cho người dùng', () => {
  const e = UI.errorPayload(new Error('Các tuyến AI đều lỗi. Groq/llama: HTTP 401: invalid key sk-xxx'));
  assert.ok(!JSON.stringify(e).includes('sk-xxx')); assert.ok(!JSON.stringify(e).includes('HTTP 401'));
  assert.match(JSON.stringify(UI.errorPayload(new Error('Chưa có AI khả dụng (...)'))), /Chưa có AI khả dụng/);
});
test('bar & providerStatus', () => {
  assert.equal(UI.bar(5, 10, 10), '▰▰▰▰▰▱▱▱▱▱');
  assert.equal(UI.bar(0, 0, 4), '▱▱▱▱');
  assert.equal(UI.providerStatus({ api_key: 'k', cooldown_until: new Date(Date.now() + 5000) }).icon, '🟠');
  assert.equal(UI.providerStatus({ api_key: 'k', last_ok_at: new Date(), avg_latency_ms: 800 }).icon, '🟢');
  assert.equal(UI.providerStatus({ api_key: '' }).icon, '🔴');
});
