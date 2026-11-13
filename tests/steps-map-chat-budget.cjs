// The map chat context's caps and its one total budget (core/map-chat-context.ts): a context within every limit is built byte for
// byte as before; an over-large one is shortened in a fixed order (oldest history, outline, research notes, files and references,
// selected cards) until it fits; and every part that was shortened says so, so the model never takes unread text as read.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { load } = require('./support-replay.cjs');
const ctx = load('core/map-chat-context.ts');
const { buildMapChatContext, isMdStale, MAP_CHAT_CONTEXT_TOKEN_BUDGET, MAP_CHAT_FILE_CHAR_LIMIT, MAP_CHAT_TURN_CHAR_LIMIT, MAP_CHAT_USER_TEXT_CHAR_LIMIT, MAP_CHAT_OUTLINE_CARD_LIMIT, MAP_CHAT_SHORTENED_NOTE, MAP_CHAT_DEFAULT_TURNS } = ctx;
const { estimateMapChatTokens, mapChatStep, MAP_CHAT_TOKEN_BUDGET } = load('core/steps/map-chat/step.ts');
const { prepareStep } = load('core/step-runner.ts');
const { LARGE, zhText } = require('./tools/map-chat-eval/size.cjs');
const FIXTURE = require('./fixtures/map-chat-context-small.json');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const node = (id, title, parentId, depth, summary = `${title} 的摘要`) => ({ id, title, summary, parentId, depth });
const base = { mapTitle: '地圖', outline: [], selected: [], references: [], snippets: [], files: [], history: [] };
const sent = input => JSON.parse(buildMapChatContext(input).json);
const marks = ['truncated', 'outlineSummariesOmitted', 'outlineOmitted', 'earlierTurnsOmitted', 'shortenedNote'];
const hasMark = json => marks.some(m => json.includes(`"${m}"`));

// ---- unchanged when it fits ----

test('a context within every limit is byte for byte what it was before the budget (fixture built before the change)', () => {
  assert.ok(FIXTURE.length >= 40);
  for (const entry of FIXTURE) {
    const json = buildMapChatContext(entry.input).json;
    assert.equal(sha(json), entry.jsonSha256, entry.id);
    assert.ok(!hasMark(json), `${entry.id}: no shortening field`);
  }
});

test('a context under every cap and the total but not small (300 cards, a 30k-character file, 12 rounds) is unchanged too', () => {
  const input = {
    ...base,
    outline: [node('r', '根', null, 0, '根'), ...Array.from({ length: 299 }, (_, i) => node(`n${i}`, `卡${i}`, 'r', 1, zhText(100, i + 1)))],
    files: [{ path: 'Notes/big.md', content: zhText(30000, 3) }],
    history: Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: zhText(800, i + 5) })),
    maxTurns: 12,
    userTexts: [{ id: 'u1', parentId: 'r', text: zhText(3000, 9) }],
    summaries: [{ id: 's1', parentId: 'r', members: ['n1'], text: zhText(3000, 10) }]
  };
  const json = buildMapChatContext(input).json;
  assert.ok(estimateMapChatTokens(json) > MAP_CHAT_CONTEXT_TOKEN_BUDGET * 0.9, 'close to the total budget');
  // Hash of the same input built with core/map-chat-context.ts as it was before the total budget.
  assert.equal(sha(json), 'ebe36948d8b0dbd782be3039b779caf9c468369c21522cd875c79226288f5f4f');
});

// ---- every part that is shortened says so ----

/** Fails unless every way `out` differs from `input` is marked in `out`. */
function assertMarked(input, out, label) {
  const windowed = (input.maxTurns ?? MAP_CHAT_DEFAULT_TURNS) ? input.history.slice(-(input.maxTurns ?? MAP_CHAT_DEFAULT_TURNS) * 2) : [];
  let anyNew = false;
  if (out.outline.length < input.outline.length) {
    assert.equal(out.outlineOmitted, input.outline.length - out.outline.length, `${label}: outlineOmitted`);
    anyNew = true;
  } else assert.equal(out.outlineOmitted, undefined, label);
  if (input.outline.length && out.outline.some(n => n.summary === undefined)) {
    assert.equal(out.outlineSummariesOmitted, true, `${label}: outlineSummariesOmitted`);
    assert.ok(out.outline.every(n => n.summary === undefined), label);
    anyNew = true;
  }
  const textPart = (whole, part, what) => {
    if (part.text === whole) return assert.equal(part.truncated, undefined, `${label}: ${what} whole`);
    assert.equal(part.truncated, true, `${label}: ${what} truncated`);
    assert.equal(part.totalChars, whole.length, `${label}: ${what} totalChars`);
    assert.ok(whole.startsWith(part.text), `${label}: ${what} is the beginning`);
    anyNew = true;
  };
  input.files.forEach((file, i) => {
    textPart(file.content, { ...out.files[i], text: out.files[i].content }, `files[${i}]`);
    if (out.files[i].truncated) assert.equal(out.files[i].contentHash, null);
  });
  if (input.activeFile && !out.activeFile.sameAsListedFile) {
    textPart(input.activeFile.content, { ...out.activeFile, text: out.activeFile.content }, 'activeFile');
    if (out.activeFile.truncated) assert.equal(out.activeFile.contentHash, null);
  }
  (input.userTexts ?? []).forEach((item, i) => textPart(item.text, out.userTexts[i], `userTexts[${i}]`));
  (input.summaries ?? []).forEach((item, i) => textPart(item.text, out.summaries[i], `summaries[${i}]`));
  const omittedTurns = windowed.length - out.earlierTurns.length;
  assert.equal(out.earlierTurnsOmitted, omittedTurns || undefined, `${label}: earlierTurnsOmitted`);
  if (omittedTurns) anyNew = true;
  const kept = windowed.slice(windowed.length - out.earlierTurns.length);
  kept.forEach((turn, i) => textPart(turn.text, out.earlierTurns[i], `earlierTurns[${i}]`));
  for (const [list, what] of [[input.selected, 'selected'], [input.references, 'references']])
    list.forEach((ref, i) => assert.ok(out[what][i].detail === ref.detail || out[what][i].detailOmitted === true, `${label}: ${what}[${i}] whole or detailOmitted`));
  const sentCards = new Set([...out.selected, ...out.references].filter(r => r.detail !== undefined).map(r => r.id));
  for (const note of input.researchNotes ?? []) {
    if (!note.detail.trim() || sentCards.has(note.id)) continue;
    const whole = (out.researchNotes ?? []).some(n => n.id === note.id && n.detail === note.detail);
    assert.ok(whole || (out.researchDeferred ?? []).some(d => d.id === note.id), `${label}: research ${note.id} sent whole or listed in researchDeferred`);
  }
  assert.equal(out.shortenedNote, anyNew ? MAP_CHAT_SHORTENED_NOTE : undefined, `${label}: shortenedNote`);
}

const casesInput = k => { const { message, language, ...input } = k.input; return input; };

test('every large case of the eval fits the total budget, is sent, and marks each part it shortened', () => {
  for (const k of LARGE) {
    const input = casesInput(k);
    const built = buildMapChatContext(input);
    assert.ok(estimateMapChatTokens(built.json) <= MAP_CHAT_CONTEXT_TOKEN_BUDGET, k.id);
    assertMarked(input, JSON.parse(built.json), k.id);
    const request = { message: k.input.message, context: built, language: 'zh-TW', model: 'claude:haiku', reasoning: 'low' };
    assert.doesNotThrow(() => prepareStep(mapChatStep, request), k.id);
  }
});

test('all the large parts at once still fit, and each one that was shortened is marked', () => {
  const pick = id => casesInput(LARGE.find(k => k.id === id));
  const input = {
    ...base,
    outline: [...pick('SZ1').outline, ...pick('SZ2').outline.map(n => ({ ...n, id: `x${n.id}`, parentId: n.parentId && `x${n.parentId}` }))],
    selected: pick('SZ2').selected,
    researchNotes: pick('SZ3').researchNotes,
    history: pick('SZ4').history,
    files: [{ path: 'Notes/附件.md', content: zhText(120_000, 41) }],
    activeFile: pick('SZ5').activeFile,
    userTexts: [{ id: 'u1', parentId: 'r', text: zhText(9000, 42) }],
    summaries: [{ id: 's1', parentId: 'r', members: [], text: zhText(9000, 43) }]
  };
  const built = buildMapChatContext(input);
  const out = JSON.parse(built.json);
  assert.ok(estimateMapChatTokens(built.json) <= MAP_CHAT_CONTEXT_TOKEN_BUDGET);
  assertMarked(input, out, 'combined');
  assert.ok(out.selected.filter(s => s.detail !== undefined).length >= 1, 'selected cards are kept longest: some still have their notes');
  assert.ok(out.earlierTurns.length >= 2, 'the newest question and answer stay');
  assert.ok(estimateMapChatTokens(mapChatStep.render({ message: '整理', context: built, language: 'zh-TW' })) < MAP_CHAT_TOKEN_BUDGET);
});

// ---- caps on parts that had none ----

test('caps: a file, the active note, an earlier message, a user text and a summary bracket are cut to their limit and marked', () => {
  const long = n => 'a'.repeat(n);
  const input = {
    ...base,
    outline: [node('r', 'R', null, 0)],
    files: [{ path: 'Notes/f.md', content: long(MAP_CHAT_FILE_CHAR_LIMIT + 10) }],
    activeFile: { path: 'Notes/a.md', content: long(MAP_CHAT_FILE_CHAR_LIMIT + 1) },
    history: [{ role: 'user', text: long(MAP_CHAT_TURN_CHAR_LIMIT + 5) }, { role: 'assistant', text: 'ok' }],
    userTexts: [{ id: 'u', parentId: 'r', text: long(MAP_CHAT_USER_TEXT_CHAR_LIMIT + 1) }],
    summaries: [{ id: 's', parentId: 'r', members: [], text: long(MAP_CHAT_USER_TEXT_CHAR_LIMIT + 1) }]
  };
  const built = buildMapChatContext(input);
  const out = JSON.parse(built.json);
  assert.equal(out.files[0].content.length, MAP_CHAT_FILE_CHAR_LIMIT);
  assert.equal(out.activeFile.content.length, MAP_CHAT_FILE_CHAR_LIMIT);
  assert.equal(out.earlierTurns[0].text.length, MAP_CHAT_TURN_CHAR_LIMIT);
  assert.equal(out.earlierTurns[1].truncated, undefined);
  assert.equal(out.userTexts[0].text.length, MAP_CHAT_USER_TEXT_CHAR_LIMIT);
  assert.equal(out.summaries[0].text.length, MAP_CHAT_USER_TEXT_CHAR_LIMIT);
  assertMarked(input, out, 'caps');
  // A cut file has no baseline: an edit of it is refused as stale, and it is not a basis of new cards.
  assert.ok(isMdStale(built.mdHashes, 'Notes/f.md', input.files[0].content));
  assert.ok(isMdStale(built.mdHashes, 'Notes/a.md', input.activeFile.content));
  assert.ok(!built.basis.read.some(entry => entry.path === 'Notes/f.md' || entry.path === 'Notes/a.md'));
  assert.deepEqual([...built.sourcePaths], ['Notes/f.md', 'Notes/a.md']);
});

test('caps: a cut never splits a surrogate pair', () => {
  const content = 'a'.repeat(MAP_CHAT_FILE_CHAR_LIMIT - 1) + '𠀀tail';
  const out = sent({ ...base, files: [{ path: 'n.md', content }] });
  assert.equal(out.files[0].content, 'a'.repeat(MAP_CHAT_FILE_CHAR_LIMIT - 1));
});

test('caps: an outline past the card limit loses its deepest level first, so every card sent keeps its parent', () => {
  const outline = [node('r', 'R', null, 0, 's')];
  for (let i = 0; i < 40; i++) {
    outline.push(node(`a${i}`, `A${i}`, 'r', 1, 's'));
    for (let j = 0; j < 40; j++) outline.push(node(`a${i}b${j}`, `B${i}-${j}`, `a${i}`, 2, 's'));
  }
  assert.ok(outline.length > MAP_CHAT_OUTLINE_CARD_LIMIT);
  const built = buildMapChatContext({ ...base, outline });
  const out = JSON.parse(built.json);
  assert.equal(out.outline.length, 41);
  assert.equal(out.outlineOmitted, outline.length - 41);
  assert.equal(out.outlineDepthLimit, 1);
  const ids = new Set(out.outline.map(n => n.id));
  assert.ok(out.outline.every(n => n.parentId === null || ids.has(n.parentId)));
  assert.equal(built.nodeIds.length, outline.length, 'cards left out of the outline are still cards a reply may name');
  assert.equal(out.shortenedNote, MAP_CHAT_SHORTENED_NOTE);
});

// ---- the order things shrink in ----

/** Which parts of `out` were shortened, as a set of names. */
function shrunk(input, out) {
  const parts = new Set();
  if (out.earlierTurnsOmitted) parts.add('history');
  if (out.outlineSummariesOmitted || out.outlineOmitted) parts.add('outline');
  if ((out.researchDeferred ?? []).length) parts.add('research');
  if (out.files.some(f => f.truncated) || out.activeFile?.truncated || out.references.some(r => r.detailOmitted)) parts.add('files');
  if (out.selected.some(s => s.detailOmitted)) parts.add('selected');
  return parts;
}

test('order: as the budget tightens, older history goes first, then the outline, research notes, files and references, selected cards last', () => {
  const ref = (id, n) => ({ id, title: id, summary: id, detail: zhText(n, id.length + 50), path: `Maps/Notes/${id}.md` });
  const input = {
    ...base,
    outline: [node('r', '根', null, 0, zhText(200, 1)), ...Array.from({ length: 40 }, (_, i) => node(`c${i}`, `卡${i}`, 'r', 1, zhText(200, i + 2))), ...Array.from({ length: 40 }, (_, i) => node(`d${i}`, `細${i}`, `c${i}`, 2, zhText(200, i + 60)))],
    selected: [ref('sel', 3000)],
    references: [ref('refx', 3000)],
    files: [{ path: 'Notes/f.md', content: zhText(40_000, 7) }],
    researchNotes: [{ id: 'c1', title: '卡1', path: 'Maps/Notes/c1.md', detail: zhText(6000, 8) }, { id: 'c2', title: '卡2', path: 'Maps/Notes/c2.md', detail: zhText(6000, 9) }],
    history: Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: zhText(1500, i + 20) }))
  };
  const full = estimateMapChatTokens(buildMapChatContext(input).json);
  const firstAt = {};
  let previous = new Set();
  for (let budget = full; budget > 1000 && !('selected' in firstAt); budget = Math.floor(budget * 0.9)) {
    const built = buildMapChatContext({ ...input, tokenBudget: budget });
    const now = shrunk(input, JSON.parse(built.json));
    for (const part of previous) assert.ok(now.has(part), `at ${budget}: once ${part} is shortened it stays shortened`);
    for (const part of now) if (!(part in firstAt)) firstAt[part] = budget;
    previous = now;
  }
  const order = Object.entries(firstAt).sort((a, b) => b[1] - a[1]).map(([part]) => part);
  assert.deepEqual(order, ['history', 'outline', 'research', 'files', 'selected']);
});

test('a context that cannot be shortened enough (a huge selected snippet) is still refused by the step, not sent', () => {
  const built = buildMapChatContext({ ...base, snippets: [{ path: 'n.md', text: '中'.repeat(130_000) }] });
  assert.throws(() => prepareStep(mapChatStep, { message: '整理', context: built, language: 'zh-TW', model: 'claude:haiku', reasoning: 'low' }), error => error.code === 'over_budget');
});
