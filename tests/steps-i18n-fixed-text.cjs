// Fixed text that follows the map's text language (D-2026-10-88/89): synthesis default name, Copy-to suffix, and the
// image-translate language menu. The map text language is always a registry language; output-only languages read English.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const { fixture } = require('./support.cjs');

const text = load('experiences/visual-map/map-text-language.ts');
const { resolveMapTextLanguage, mapTextLanguage, synthesisDefaultName, textLanguageOf } = text;
const i18n = load('i18n.ts');
const mapOf = (title, aim) => ({ id: 'm', title, version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, ...(aim ? { aim } : {}) });
const names = ['A', 'B', 'C', 'D'];
const nameFor = (map, ui, list) => synthesisDefaultName(resolveMapTextLanguage(map, ui), list);

test('map text language: registry languages stay, output-only and unknown values read English', () => {
  assert.equal(mapTextLanguage('zh-TW'), 'zh-TW');
  assert.equal(mapTextLanguage('zh-CN'), 'zh-CN');
  assert.equal(mapTextLanguage('en'), 'en');
  for (const id of ['ja', 'ko', 'es', 'ru', 'vi', 'nonsense', undefined]) assert.equal(mapTextLanguage(id), 'en', String(id));
});

test('synthesis default name: zh-TW, zh-CN, en and ja maps use that language\'s ui text', () => {
  assert.equal(nameFor(mapOf('東京五天自由行'), 'zh-TW', ['甲', '乙']), '整合：甲、乙');
  assert.equal(nameFor(mapOf('东京', { contentLanguage: 'zh-TW' }), 'zh-CN', ['甲', '乙']), '整合：甲、乙');
  assert.equal(nameFor(mapOf('东京', { contentLanguage: 'zh-TW' }), 'zh-CN', names), '整合：A 等 4 个议题');
  assert.equal(nameFor(mapOf('東京五天自由行'), 'zh-TW', names), '整合：A 等 4 個議題');
  assert.equal(nameFor(mapOf('Trip to Tokyo'), 'zh-TW', ['A', 'B']), 'Synthesis: A, B');
  assert.equal(nameFor(mapOf('Trip to Tokyo'), 'zh-TW', names), 'Synthesis: A and others (4 topics)');
  // A Japanese map has no dictionary: English text, even in a Chinese interface.
  assert.equal(nameFor(mapOf('ありがとうございます東京'), 'zh-TW', ['A', 'B']), 'Synthesis: A, B');
  assert.equal(nameFor({ ...mapOf('x'), outputLanguage: 'ja' }, 'zh-CN', names), 'Synthesis: A and others (4 topics)');
  // A Spanish map (follow-the-input row) and a remembered follow-the-input choice read English too.
  assert.equal(nameFor(mapOf('Viaje a Tokio'), 'zh-TW', ['A', 'B']), 'Synthesis: A, B');
  assert.equal(nameFor({ ...mapOf('東京五天自由行'), outputLanguage: 'same-as-input' }, 'zh-TW', ['A']), 'Synthesis: A');
  // The map decides, not the interface: an English map in a zh-TW interface is English.
  assert.equal(nameFor(mapOf('Trip to Tokyo'), 'zh-CN', ['A']), 'Synthesis: A');
});

test('synthesis default name stays short: more than two names show the first name and the count (FG20-29)', () => {
  const long = Array.from({ length: 30 }, (_, index) => `A fairly long topic title number ${index}`);
  for (const [map, ui] of [[mapOf('東京五天自由行'), 'zh-TW'], [mapOf('Trip'), 'en'], [mapOf('东京', { contentLanguage: 'zh-TW' }), 'zh-CN']]) {
    const name = nameFor(map, ui, long);
    assert.ok(name.includes(long[0]) && !name.includes(long[1]), name);
    assert.ok(name.includes('30'), name);
    assert.ok(name.length <= long[0].length + 40, `name too long: ${name.length}`);
    const three = nameFor(map, ui, long.slice(0, 3));
    assert.ok(!three.includes(long[1]), three);
  }
  const two = nameFor(mapOf('Trip'), 'en', long.slice(0, 2));
  assert.ok(two.includes(long[0]) && two.includes(long[1]));
});

test('title language: a note title reads as its own registry language, signal-free text uses the fallback', () => {
  assert.equal(textLanguageOf('路線', 'en'), 'zh-TW');
  assert.equal(textLanguageOf('Route', 'zh-TW'), 'en');
  assert.equal(textLanguageOf('ありがとうございます東京', 'zh-TW'), 'en');
  assert.equal(textLanguageOf('2026', 'zh-CN'), 'zh-CN');
  // The follow-the-input row (Latin or Cyrillic text) has no dictionary: English fixed text.
  assert.equal(textLanguageOf('Ruta de viaje', 'zh-TW'), 'en');
  assert.equal(textLanguageOf('Маршрут', 'zh-CN'), 'en');
});

async function copyOf(ui, mapTitle, noteTitle, aim) {
  const { repo } = fixture(ui);
  const mapPath = await repo.createMap(mapTitle), map = await repo.readMap(mapPath);
  if (aim) map.aim = aim;
  const note = await repo.createNote(noteTitle, 'model-a', map, mapPath, 'workspace');
  const copy = await repo.duplicateNote(note.path, map, mapPath);
  return copy.path.split('/').at(-1);
}

test('Copy-to suffix is note text (zh-CN reads zh-TW) and follows the source note title language', async () => {
  assert.equal(await copyOf('zh-TW', '旅行', '路線'), '路線 副本.md');
  assert.equal(await copyOf('zh-CN', '旅行', '路线', { contentLanguage: 'zh-TW' }), '路线 副本.md');
  assert.equal(await copyOf('en', 'Travel', 'Route'), 'Route copy.md');
  assert.equal(await copyOf('zh-TW', 'Travel', 'Route'), 'Route copy.md', 'English title in a Chinese interface');
  assert.equal(await copyOf('en', 'Travel', '路線'), '路線 副本.md', 'Chinese title in an English interface');
  assert.equal(await copyOf('zh-TW', 'ありがとうございます東京', 'ありがとうございます東京'), 'ありがとうございます東京 copy.md', 'ja title: output-only reads English');
  assert.equal(await copyOf('zh-TW', '旅行', '2026'), '2026 副本.md', 'no signal: the map language');
  assert.equal(await copyOf('en', 'Travel', '2026'), '2026 copy.md');
});

test('image-translate menu lists the output-only languages in their own group and file names strip every language id', () => {
  const obsidian = { Component: class { load() {} unload() {} registerDomEvent() {} }, MarkdownView: class {}, Notice: class {}, setIcon() {} };
  const { imageLanguageChoices, imageFileBase } = load('experiences/markdown-context/image-translate-action.ts', { obsidian });
  const { LANGUAGES, OUTPUT_LANGUAGES } = load('i18n/languages.ts');
  const choices = imageLanguageChoices();
  assert.deepEqual([...choices.registry.map(item => item.id)], [...LANGUAGES.map(item => item.id)]);
  assert.deepEqual([...choices.outputOnly.map(item => item.id)], [...OUTPUT_LANGUAGES.filter(item => !item.followsInput).map(item => item.id)]);
  assert.ok(choices.outputOnly.length > 0 && !choices.outputOnly.some(item => item.id.includes('same')), 'no follow-input row');
  assert.ok(choices.outputOnly.every(item => item.label && item.name));
  for (const id of [...choices.registry, ...choices.outputOnly].map(item => item.id)) {
    assert.equal(imageFileBase(`egg-${id}.png`), 'egg', id);
    assert.equal(imageFileBase(`egg-${id}-2`), 'egg', id);
  }
  assert.equal(imageFileBase(''), 'image');
  assert.equal(imageFileBase('A cat: tea!'), 'A-cat-tea');
});
