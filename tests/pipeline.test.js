import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseReasoning, shouldUseCritique, shouldUseTest } from '../src/pipeline/environments.js';

test('coding task enables reasoning and test environments', () => {
  const a = { difficulty:'medium', kinds:['coding'], wantsWeb:false };
  assert.equal(shouldUseReasoning(a), true);
  assert.equal(shouldUseCritique(a), true);
  assert.equal(shouldUseTest(a), true);
});

test('simple chat does not require extra environments', () => {
  const a = { difficulty:'easy', kinds:['chat'], wantsWeb:false };
  assert.equal(shouldUseReasoning(a), false);
  assert.equal(shouldUseCritique(a), false);
  assert.equal(shouldUseTest(a), false);
});
