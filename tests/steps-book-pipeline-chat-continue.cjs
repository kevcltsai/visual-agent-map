// 04d: in the map chat, "continue" confirms gate 1 of the picture-book pipeline, only when no chain can be resumed. No AI, no UI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const S = require('./support.cjs');

const { MapChatConversation } = load('experiences/visual-map/map-chat-conversation.ts', { obsidian: S.obsidian });
const { isBookGate1Waiting } = load('experiences/visual-map/book-pipeline-ui.ts', { obsidian: S.obsidian });

function rig({ draft = '繼續', last, gate1 } = {}) {
  const log = [];
  const panel = {
    isBusy: false,
    draft,
    transcript: () => (last ? [last] : []),
    clearDraft: () => log.push(['clearDraft']),
    begin: (text, ...rest) => { log.push(['begin', text]); return { text }; },
    attachments: () => [],
    hasTurn: () => true,
    finish: (reply, lines) => log.push(['finish', reply, lines.length]),
    pendingPlan: () => null,
    hasQueuedSteers: () => false
  };
  const ports = {
    panel: () => panel, closed: () => false, path: () => 'Maps/A/Map.md', map: () => ({ id: 'm1' }), notesLoading: () => false,
    selectionIds: () => [], imageId: () => null,
    chain: () => ({
      current: null,
      resumeChatChain: message => { log.push(['resume']); return message.resume === 'ok'; },
      interruptChain: () => log.push(['interrupt']),
      chainForRound: () => { log.push(['chainForRound']); throw new Error('went on to the AI path'); }
    }),
    ...(gate1 ? { bookGate1Confirm: () => { log.push(['gate1']); return gate1(); } } : {})
  };
  return { conv: new MapChatConversation(ports), log };
}
const names = log => log.map(entry => entry[0]);

test('gate 1 and nothing to resume: confirms, shows the reply, never reaches the AI path', async () => {
  const r = rig({ gate1: () => Promise.resolve('confirmed') });
  await r.conv.sendMapChat();
  assert.deepEqual(r.log, [['gate1'], ['begin', '繼續'], ['clearDraft'], ['finish', 'confirmed', 0]]);
  for (const word of ['continue', 'Resume', '继续', ' 繼續！']) {
    const q = rig({ draft: word, gate1: () => Promise.resolve('x') });
    await q.conv.sendMapChat();
    assert.ok(names(q.log).includes('finish'), word);
  }
});

test('a refusal is shown as the reply, not thrown', async () => {
  const r = rig({ gate1: () => Promise.resolve('目前不在「等你確認」階段，不需要確認。') });
  await r.conv.sendMapChat();
  assert.deepEqual(r.log.at(-1), ['finish', '目前不在「等你確認」階段，不需要確認。', 0]);
});

test('gate 1 but a chain can be resumed: the old resume runs, gate 1 is not asked', async () => {
  const r = rig({ last: { resume: 'ok' }, gate1: () => Promise.resolve('x') });
  await r.conv.sendMapChat();
  assert.deepEqual(r.log, [['resume'], ['clearDraft']]);
});

test('resume refused and no gate 1 / no pipeline port: the original path (AI path reached)', async () => {
  for (const gate1 of [undefined, () => null]) {
    const r = rig({ last: { resume: 'no' }, gate1 });
    await assert.rejects(() => r.conv.sendMapChat(), /AI path/);
    assert.ok(!names(r.log).includes('begin'));
  }
});

test('not the word "continue": the original path, gate 1 not asked', async () => {
  const r = rig({ draft: '請繼續寫下去', gate1: () => Promise.resolve('x') });
  await assert.rejects(() => r.conv.sendMapChat(), /AI path/);
  assert.ok(!names(r.log).includes('gate1'));
});

test('isBookGate1Waiting: gate 1 and not driving only', () => {
  const idle = phase => ({ phase, active: false });
  assert.equal(isBookGate1Waiting(idle('gate1'), { phase: 'writing' }), true);
  assert.equal(isBookGate1Waiting(undefined, { phase: 'gate1' }), true, 'after a reload the saved phase counts');
  assert.equal(isBookGate1Waiting({ phase: 'gate1', active: true }, { phase: 'gate1' }), false);
  for (const phase of ['planning', 'writing', 'gate2', 'done']) assert.equal(isBookGate1Waiting(idle(phase), { phase: 'gate1' }), false, phase);
  assert.equal(isBookGate1Waiting(undefined, { phase: 'gate2' }), false);
});

test('the confirmation sentence exists in all three languages', () => {
  const fs = require('node:fs');
  for (const lang of ['en', 'zh-TW', 'zh-CN']) assert.match(fs.readFileSync(`${__dirname}/../i18n/${lang}.ts`, 'utf8'), /"ui\.book_chat_gate1_confirmed": ".{4,}"/, lang);
});
