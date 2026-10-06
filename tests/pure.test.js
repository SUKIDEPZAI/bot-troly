import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, detectTargetAIs } from '../src/router.js';
import { normalizeUserLanguage } from '../src/language.js';
import { chooseExecutionBranch } from '../src/pipeline/branches.js';

test('AI target detection recognizes direct provider names', () => {
  assert.deepEqual(detectTargetAIs('ChatGPT và Claude cùng review code').map(x => x.provider), ['openai','anthropic']);
});

test('Vietnamese shortcuts are normalized without replacing original text', () => {
  const r = normalizeUserLanguage('bro check hộ cái web này pls');
  assert.equal(r.style, 'young_slang');
  assert.match(r.normalized, /kiểm tra/);
  assert.equal(r.original, 'bro check hộ cái web này pls');
});

test('explicit multiple AI targets force collaboration even for easy tasks', () => {
  const a = classify('ChatGPT và Gemini cùng viết câu chào');
  assert.equal(a.explicitAI, true);
  assert.equal(chooseExecutionBranch(a, 2), 'collaborative-2');
});

test('URL is routed to web-url branch', () => {
  const a = classify('đọc https://example.com rồi tóm tắt');
  assert.equal(a.webMode, 'url');
  assert.equal(chooseExecutionBranch(a, 1), 'web-url');
});
