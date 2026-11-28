// G06a: the move_anchor action (P5.4b): parser, plan guard (never applied directly), and the view's write on confirmation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const { parseMapChat, MAP_CHAT_ACTION_KINDS, MAP_CHAT_SCHEMA } = load('core/steps/map-chat/step.ts');
const { buildMapChatContext } = load('core/map-chat-context.ts');
const { planFor } = load('core/map-chat-plan.ts');
const { chatPlanGroupOf } = load('core/map-chat-layout.ts');

const plain = value => JSON.parse(JSON.stringify(value));
const outline = [{ id: 'r', title: 'Root', summary: '', parentId: null, depth: 0 }];
const annotated = (extra = {}) => ({ id: 'img1', kind: 'annotated', note: 'Beef cuts', anchors: [{ id: 'anc-1', x: 0.25, y: 0.5, note: 'Ribeye' }], relations: [], imageAttached: true, ...extra });
const ctx = selectedImage => buildMapChatContext({ mapTitle: 'Steak', outline, selected: [], references: [], snippets: [], files: [], activeFile: null, history: [], selectedImage });
const move = (fields = {}) => ({ kind: 'move_anchor', imageId: 'img1', anchorId: 'anc-1', x: 0.8, y: 0.2, ...fields });
const parse = (items, context = ctx(annotated())) => plain(parseMapChat(JSON.stringify({ reply: 'ok', actions: items }), context));
const codes = result => result.rejected.map(entry => entry.code);
const planContext = { selectedCount: 0, nodeIds: ['r'], parents: { r: null } };

test('G06a kinds: move_anchor is the last of 31 kinds and in the schema enum', () => {
  assert.equal(MAP_CHAT_ACTION_KINDS.length, 31);
  assert.equal(MAP_CHAT_ACTION_KINDS.at(-1), 'move_anchor');
  assert.ok(MAP_CHAT_SCHEMA.properties.actions.items.properties.kind.enum.includes('move_anchor'));
});
test('G06a parse: a valid move names an existing anchor of the selected picture and keeps x and y as given', () => {
  const result = parse([move()]);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.actions, [{ kind: 'move_anchor', imageId: 'img1', anchorId: 'anc-1', x: 0.8, y: 0.2 }]);
  assert.deepEqual(parse([move({ x: 0, y: 1 })]).actions[0].x, 0, 'the edges are in range');
});
test('G06a parse: an empty imageId means the selected picture', () => {
  const result = parse([move({ imageId: '' })]);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.actions[0].imageId, 'img1');
});
test('G06a parse (counter-example): out-of-range, non-finite or missing coordinates are rejected, not clamped', () => {
  for (const bad of [{ x: 1.01 }, { x: -0.01 }, { y: 2 }, { y: -1 }, { x: '0.5' }, { y: null }, { x: undefined }]) {
    const result = parse([move(bad)]);
    assert.deepEqual(result.actions, [], JSON.stringify(bad));
    assert.deepEqual(codes(result), ['bad_value'], JSON.stringify(bad));
  }
});
test('G06a parse (counter-example): an unknown anchor id, an anchor: ref, another picture or no picture selected is rejected', () => {
  assert.deepEqual(codes(parse([move({ anchorId: 'nope' })])), ['unknown_node']);
  assert.deepEqual(codes(parse([move({ anchorId: 'anchor:p1' })])), ['unknown_node']);
  assert.deepEqual(codes(parse([move({ imageId: 'img9' })])), ['no_image']);
  assert.deepEqual(codes(parse([move()], ctx(undefined))), ['no_image']);
  assert.deepEqual(codes(parse([move()], ctx({ id: 'img2', kind: 'plain' }))), ['no_image']);
});
test('G06a plan: move_anchor is always a plan, even in "apply at once", with auto-apply on and with a picture attached', () => {
  const action = plain(move());
  for (const options of [
    {},
    { imageMode: 'direct' },
    { imageMode: 'direct', imageAttached: true },
    { imageMode: 'direct', imageAttached: true, autoApply: true },
    { autoApply: true },
    { imageMode: 'preview', imageAttached: true }
  ]) {
    const plan = planFor([action], planContext, options);
    assert.ok(plan, JSON.stringify(options));
    assert.ok(plan.reasons.includes('move_anchor_confirm'), JSON.stringify(options));
  }
  // Mixed with image-safe actions it still holds the whole reply.
  const mixed = planFor([{ kind: 'add_anchor', imageId: 'img1', ref: 'p1', x: 0.1, y: 0.1, note: '' }, action], planContext, { imageMode: 'direct', imageAttached: true, autoApply: true });
  assert.ok(mixed.reasons.includes('move_anchor_confirm'));
});
test('G06a plan: a reply without move_anchor is judged as before', () => {
  const add = { kind: 'add_anchor', imageId: 'img1', ref: 'p1', x: 0.1, y: 0.1, note: '' };
  assert.equal(planFor([add], planContext, { imageMode: 'direct', imageAttached: true }), null);
  assert.deepEqual(plain(planFor([add], planContext, { imageMode: 'preview', imageAttached: true }).reasons), ['image_preview']);
});
test('G06a group: move_anchor is a change', () => assert.equal(chatPlanGroupOf('move_anchor'), 'change'));
test('G06a parse: the picture file path comes from the selected picture, a reply-supplied imageRef is ignored', () => {
  const withPath = ctx(annotated({ path: 'attachments/a.png' }));
  assert.equal(parse([move()], withPath).actions[0].imageRef, 'attachments/a.png');
  assert.equal(parse([move({ imageRef: 'attachments/evil.png' })], withPath).actions[0].imageRef, 'attachments/a.png');
  assert.equal('imageRef' in parse([move({ imageRef: 'attachments/evil.png' })]).actions[0], false, 'no selected path: nothing is taken from the reply');
  assert.equal(JSON.stringify(withPath.json).includes('attachments/a.png'), false, 'the path is never sent to the model');
  assert.equal(MAP_CHAT_SCHEMA.properties.actions.items.properties.imageRef, undefined);
});
