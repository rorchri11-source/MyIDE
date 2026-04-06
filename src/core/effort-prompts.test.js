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

  await t.test('falls back to medium directive for missing or falsy levels', () => {
    const falsyValues = [undefined, null, '', false, 0];
    for (const val of falsyValues) {
      const result = buildEffortPrompt(val);
      assert.ok(result.startsWith(THINKING_WITH_TOOLS), `Failed for value: ${String(val)}`);
      assert.ok(result.includes('Effort: Medium'), `Failed for value: ${String(val)}`);
    }
  });
});
