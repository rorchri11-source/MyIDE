import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { escapeHtml } from './utils.js';

let dom;

before(() => {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  global.document = dom.window.document;
});

after(() => {
  delete global.document;
});

test('escapeHtml', async (t) => {
  await t.test('returns empty string for null or undefined', () => {
    assert.strictEqual(escapeHtml(null), '');
    assert.strictEqual(escapeHtml(undefined), '');
  });

  await t.test('returns normal text unchanged', () => {
    assert.strictEqual(escapeHtml('Hello world'), 'Hello world');
  });

  await t.test('escapes HTML special characters', () => {
    assert.strictEqual(escapeHtml('<script>alert("test & pass")</script>'), '&lt;script&gt;alert("test &amp; pass")&lt;/script&gt;');
  });

  await t.test('handles quotes exactly as the browser DOM does', () => {
    // Note: the browser's innerHTML does not escape double quotes or single quotes when they are text content
    assert.strictEqual(escapeHtml('< > & " \''), '&lt; &gt; &amp; " \'');
  });

  await t.test('handles numbers and non-string inputs', () => {
    assert.strictEqual(escapeHtml(12345), '12345');
    assert.strictEqual(escapeHtml(0), '0');
    assert.strictEqual(escapeHtml(false), 'false');
  });
});
