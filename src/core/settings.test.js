import { test } from 'node:test';
import assert from 'node:assert';
import { deepMergeDefaults } from './settings.js';

test('deepMergeDefaults', async (t) => {
  await t.test('shallow merge missing keys from defaults', () => {
    const raw = { a: 1 };
    const defaults = { a: 2, b: 3 };
    const result = deepMergeDefaults(raw, defaults);
    assert.deepStrictEqual(result, { a: 1, b: 3 });
  });

  await t.test('deep merge nested objects', () => {
    const raw = { settings: { theme: 'dark' } };
    const defaults = { settings: { theme: 'light', fontSize: 14 } };
    const result = deepMergeDefaults(raw, defaults);
    assert.deepStrictEqual(result, { settings: { theme: 'dark', fontSize: 14 } });
  });

  await t.test('preserves extra keys in raw not in defaults', () => {
    const raw = { a: 1, extra: 'kept' };
    const defaults = { a: 2 };
    const result = deepMergeDefaults(raw, defaults);
    assert.deepStrictEqual(result, { a: 1, extra: 'kept' });
  });

  await t.test('does not deep merge arrays, overwrites completely', () => {
    const raw = { list: [1, 2] };
    const defaults = { list: [3, 4, 5] };
    const result = deepMergeDefaults(raw, defaults);
    assert.deepStrictEqual(result, { list: [1, 2] });
  });

  await t.test('handles null values correctly without throwing TypeError', () => {
    const raw = { nested: null };
    const defaults = { nested: { a: 1 } };
    const result = deepMergeDefaults(raw, defaults);
    assert.deepStrictEqual(result, { nested: null });
  });

  await t.test('handles nested objects when raw has null and default has object', () => {
    const raw = { config: null };
    const defaults = { config: { active: true } };
    const result = deepMergeDefaults(raw, defaults);
    assert.deepStrictEqual(result, { config: null });
  });

  await t.test('overwrites scalar in defaults with object in raw', () => {
    const raw = { value: { nested: true } };
    const defaults = { value: 42 };
    const result = deepMergeDefaults(raw, defaults);
    assert.deepStrictEqual(result, { value: { nested: true } });
  });

  await t.test('handles defaults having null where raw has object', () => {
    const raw = { config: { a: 1 } };
    const defaults = { config: null };
    const result = deepMergeDefaults(raw, defaults);
    assert.deepStrictEqual(result, { config: { a: 1 } });
  });

  await t.test('handles raw missing property and default has object', () => {
    const raw = {};
    const defaults = { config: { a: 1 } };
    const result = deepMergeDefaults(raw, defaults);
    assert.deepStrictEqual(result, { config: { a: 1 } });
  });
});
