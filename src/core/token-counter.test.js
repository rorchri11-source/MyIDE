import { test } from 'node:test';
import assert from 'node:assert';
import { truncateMessages, estimateTokens, countMessageTokens, countMessagesTokens } from './token-counter.js';

test('truncateMessages', async (t) => {
  await t.test('returns empty array when messages is empty', () => {
    assert.deepStrictEqual(truncateMessages([], 100), []);
  });

  await t.test('keeps all messages if within maxTokens', () => {
    const messages = [
      { role: 'system', content: 'system' }, // 6 chars -> 2 tokens + 3 = 5 tokens
      { role: 'user', content: 'hi' } // 2 chars -> 1 token + 3 = 4 tokens
    ]; // total 9 tokens
    assert.deepStrictEqual(truncateMessages(messages, 20), messages);
  });

  await t.test('preserves system message and drops older messages to fit maxTokens', () => {
    const messages = [
      { role: 'system', content: 'sys' }, // 3 chars -> 1 + 3 = 4 tokens
      { role: 'user', content: 'hello world!' }, // 12 chars -> 3 + 3 = 6 tokens
      { role: 'user', content: 'hi' } // 2 chars -> 1 + 3 = 4 tokens
    ]; // total 14 tokens

    // maxTokens = 10. System (4) + 'hi' (4) = 8. 'hello world!' (6) would exceed 10.
    const result = truncateMessages(messages, 10);
    assert.deepStrictEqual(result, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' }
    ]);
  });

  await t.test('works without system message', () => {
    const messages = [
      { role: 'user', content: 'hello world!' }, // 6 tokens
      { role: 'user', content: 'hi' } // 4 tokens
    ];

    // maxTokens = 5. Keeps only 'hi'.
    const result = truncateMessages(messages, 5);
    assert.deepStrictEqual(result, [
      { role: 'user', content: 'hi' }
    ]);
  });

  await t.test('keeps only system message if maxTokens is very small', () => {
    const messages = [
      { role: 'system', content: 'sys' }, // 4 tokens
      { role: 'user', content: 'hi' } // 4 tokens
    ];

    // maxTokens = 5. System (4) fits, 'hi' (4) makes it 8.
    const result = truncateMessages(messages, 5);
    assert.deepStrictEqual(result, [
      { role: 'system', content: 'sys' }
    ]);
  });

  await t.test('returns system message even if it alone exceeds maxTokens', () => {
    const messages = [
      { role: 'system', content: 'very long system message' }, // 24 chars = 6 + 3 = 9 tokens
      { role: 'user', content: 'hi' } // 4 tokens
    ];

    // maxTokens = 5. System already exceeds, but it is preserved.
    const result = truncateMessages(messages, 5);
    assert.deepStrictEqual(result, [
      { role: 'system', content: 'very long system message' }
    ]);
  });
});

test('estimateTokens', async (t) => {
  await t.test('calculates correct number of tokens', () => {
    assert.strictEqual(estimateTokens('1234'), 1);
    assert.strictEqual(estimateTokens('12345'), 2);
    assert.strictEqual(estimateTokens(''), 0);
  });
});

test('countMessageTokens', async (t) => {
  await t.test('calculates correct number of tokens for message with content', () => {
    assert.strictEqual(countMessageTokens({ content: '1234' }), 4);
    assert.strictEqual(countMessageTokens({ content: '12345' }), 5);
  });

  await t.test('calculates tokens for message with tool_calls', () => {
    const msg = { content: '12', tool_calls: [{ name: 'test' }] };
    assert.strictEqual(countMessageTokens(msg), 8);
  });
});

test('countMessagesTokens', async (t) => {
  await t.test('sums up tokens correctly', () => {
    const messages = [
      { content: '1234' }, // 4 tokens
      { content: '12345' } // 5 tokens
    ];
    assert.strictEqual(countMessagesTokens(messages), 9);
  });
});
