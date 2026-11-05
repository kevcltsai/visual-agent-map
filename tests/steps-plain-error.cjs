// Ticket 40: AI failures reach the screen as plain words; raw provider text stays in the log and the collapsed details.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const { plainFailure, cardFailure } = load('ai/plain-error.ts');
const { translate } = load('i18n.ts');

const RAW = '{"type":"error","error":{"type":"invalid_request_error","message":"Invalid schema for response_format \'codex_output_schema\'"},"status":400}';
const LOCALES = ['en', 'zh-TW', 'zh-CN'];

test('raw provider JSON never reaches the main message, in any language', () => {
  for (const locale of LOCALES) {
    const text = plainFailure('AI task failed', new Error(RAW), locale);
    assert.doesNotMatch(text, /[{}]|"type"|invalid_request|schema|400/i, text);
    assert.ok(text.length > 0 && text.length < 200, text);
  }
});

test('a card failure keeps the raw text only as technical details', () => {
  const failure = cardFailure(RAW, 'en');
  assert.doesNotMatch(failure.text, /[{}]|"type"/);
  assert.equal(failure.technical, RAW);
  const short = cardFailure('Codex is not signed in.', 'en');
  assert.equal(short.technical, null);
  assert.match(short.text, /Codex is not signed in/);
});

test('the message says what failed, that the map is untouched, and what retry costs', () => {
  const text = plainFailure('AI task failed', new Error(RAW), 'en');
  assert.match(text, /AI task failed/);
  assert.match(text, /map was not changed/i);
  assert.match(text, /1 more AI call/);
  assert.equal(text.split(/(?<=\.)\s/).length, 3);
});

test('a usage limit is named as the cause', () => {
  assert.match(plainFailure('AI task failed', new Error('usage limit reached'), 'en'), /usage limit/);
});

test('the concurrent-write stop explains the real cause, never "The topic changed"', () => {
  for (const key of ['ui.the_topic_changed_the_synthesis_draft_was_not_saved', 'ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved']) {
    for (const locale of LOCALES) {
      const text = translate(locale, key);
      assert.doesNotMatch(text, /The topic changed|議題已變更|议题已变更/, text);
    }
  }
  assert.match(translate('en', 'ui.the_topic_changed_the_synthesis_draft_was_not_saved'), /overwrite/);
});

test('every new string exists in all three languages', () => {
  for (const key of ['error.plain_map_unchanged', 'error.plain_next_retry', 'error.plain_card_context', 'ui.technical_details', 'ui.copy_technical_details']) {
    const english = translate('en', key);
    assert.notEqual(english, key);
    for (const locale of ['zh-TW', 'zh-CN']) assert.notEqual(translate(locale, key), english, `${key} ${locale}`);
  }
});

test('the plugin recordFailure logs the raw text and returns plain words for the notice', () => {
  const S = require('./support.cjs');
  const { default: Plugin } = S.load('main.ts', { obsidian: S.obsidian });
  const logged = [];
  const shown = Plugin.prototype.recordFailure.call({ logs: { appendLog: (level, text) => logged.push(text) } }, 'AI task failed', new Error(RAW));
  assert.doesNotMatch(shown, /[{}]|"type"/);
  assert.ok(logged.some(line => line.includes(RAW)), 'the raw text stays in the log');
});
