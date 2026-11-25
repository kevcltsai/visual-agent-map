const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const S = require('./support.cjs');
const map = load('core/map-chat-records.ts');
const topic = load('core/topic-chat-records.ts');

test('chat record codecs share framing without sharing payload validation', () => {
  const valid = { v: 1, type: 'turn', id: 'a', at: 'now', kind: 'ask', mode: 'quick', message: 'hi' };
  const text = ['', JSON.stringify(valid), '{"v":1,"type":"unknown"}', '{"v":2}', '{"type":"turn"}', '[]', 'null', '{'].join('\r\n');
  const m = map.parseRecord(text);
  const t = topic.parseTopicChat(text);
  assert.deepEqual(S.plain(m), { lines: [valid, { v: 1, type: 'unknown' }], skipped: 4, unrecoverable: true, cleanEnd: false });
  assert.deepEqual(S.plain(t), { lines: [valid], skipped: 5, unrecoverable: true, cleanEnd: false });
  for (const parse of [map.parseRecord, topic.parseTopicChat]) {
    assert.equal(parse('').cleanEnd, true);
    assert.equal(parse(text + '\n').cleanEnd, true);
    assert.equal(parse('{"v":null}').unrecoverable, true);
    assert.equal(parse('{"type":"turn"}').unrecoverable, false);
  }
});

test('chat record serialization preserves version ownership and field order', () => {
  const input = { type: 'turn', v: 99, id: 'x', at: 'now' };
  const expected = '{"v":1,"type":"turn","id":"x","at":"now"}\n';
  assert.equal(map.serializeLine(input), expected);
  assert.equal(topic.serializeTopicChatLine(input), expected);
  assert.equal(input.v, 99);
});
