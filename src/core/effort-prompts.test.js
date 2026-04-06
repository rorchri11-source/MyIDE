import { test } from 'node:test';
import assert from 'node:assert';
import { buildEffortPrompt, THINKING_WITH_TOOLS, NO_THINKING_PROMPT } from './effort-prompts.js';

test('buildEffortPrompt', async (t) => {
  await t.test('returns NO_THINKING_PROMPT when level is off', () => {
    assert.strictEqual(buildEffortPrompt('off'), NO_THINKING_PROMPT);
  });

  await t.test('returns thinking prompt with low directive when level is low', () => {
    const result = buildEffortPrompt('low');
    assert.ok(result.startsWith(THINKING_WITH_TOOLS));
    assert.ok(result.includes('Effort: Low'));
  });

  await t.test('returns thinking prompt with medium directive when level is medium', () => {
    const result = buildEffortPrompt('medium');
    assert.ok(result.startsWith(THINKING_WITH_TOOLS));
    assert.ok(result.includes('Effort: Medium'));
  });

  await t.test('returns thinking prompt with high directive when level is high', () => {
    const result = buildEffortPrompt('high');
    assert.ok(result.startsWith(THINKING_WITH_TOOLS));
    assert.ok(result.includes('Effort: High'));
  });

  await t.test('returns thinking prompt with max directive when level is max', () => {
    const result = buildEffortPrompt('max');
    assert.ok(result.startsWith(THINKING_WITH_TOOLS));
    assert.ok(result.includes('Effort: Maximum'));
  });

  await t.test('falls back to medium directive for unknown levels', () => {
    const result = buildEffortPrompt('unknown');
    assert.ok(result.startsWith(THINKING_WITH_TOOLS));
    assert.ok(result.includes('Effort: Medium'));
  });

  await t.test('falls back to medium directive for missing or invalid levels', () => {
    const undefinedResult = buildEffortPrompt();
    assert.ok(undefinedResult.startsWith(THINKING_WITH_TOOLS));
    assert.ok(undefinedResult.includes('Effort: Medium'));

    const nullResult = buildEffortPrompt(null);
    assert.ok(nullResult.startsWith(THINKING_WITH_TOOLS));
    assert.ok(nullResult.includes('Effort: Medium'));

    const emptyResult = buildEffortPrompt('');
    assert.ok(emptyResult.startsWith(THINKING_WITH_TOOLS));
    assert.ok(emptyResult.includes('Effort: Medium'));
  });
});
