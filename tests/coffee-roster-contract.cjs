const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
function load(entry) {
  const code = buildSync({ entryPoints: [path.join(root, entry)], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
  const loaded = { exports: {} };
  new Function('module', 'exports', code)(loaded, loaded.exports);
  return loaded.exports;
}
const roster = load('experiences/coffee-tables/roster.ts');
const recommendation = load('experiences/coffee-tables/role-recommendation.ts');
const card = (id, overrides = {}) => ({ id, category: 'experts', roleName: `Role ${id}`, source: 'recommended', description: '', style: '', prompt: '', suggestions: [], locked: false, edited: false, ...overrides });
const table = (cards = [card('a'), card('b')], overrides = {}) => ({ totalParticipants: 3, hostCount: 1, cards, ...overrides });

test('participant total includes hosts while the system observer stays separate', () => {
  assert.equal(roster.guestSeatCount(3, 1), 2);
  assert.equal(roster.COFFEE_OBSERVER_COUNT, 1);
  assert.deepEqual(roster.validateRoster(table()), []);
});

test('persona label normalization matches full-width and repeated whitespace before duplicate checks', () => {
  assert.equal(roster.normalizePersonaLabel('  Ａｖｅｒｙ   Lin  '), 'avery lin');
  assert.ok(roster.validateRoster(table([card('a', { roleName: 'Avery   Lin' }), card('b', { roleName: 'Avery Lin' })])).includes('duplicate-persona-label'));
});

test('roster requires exactly one card per non-host seat and enforces category limits', () => {
  assert.ok(roster.validateRoster(table([card('a')])).includes('seat-count'));
  assert.ok(roster.validateRoster(table(Array.from({ length: 9 }, (_, i) => card(String(i))), { totalParticipants: 10 })).includes('category-limit'));
  assert.ok(roster.validateRoster(table([card('a'), card('a')])).includes('card-identity'));
  assert.ok(roster.validateRoster(table([], { totalParticipants: 1 })).includes('participant-total'));
});

test('clicking a short suggestion appends without replacing existing persona description', () => {
  const current = '先問清楚誰承擔額外工作。';
  assert.equal(roster.appendStyleSuggestion(current, '追問方案在夜間如何運作。'), `${current}\n追問方案在夜間如何運作。`);
  assert.equal(roster.appendStyleSuggestion(current, current), current);
  assert.equal(roster.appendStyleSuggestion('', '  觀察不同時段  '), '觀察不同時段');
});

test('single-card regeneration preserves seat id and fixed category, and skips locked cards', () => {
  const original = table([card('a', { category: 'affected' }), card('b', { locked: true })]);
  const changed = roster.replaceRoleCard(original, 'a', card('new', { category: 'experts', roleName: 'Updated perspective' }));
  assert.equal(changed.cards.length, 2);
  assert.equal(changed.cards[0].id, 'a');
  assert.equal(changed.cards[0].category, 'affected');
  assert.equal(changed.cards[0].roleName, 'Updated perspective');
  assert.equal(roster.replaceRoleCard(original, 'b', card('new')), original);
  const edited = table([card('edited', { edited: true, description: 'Keep my description' })]);
  assert.equal(roster.replaceRoleCard(edited, 'edited', card('new', { description: 'Overwrite' })), edited, 'single-card regeneration preserves edited cards');
});

test('table regeneration fills only unedited and unlocked seats without changing total', () => {
  const original = table([card('a', { edited: true, description: 'Keep my edit' }), card('b', { locked: true }), card('c')], { totalParticipants: 4 });
  const changed = roster.regenerateRoleCards(original, new Map([
    ['a', card('new-a', { description: 'Overwrite' })],
    ['b', card('new-b', { roleName: 'Overwrite' })],
    ['c', card('new-c', { roleName: 'Replacement' })],
  ]));
  assert.equal(changed.totalParticipants, 4);
  assert.equal(changed.cards.length, 3);
  assert.equal(changed.cards[0].description, 'Keep my edit');
  assert.equal(changed.cards[1].roleName, 'Role b');
  assert.equal(changed.cards[2].id, 'c');
  assert.equal(changed.cards[2].roleName, 'Replacement');
});

test('recommendation parser requires exact seats and fixed category; partial output never becomes applicable', () => {
  const source = table([card('expert-seat', { category: 'experts' }), card('affected-seat', { category: 'affected' })]);
  const good = JSON.stringify({ cards: [
    { category: 'experts', roleName: 'Fictional systems auditor', description: 'Reviews how decisions are made.', style: 'Precise and curious.', prompt: 'Ask who can appeal.', suggestions: ['Check failure cases.'] },
    { category: 'affected', roleName: 'Fictional night-shift worker', description: 'Uses the service after regular hours.', style: 'Concrete and direct.', prompt: 'Describe access constraints.', suggestions: [] },
  ] });
  const parsed = recommendation.parseRoleRecommendations(good, source);
  assert.deepEqual([...parsed.keys()], ['expert-seat', 'affected-seat']);
  assert.equal(parsed.get('expert-seat').id, 'expert-seat');
  assert.throws(() => recommendation.parseRoleRecommendations(JSON.stringify({ cards: [{ category: 'experts', roleName: 'One', description: '', style: '', prompt: '', suggestions: [] }] }), source), /exactly 2/);
  assert.throws(() => recommendation.parseRoleRecommendations(good.replace('"category":"affected"', '"category":"generalist"'), source), /fixed role category/);
  assert.throws(() => recommendation.parseRoleRecommendations('not json', source), /not valid JSON/);
});

test('recommendation prompt sends only eligible seats, exact category order, and simulated-fiction framing', () => {
  const source = table([card('locked', { locked: true }), card('edited', { edited: true, category: 'affected' }), card('open', { category: 'experts' })]);
  const prompt = recommendation.roleRecommendationPrompt('How could a library extend hours?', source, 'zh-TW');
  assert.match(prompt, /exactly 1 role cards/);
  assert.match(prompt, /exact category order: experts/);
  assert.match(prompt, /Every persona must be fictional/);
  assert.doesNotMatch(prompt, /affected, experts/);
});

test('legacy guest settings round trip through the roster without losing configured people or seat counts', () => {
  const legacy = {
    counts: { experts: 2, 'cross-domain': 1, generalist: 0, affected: 1 },
    hostCount: 2,
    background: 'A fictional community library scenario.',
    customPrompt: 'Keep minority perspectives visible.',
    guests: [
      {
        id: 'persona-beryl',
        category: 'experts',
        identity: 'Beryl Chen (AI simulation)',
        role: 'community data researcher',
        description: 'Studies how public services reach people after work hours.',
        prompt: 'Ask who is missing from the available data.',
        templateId: 'saved-beryl',
      },
      {
        id: 'persona-night-shift',
        category: 'affected',
        identity: 'Night-shift parent (fictional)',
        role: 'library visitor',
        description: 'Can only visit on weekends and late evenings.',
        prompt: 'Surface scheduling constraints.',
        templateId: 'saved-night-shift',
      },
    ],
  };

  const firstRoster = roster.rosterFromLegacySettings(legacy);
  const adapted = roster.guestSettingsFromRoster(legacy, firstRoster);
  const secondRoster = roster.rosterFromLegacySettings(adapted);

  assert.deepEqual(adapted.counts, legacy.counts);
  assert.equal(adapted.hostCount, legacy.hostCount);
  assert.equal(adapted.background, legacy.background);
  assert.equal(adapted.customPrompt, legacy.customPrompt);
  assert.equal(firstRoster.totalParticipants, legacy.hostCount + Object.values(legacy.counts).reduce((sum, count) => sum + count, 0));
  assert.equal(firstRoster.totalParticipants, secondRoster.totalParticipants);
  assert.equal(firstRoster.hostCount, secondRoster.hostCount);
  assert.equal(roster.COFFEE_OBSERVER_COUNT, 1, 'the observer remains a system-managed seat outside participant total');
  assert.deepEqual(secondRoster.cards.map(item => item.id), firstRoster.cards.map(item => item.id), 'legacy and synthetic card IDs stay stable on repeated adaptation');
  assert.deepEqual(roster.categoryCounts(firstRoster.cards), legacy.counts);

  for (const original of legacy.guests) {
    const restored = adapted.guests.find(item => item.id === original.id);
    assert.ok(restored, `expected saved person ${original.id} to remain in the compatibility guest list`);
    for (const field of ['id', 'category', 'identity', 'role', 'description', 'prompt', 'templateId']) {
      assert.equal(restored[field], original[field], `${original.id} retains ${field}`);
    }
    const card = firstRoster.cards.find(item => item.id === original.id);
    assert.equal(card.roleName, original.identity);
    assert.equal(card.category, original.category);
  }
});

test('opening roster identity and speaker failures route to corrected-opening recovery', () => {
  assert.equal(roster.isOpeningRosterFailure('開桌人物身份與設定不符（缺少設定人物）'), true);
  assert.equal(roster.isOpeningRosterFailure('發言者「Avery｜Topic expert」不在開桌設定名單中'), true);
  assert.equal(roster.isOpeningRosterFailure('Opening persona identity does not match settings'), true);
  assert.equal(roster.isOpeningRosterFailure('Speaker “Avery | Expert” is not in the configured opening roster'), true);
  assert.equal(roster.isOpeningRosterFailure('The opening roster lists “Avery” more than once'), true);
  assert.equal(roster.isOpeningRosterFailure('temporary provider outage'), false);
});
