import test from 'node:test';
import assert from 'node:assert/strict';
import { ECOSYSTEM, buildRolePlan, evaluateLightweight } from '../src/integrations/ecosystem.js';

test('ecosystem has at least five projects in every requested category', () => {
  for (const [name, projects] of Object.entries(ECOSYSTEM)) assert.ok(projects.length >= 5, `${name} has fewer than 5 projects`);
});

test('role planner creates specialist branches', () => {
  assert.deepEqual(buildRolePlan({ kinds:['coding'] }), ['architect','implementer','reviewer','test-engineer']);
  assert.deepEqual(buildRolePlan({ kinds:['research'], wantsWeb:true }), ['researcher','source-checker','skeptic','synthesizer']);
  assert.deepEqual(buildRolePlan({ kinds:['discord'] }), ['policy-checker','permission-checker','action-planner','auditor']);
});

test('quality gate catches unfinished coding output', () => {
  const r = evaluateLightweight('```js\n// TODO fix\n```', { kinds:['coding'] });
  assert.equal(r.ok, false);
  assert.ok(r.issues.includes('unfinished-marker'));
});
