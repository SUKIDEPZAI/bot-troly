import test from 'node:test';
import assert from 'node:assert/strict';
process.env.AI_SECRET_KEY ||= 'test-secret-key';
const pg = await import('pg');
const { encrypt } = await import('../src/crypto.js');
const row = n => ({ name: n, base_url: '', api_key_encrypted: encrypt(`key-${n}-1234567890`), last_ok_at: null, last_error: '', fail_count: 0, cooldown_until: null, avg_latency_ms: null });
pg.default.Pool.prototype.query = async (sql, params) => (/api_key_encrypted,last_ok_at/.test(String(sql)) ? { rows: [row(String(params[0]))] } : { rows: [] });
const P = await import('../src/providers.js');

test('catalog Gemini: đọc hết các trang (nextPageToken)', async () => {
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    const second = /pageToken=T2/.test(url);
    const body = second
      ? { models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }] }
      : { models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'T2' };
    return { ok: true, status: 200, statusText: '', headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  P.clearModelCache();
  const models = await P.listRemoteModels('gemini', { force: true });
  assert.deepEqual(models.map(m => m.id).sort(), ['gemini-a', 'gemini-b']);
  assert.equal(urls.length, 2);
  assert.ok(urls.every(u => !u.includes('key-gemini')), 'API key không được nằm trong URL');
});

test('catalog Anthropic: đọc hết các trang (has_more/last_id)', async () => {
  globalThis.fetch = async url => {
    const second = /after_id=m2/.test(url);
    const body = second ? { data: [{ id: 'claude-x' }], has_more: false } : { data: [{ id: 'claude-y' }, { id: 'm2' }], has_more: true, last_id: 'm2' };
    return { ok: true, status: 200, statusText: '', headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  P.clearModelCache();
  const models = await P.listRemoteModels('anthropic', { force: true });
  assert.equal(models.length, 3);
});
