import test from 'node:test';
import assert from 'node:assert/strict';
process.env.AI_SECRET_KEY ||= 'test-secret-key';
const pg = await import('pg');
const executed = [];
pg.default.Pool.prototype.query = async function (sql, params) {
  sql = String(sql); executed.push(sql);
  if (/FROM information_schema\.columns/.test(sql) && params?.[0] === 'ai_providers' && /is_nullable = 'NO'/.test(sql))
    return { rows: [{ column_name: 'api_key_enc' }, { column_name: 'name' }, { column_name: 'legacy_x' }] };
  return { rows: [] };
};
const { initDb } = await import('../src/db.js');

test('initDb gỡ NOT NULL của cột legacy (api_key_enc…) nhưng giữ cột lõi (name)', async () => {
  await initDb();
  const alters = executed.filter(s => /ALTER TABLE ai_providers ALTER COLUMN ".+" DROP NOT NULL/.test(s));
  assert.ok(alters.some(s => s.includes('"api_key_enc"')));
  assert.ok(alters.some(s => s.includes('"legacy_x"')));
  assert.ok(!alters.some(s => s.includes('"name"')));
});
