import { test } from 'node:test';
import assert from 'node:assert';
import { PROMPT_TEMPLATES, getTemplatePrompt, getTemplateList } from './prompt-templates.js';

test('PROMPT_TEMPLATES constant', async (t) => {
  await t.test('has expected template keys', () => {
    const keys = Object.keys(PROMPT_TEMPLATES);
    assert.ok(keys.includes('none'));
    assert.ok(keys.includes('code_review'));
    assert.ok(keys.includes('debug'));
    assert.ok(keys.includes('explain'));
    assert.ok(keys.includes('refactor'));
  });

  await t.test('templates have the correct structure', () => {
    for (const [key, template] of Object.entries(PROMPT_TEMPLATES)) {
      assert.strictEqual(template.id, key, `Template ${key} should have matching id`);
      assert.ok(typeof template.label === 'string', `Template ${key} should have a label string`);
      assert.ok(typeof template.prompt === 'string', `Template ${key} should have a prompt string`);
    }
  });
});

test('getTemplatePrompt', async (t) => {
  await t.test('returns the prompt for a valid ID', () => {
    const prompt = getTemplatePrompt('code_review');
    assert.strictEqual(prompt, PROMPT_TEMPLATES.code_review.prompt);
    assert.ok(prompt.length > 0);
  });

  await t.test('returns an empty string for the none template', () => {
    const prompt = getTemplatePrompt('none');
    assert.strictEqual(prompt, '');
  });

  await t.test('returns an empty string for an unknown ID', () => {
    const prompt = getTemplatePrompt('unknown_id_xyz');
    assert.strictEqual(prompt, '');
  });
});

test('getTemplateList', async (t) => {
  await t.test('returns an array of templates', () => {
    const list = getTemplateList();
    assert.ok(Array.isArray(list));
    assert.strictEqual(list.length, Object.keys(PROMPT_TEMPLATES).length);

    // Check if the array contains the correct items
    for (const item of list) {
      assert.strictEqual(PROMPT_TEMPLATES[item.id], item);
    }
  });
});
