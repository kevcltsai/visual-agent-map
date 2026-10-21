// 0.25 A3: the goal-grading entry is named for what it does, and its panel survives a repaint or a dialog handing focus
// back (a null relatedTarget) instead of closing the instant it opens. Real view, DOM stand-in from tests/support-dom.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, node, map, obsidian, DEFAULT_SETTINGS } = require('./support.cjs');
const { element, find, hasCls } = require('./support-dom.cjs');

const MAP_PATH = 'Agent Workspace/Topics/m/Map.md';

function fixture(language = 'en') {
  const notices = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: class { constructor(message) { notices.push(message); } }, setTooltip() {} } });
  const docListeners = new Map();
  const doc = { activeElement: null, addEventListener(name, fn) { docListeners.set(name, fn); }, removeEventListener(name, fn) { if (docListeners.get(name) === fn) docListeners.delete(name); } };
  const plugin = { settings: { ...DEFAULT_SETTINGS, language }, relevanceGrades: new Map(), releaseOutline() {} };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  const root = node('root'), child = node('child', 'root');
  view.path = MAP_PATH; view.map = map([root, child]);
  view.notes = new Map([[root.id, { title: 'Root' }], [child.id, { title: 'Child' }]]);
  const content = element('div'); content.ownerDocument = doc; content.root = doc;
  view.contentEl = content;
  const paint = () => view.renderRelevanceGoalControl(content.createDiv('vam-map-tools'));
  paint();
  const chip = () => find(content, i => hasCls(i, 'vam-relevance-goal'));
  const input = () => find(content, i => hasCls(i, 'vam-relevance-goal-input'));
  const panel = () => find(content, i => hasCls(i, 'vam-relevance-panel'));
  return { view, plugin, content, doc, docListeners, notices, paint, chip, input, panel, translate: load('i18n.ts').translate };
}

test('A3: the entry is named "Prioritize by goal" / 「依目標排優先」 with a hint that says what AI does', () => {
  const f = fixture();
  assert.equal(f.chip().text, 'Prioritize by goal');
  assert.equal(f.chip().attrs['aria-label'], 'Prioritize by goal', 'the accessible name is the new label');
  for (const [language, label, hint] of [['en', 'Prioritize by goal', /Must learn.*Learn when needed.*Skippable/], ['zh-TW', '依目標排優先', /必學.*需要時學.*可跳過/]]) {
    assert.equal(f.translate(language, 'ui.relevance_goal_set'), label);
    assert.match(f.translate(language, 'ui.relevance_goal_set_hint'), hint);
  }
  assert.doesNotMatch(f.translate('zh-TW', 'ui.relevance_goal_set'), /設定目標/);
});

test('A3: an old field losing focus with no next element (a repaint, a dialog giving focus back) keeps the panel open', () => {
  const f = fixture();
  f.chip().click();
  assert.ok(f.panel(), 'the panel opens'); const old = f.input(); assert.equal(old.focused, true);
  old.fire('focusout', { relatedTarget: null });
  assert.ok(f.panel(), 'focusout(null) does not close it'); assert.equal(f.view.relevancePanelOpen, true);
  assert.equal(f.chip().attrs['aria-expanded'], 'true');
});

test('A3: a repaint redraws the open panel, and the removed field\'s late focusout cannot close the new one', () => {
  const f = fixture();
  f.chip().click();
  const old = f.input(), outside = element('button');
  f.paint(); // what render() does after emptying the old DOM
  const fresh = find(f.content, i => hasCls(i, 'vam-relevance-panel') && i !== old);
  assert.ok(fresh && f.view.relevancePanelOpen, 'the panel is drawn again after the repaint');
  const panels = () => f.content.children.flatMap(c => c.children).filter(c => hasCls(c, 'vam-relevance-panel'));
  const current = panels().at(-1);
  old.fire('focusout', { relatedTarget: outside }); // late event from the discarded DOM
  assert.equal(f.view.relevancePanelOpen, true, 'a stale field cannot close the new panel'); assert.ok(panels().includes(current));
});

test('A3: render() invalidates the panel before it empties the DOM (source order)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  const body = source.slice(source.indexOf('  private render(): void {'));
  const bump = body.indexOf('this.relevancePanelGen++'), cleanup = body.indexOf('this.relevancePanelCleanup?.()'), empty = body.indexOf('this.contentEl.empty()');
  assert.ok(bump > 0 && cleanup > 0 && empty > 0 && bump < empty && cleanup < empty, 'gen bump and listener cleanup come before contentEl.empty()');
});

test('A3: focus moving to a real element outside the panel closes it; the outside press and Escape still close it', () => {
  const f = fixture();
  f.chip().click();
  f.input().fire('focusout', { relatedTarget: element('button') });
  assert.equal(f.view.relevancePanelOpen, false); assert.equal(f.panel(), undefined);
  // Outside pointerdown.
  f.chip().click(); assert.ok(f.panel());
  f.docListeners.get('pointerdown')({ target: element('div') });
  assert.equal(f.view.relevancePanelOpen, false); assert.equal(f.panel(), undefined);
  // A press inside the panel does not close it.
  f.chip().click(); const inside = f.input();
  f.docListeners.get('pointerdown')({ target: inside });
  assert.ok(f.panel());
  // Escape closes and returns focus to the button.
  inside.fire('keydown', { key: 'Escape' });
  assert.equal(f.view.relevancePanelOpen, false); assert.equal(f.panel(), undefined);
  assert.equal(f.chip().focused, true); assert.equal(f.doc.activeElement, f.chip(), 'focus returns to the button');
  assert.equal(f.chip().attrs['aria-expanded'], 'false');
});

test('A3: a click that cannot open the panel says why', () => {
  const f = fixture();
  f.plugin.relevanceGrades.set(MAP_PATH, { status: 'running' });
  f.chip().fire('click'); // the button is disabled while grading; the handler still explains if it is reached
  assert.equal(f.panel(), undefined);
  assert.deepEqual(f.notices, [f.translate('en', 'ui.relevance_goal_unavailable_grading')]);
  f.plugin.relevanceGrades.clear(); f.notices.length = 0;
  f.view.relevanceToolsEl = null;
  f.chip().fire('click');
  assert.deepEqual(f.notices, [f.translate('en', 'ui.relevance_goal_unavailable_toolbar')]);
  for (const key of ['ui.relevance_goal_unavailable_grading', 'ui.relevance_goal_unavailable_toolbar'])
    assert.notEqual(f.translate('zh-TW', key), f.translate('en', key), `${key} is translated`);
});

test('A3: a stale "open" flag without a panel on screen opens the panel instead of toggling it shut', () => {
  const f = fixture();
  f.view.relevancePanelOpen = true; f.view.relevancePanelEl = null;
  f.chip().click();
  assert.ok(f.panel(), 'the click opens it');
});
