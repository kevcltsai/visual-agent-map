// Picture-book notes entry (T5 of "book without a panel"): where a note may be added, the written format, the rejections, the editor-menu
// item and the command, the input dialog, and the header action's lifecycle. Pure text and fake ports; no AI. How Obsidian shows the
// menu item and the header action, and that a real editor takes the transaction, is UI evidence for the tester.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');

const log = [];
const b = loadSource(`
export * from "./experiences/visual-map/book-pipeline-notes";
export * from "./experiences/visual-map/book-pipeline-notes-ui";
export { createNoteWriter } from "./experiences/visual-map/book-pipeline-callouts";
export { countNotes, wrapNote } from "./core/book-pipeline/book-notes";
export { reviewCallout, trialCallout, putProgramCallout } from "./experiences/visual-map/book-pipeline-review";
export { setUiLanguage } from "./i18n";
`, { obsidian: { ...S.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice(log), Component: class {}, MarkdownRenderChild: class {} } }, { createFragment: dom.createFragment, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, window: { setTimeout, clearTimeout, setInterval, clearInterval } });
b.setUiLanguage('zh-TW');

const START = '<!-- visual-agent-map:detail:start -->';
const END = '<!-- visual-agent-map:detail:end -->';
const note = (detail, tail = '') => `---\nagent-map-node: true\n---\n# T\n\n## Current Summary\n\nS\n\n## Detail\n\n${START}\n${detail}\n${END}\n\n## Prompt\n\nP\n${tail}`;
const sel = (raw, word, nth = 0) => { let at = -1; for (let i = 0; i <= nth; i++) at = raw.indexOf(word, at + 1); assert.ok(at >= 0, word); return [at, at + word.length]; };
const check = (raw, word, nth) => b.checkSelection(raw, ...sel(raw, word, nth));

// ---- the format and the numbering ----
test('add: the selection becomes ==selected==%%備註#n：text%%, nothing else changes', () => {
  const raw = note('第一段有一隻小熊。\n\n第二段。');
  const [from, to] = sel(raw, '小熊');
  const out = b.addNote(raw, from, to, '小熊', '改成小兔');
  assert.equal(out.ok, true);
  assert.equal(out.text, raw.replace('小熊', '==小熊==%%備註#1：改成小兔%%'));
  assert.equal(b.countNotes(out.text), 1);
});
test('add: the number is one more than the highest in the text (a deleted number is not used again), and counts from 1', () => {
  assert.equal(b.nextNoteNumber(note('沒有備註')), 1);
  const raw = note('==甲==%%備註#1：a%% 與 ==乙==%%備註#4：b%% 與 丙');
  assert.equal(b.nextNoteNumber(raw), 5);
  const [from, to] = sel(raw, '丙');
  assert.match(b.addNote(raw, from, to, '丙', 'c').text, /==丙==%%備註#5：c%%/);
  assert.equal(b.nextNoteNumber(note('x ==a==%%備註#2：n%%')), 3);
});
test('add: the note text is trimmed; the wrapper is the one countNotes reads', () => {
  const raw = note('小熊在森林。');
  const [from, to] = sel(raw, '小熊');
  const out = b.addNote(raw, from, to, '小熊', '  再具體一點  ');
  assert.match(out.text, /==小熊==%%備註#1：再具體一點%%在森林/);
});
test('add: Unicode and CRLF text keep working (the line ends stay)', () => {
  const raw = note('第一行 🐻 熊\n第二行').replace(/\n/g, '\r\n');
  const [from, to] = sel(raw, '🐻 熊');
  const out = b.addNote(raw, from, to, '🐻 熊', '備註');
  assert.equal(out.ok, true);
  assert.ok(out.text.includes('==🐻 熊==%%備註#1：備註%%\r\n第二行'));
});

// ---- the rejections ----
test('reject: an empty or blank selection', () => {
  const raw = note('小熊在森林。');
  assert.equal(b.checkSelection(raw, 30, 30).reason, 'empty');
  const at = raw.indexOf('小熊');
  assert.equal(b.checkSelection(raw, at, at).reason, 'empty');
  assert.equal(b.checkSelection(raw, 0, 0).reason, 'empty');
});
test('reject: a selection over a line break or over two paragraphs', () => {
  const raw = note('第一段在這裡。\n第二行。\n\n第二段。');
  const from = raw.indexOf('在這裡');
  assert.equal(b.checkSelection(raw, from, raw.indexOf('第二行') + 2).reason, 'multiline');
  assert.equal(b.checkSelection(raw, from, raw.indexOf('第二段') + 2).reason, 'multiline');
});
test('reject: == or %% inside the selection, or a selection that touches an earlier note or highlight', () => {
  const raw = note('前 ==甲==%%備註#1：a%% 後 ==乙== 尾 abc%%x%% 與 100%');
  assert.equal(check(raw, '==甲==').reason, 'marks');
  assert.equal(check(raw, 'abc%%x%%').reason, 'marks');
  assert.equal(check(raw, '甲').reason, 'marks', 'inside a highlight');
  assert.equal(check(raw, '備註#1：a').reason, 'marks', 'inside the earlier note');
  assert.equal(check(raw, '後 ==乙').reason, 'marks');
  assert.equal(check(raw, '前').ok, true);
  assert.equal(check(raw, '後').ok, true);
});
test('reject: a note text with ==, %%, a line break or nothing; accepted text is trimmed', () => {
  assert.equal(b.checkNoteText('').problem, 'empty');
  assert.equal(b.checkNoteText('   ').problem, 'empty');
  for (const bad of ['a==b', 'a%%b', 'a\nb', 'a\r\nb']) assert.equal(b.checkNoteText(bad).problem, 'marks', bad);
  assert.equal(b.checkNoteText(' ok ').note, 'ok');
  const raw = note('小熊。');
  const [from, to] = sel(raw, '小熊');
  for (const bad of ['', 'a==b', 'a%%b', 'a\nb']) { const r = b.addNote(raw, from, to, '小熊', bad); assert.equal(r.ok, false); assert.equal(r.reason, 'note'); }
});
test('reject: the text moved since the selection was made (nothing is written)', () => {
  const raw = note('小熊在森林。');
  const [from, to] = sel(raw, '小熊');
  assert.equal(b.addNote('X' + raw, from, to, '小熊', 'n').reason, 'changed');
});

// ---- the scope: only the visible chapter body ----
const scoped = note(
  [
    '# 章名',
    '正文一，正文詞。',
    '![](https://a/b.png) ![[c.png]]',
    '```',
    '程式碼詞',
    '```',
    '> [!vam-book]- 校對結果',
    '> 隱藏詞',
    '',
    '> [!vam-trial] 試跑第 1／3 章',
    '> 試跑詞',
    '> %%vam-trial:r1:n1%%',
    '',
    '> [!vam-review] 這章要看',
    '> - [ ] 問題詞',
    '> %%vam-review:r1:n1:fp%%',
    '',
    '### 來源',
    '來源詞 https://x',
    '',
    '### 圖像',
    '![x](https://i/1.png)',
    '圖說詞',
    '',
    '## 更新紀錄',
    '更新詞'
  ].join('\n'),
  '外面的詞\n'
);
test('scope: chapter text takes a note', () => assert.equal(check(scoped, '正文詞').ok, true));
test('scope: not in a heading, a picture-only line, code, a hidden callout, the trial hint, the review box or the sources', () => {
  for (const word of ['章名', 'c.png', '程式碼詞', '隱藏詞', '試跑詞', '問題詞', '來源詞', '圖說詞', '更新詞'])
    assert.equal(check(scoped, word).reason, 'outside', word);
});
test('scope: not outside the Detail block (a note without one has no chapter text)', () => {
  assert.equal(check(scoped, '外面的詞').reason, 'outside');
  assert.equal(check('# T\n\n只有正文詞', '正文詞').reason, 'outside');
});
test('scope: a word that appears in chapter text and in an excluded place is judged where it is selected', () => {
  const raw = note('詞 一\n\n```\n詞\n```');
  assert.equal(check(raw, '詞', 0).ok, true);
  assert.equal(check(raw, '詞', 1).reason, 'outside');
});

// ---- entry points and the header action: a fake window of tabs ----
function world({ chapters = ['N/c.md'], files = {} } = {}) {
  const w = { chapters: new Set(chapters), files: { 'N/c.md': note('小熊在森林。\n\n第二段。'), ...files }, tabs: [], notices: [], asked: [], applied: [], writes: [], asks: 0 };
  const mk = (path, text) => {
    const tab = { key: {}, path, text, actions: [] };
    tab.leaf = {
      key: tab.key, path: () => tab.path, text: () => tab.text,
      addAction: (label, run) => {
        const action = { label, run, removed: false };
        tab.actions.push(action);
        return { setLabel: next => { action.label = next; }, remove: () => { action.removed = true; } };
      }
    };
    return tab;
  };
  w.open = (path) => { const tab = mk(path, w.files[path] ?? ''); w.tabs.push(tab); return tab; };
  w.close = tab => { w.tabs = w.tabs.filter(t => t !== tab); for (const a of tab.actions) a.removed = true; };
  w.live = tab => tab.actions.filter(a => !a.removed);
  w.notes = new b.BookNotes({
    leaves: () => w.tabs.map(t => t.leaf),
    chapterPaths: async paths => new Set(paths.filter(p => w.chapters.has(p))),
    write: async (path, transform) => {
      const tab = w.tabs.find(t => t.path === path);
      const before = tab ? tab.text : w.files[path];
      const next = transform(before);
      w.writes.push(path);
      if (next === before) return 'unchanged';
      if (tab) tab.text = next; else w.files[path] = next;
      return 'written';
    },
    askNote: (selected, submit) => { w.asks++; w.asked.push(selected); w.submit = submit; },
    notice: m => w.notices.push(m),
    applyNotes: p => w.applied.push(p)
  });
  w.editor = (tab, word) => ({ path: tab.path, text: () => tab.text, selection: () => { const [from, to] = word ? sel(tab.text, word) : [0, 0]; return { from, to }; } });
  return w;
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('menu: a chapter note gets the add item (enabled on a good selection); a note that is not a chapter gets nothing', async () => {
  const w = world({ files: { 'N/other.md': note('別的筆記。') } });
  const chapter = w.open('N/c.md'); const other = w.open('N/other.md');
  await w.notes.refresh();
  const plan = w.notes.menu(w.editor(chapter, '小熊'));
  assert.equal(plan.add.title, '圖文書：加備註');
  assert.equal(plan.add.disabled, false);
  assert.equal(plan.apply, undefined, 'no notes yet: no apply item');
  assert.equal(w.notes.menu(w.editor(other, '別的')), null);
  assert.equal(w.notes.menu({ path: undefined, text: () => '', selection: () => ({ from: 0, to: 0 }) }), null);
});
test('menu: the item is disabled with the reason for a bad selection (empty, two lines, a heading, code, a hidden callout)', async () => {
  const w = world({ files: { 'N/c.md': scoped } });
  const tab = w.open('N/c.md');
  await w.notes.refresh();
  const why = word => w.notes.menu(w.editor(tab, word)).add;
  assert.equal(w.notes.menu(w.editor(tab, undefined)).add.disabled, true);
  assert.match(w.notes.menu(w.editor(tab, undefined)).add.title, /先選取一段文字/);
  assert.match(why('章名').title, /章節正文/);
  assert.equal(why('程式碼詞').disabled, true);
  assert.equal(why('隱藏詞').disabled, true);
  assert.equal(why('正文詞').disabled, false);
  tab.text = tab.text.replace('正文一，', '正文一\n');
  const [from] = sel(tab.text, '正文一');
  const multi = w.notes.menu({ path: 'N/c.md', text: () => tab.text, selection: () => ({ from, to: from + 6 }) }).add;
  assert.match(multi.title, /同一行/);
});
test('menu: a chapter with notes also gets the apply item with the count', async () => {
  const w = world({ files: { 'N/c.md': note('==甲==%%備註#1：a%% ==乙==%%備註#2：b%% 丙') } });
  const tab = w.open('N/c.md'); await w.notes.refresh();
  assert.equal(w.notes.menu(w.editor(tab, '丙')).apply.title, '圖文書：套用 2 則備註');
});
test('command: asks for the note, writes it through the writer, tells the reader; the dialog gets the selected text', async () => {
  const w = world();
  const tab = w.open('N/c.md'); await w.notes.refresh();
  w.notes.add(w.editor(tab, '小熊'));
  assert.deepEqual(w.asked, ['小熊']);
  assert.equal(w.submit('改成小兔'), null);
  await flush();
  assert.match(tab.text, /==小熊==%%備註#1：改成小兔%%在森林/);
  assert.deepEqual(w.notices, ['已加備註。']);
  assert.equal(w.live(tab).length, 1, 'the header action appeared with the first note');
  assert.equal(w.live(tab)[0].label, '套用 1 則備註');
});
test('command: a bad note text is answered in the dialog and nothing is written; a bad selection never opens the dialog', async () => {
  const w = world();
  const tab = w.open('N/c.md'); await w.notes.refresh();
  w.notes.add(w.editor(tab, '小熊'));
  for (const bad of ['', 'a==b', 'a%%b', 'a\nb']) assert.ok(w.submit(bad), bad);
  assert.equal(w.writes.length, 0);
  w.notes.add(w.editor(tab, undefined));
  assert.equal(w.asks, 1);
  assert.match(w.notices.at(-1), /先選取一段文字/);
});
test('command: not a chapter note says so and opens nothing', async () => {
  const w = world({ chapters: [] });
  const tab = w.open('N/c.md'); await w.notes.refresh();
  w.notes.add(w.editor(tab, '小熊'));
  assert.equal(w.asks, 0);
  assert.deepEqual(w.notices, ['請先打開圖文書的章節筆記。']);
});
test('command: the text changed between the selection and the write → nothing is written and the reader is told', async () => {
  const w = world();
  const tab = w.open('N/c.md'); await w.notes.refresh();
  w.notes.add(w.editor(tab, '小熊'));
  tab.text = tab.text.replace('小熊', '大熊');
  w.submit('n');
  await flush();
  assert.ok(!tab.text.includes('%%備註'));
  assert.deepEqual(w.notices, ['原文已改，請重新選取']);
});
test('command: a refused write or a write that throws is reported, never thrown', async () => {
  const w = world();
  const tab = w.open('N/c.md'); await w.notes.refresh();
  w.notes.add(w.editor(tab, '小熊'));
  const keep = w.notes.ports.write; w.notes.ports.write = async () => 'refused';
  w.submit('n'); await flush();
  assert.match(w.notices.at(-1), /沒有加上備註/);
  w.notes.ports.write = async () => { throw new Error('x'); };
  w.submit('n'); await flush();
  assert.equal(w.notices.length, 2);
  w.notes.ports.write = keep;
});
test('writer: the note goes through the write coordinator (an open view is edited through its editor, not the file)', async () => {
  const w = world();
  const tab = w.open('N/c.md'); await w.notes.refresh();
  let text = tab.text; const edits = []; let raw = 0;
  const write = b.createNoteWriter({
    openViews: () => [{ text: () => text, replace: next => { edits.push(next); text = next; return true; } }],
    rawGuarded: async () => { raw++; return 'written'; }
  });
  w.notes.ports.write = write;
  w.notes.add(w.editor(tab, '小熊')); w.submit('改');
  await flush();
  assert.equal(edits.length, 1); assert.equal(raw, 0);
  assert.match(edits[0], /==小熊==%%備註#1：改%%/);
});

// ---- the header action ----
test('header: shown only on a chapter note with notes, one per view, with the count', async () => {
  const w = world({ files: { 'N/c.md': note('==甲==%%備註#1：a%% 丙'), 'N/plain.md': note('==甲==%%備註#1：a%%'), 'N/empty.md': note('沒有') }, chapters: ['N/c.md', 'N/empty.md'] });
  const a = w.open('N/c.md'), plain = w.open('N/plain.md'), empty = w.open('N/empty.md');
  await w.notes.refresh();
  assert.equal(w.live(a).length, 1); assert.equal(w.live(a)[0].label, '套用 1 則備註');
  assert.equal(w.live(plain).length, 0, 'a note that is not a chapter has no button even with notes in it');
  assert.equal(w.live(empty).length, 0, 'a chapter with no notes has none');
  await w.notes.refresh(); w.notes.paint(); w.notes.paint();
  assert.equal(w.live(a).length, 1, 'refreshing again adds no second button');
  assert.equal(a.actions.length, 1);
});
test('header: it follows the edits (count changes, goes when the last note goes, comes back with a new one)', async () => {
  const w = world({ files: { 'N/c.md': note('==甲==%%備註#1：a%% 丙') } });
  const tab = w.open('N/c.md'); await w.notes.refresh();
  tab.text = tab.text.replace('丙', '==丙==%%備註#2：b%%'); w.notes.paint();
  assert.equal(w.live(tab)[0].label, '套用 2 則備註'); assert.equal(tab.actions.length, 1);
  tab.text = note('沒有備註了'); w.notes.paint();
  assert.equal(w.live(tab).length, 0);
  tab.text = note('==甲==%%備註#1：a%%'); w.notes.paint();
  assert.equal(w.live(tab).length, 1); assert.equal(tab.actions.length, 2);
});
test('header: notes inside code, a hidden callout or the program callouts do not count (no button)', async () => {
  const hidden = '> [!vam-book]- 校對\n> ==甲==%%備註#1：a%%\n';
  const w = world({ files: { 'N/c.md': note('```\n==甲==%%備註#1：a%%\n```\n' + hidden) } });
  const tab = w.open('N/c.md'); await w.notes.refresh();
  assert.equal(w.live(tab).length, 0);
});
test('header: switching the tab to a note that is not a chapter removes it; back to a chapter adds it once', async () => {
  const w = world({ files: { 'N/c.md': note('==甲==%%備註#1：a%%'), 'N/o.md': note('==乙==%%備註#1：b%%') } });
  const tab = w.open('N/c.md'); await w.notes.refresh();
  assert.equal(w.live(tab).length, 1);
  tab.path = 'N/o.md'; tab.text = w.files['N/o.md']; await w.notes.refresh();
  assert.equal(w.live(tab).length, 0);
  tab.path = 'N/c.md'; tab.text = w.files['N/c.md']; await w.notes.refresh();
  assert.equal(w.live(tab).length, 1);
  await w.notes.refresh();
  assert.equal(w.live(tab).length, 1);
});
test('header: repeated open and close of a chapter tab leaves exactly one live button and no leftovers', async () => {
  const w = world({ files: { 'N/c.md': note('==甲==%%備註#1：a%%') } });
  for (let i = 0; i < 4; i++) {
    const tab = w.open('N/c.md'); await w.notes.refresh();
    assert.equal(w.live(tab).length, 1, `open ${i}`);
    if (i < 3) { w.close(tab); await w.notes.refresh(); }
  }
  const live = w.tabs.flatMap(t => w.live(t));
  assert.equal(live.length, 1);
});
test('header: a closed view whose button was not removed by the host is released on the next paint (no growth in the controller)', async () => {
  const w = world({ files: { 'N/c.md': note('==甲==%%備註#1：a%%') } });
  const tab = w.open('N/c.md'); await w.notes.refresh();
  w.tabs = []; // the tab is gone without the controller being told
  w.notes.paint();
  assert.equal(tab.actions[0].removed, true);
  assert.equal(w.notes.actions.size, 0);
});
test('header: two tabs of the same chapter each get one button; unload removes every one and later paints add nothing', async () => {
  const w = world({ files: { 'N/c.md': note('==甲==%%備註#1：a%%') } });
  const one = w.open('N/c.md'), two = w.open('N/c.md'); await w.notes.refresh();
  assert.equal(w.live(one).length, 1); assert.equal(w.live(two).length, 1);
  w.notes.dispose();
  assert.equal(w.live(one).length + w.live(two).length, 0);
  w.notes.paint(); await w.notes.refresh();
  assert.equal(w.live(one).length + w.live(two).length, 0);
  assert.equal(one.actions.length, 1);
});
test('header: an old answer that arrives after a newer refresh does not paint (a late result is dropped)', async () => {
  const w = world({ files: { 'N/c.md': note('==甲==%%備註#1：a%%') } });
  const tab = w.open('N/c.md');
  let release; const gate = new Promise(r => { release = r; });
  const real = w.notes.ports.chapterPaths;
  w.notes.ports.chapterPaths = async paths => { await gate; return new Set(paths); };
  const slow = w.notes.refresh();
  w.notes.ports.chapterPaths = async () => new Set();
  await w.notes.refresh();
  release(); await slow;
  assert.equal(w.live(tab).length, 0, 'the newer answer (not a chapter) wins');
  w.notes.ports.chapterPaths = real;
});
test('header: a failed chapter lookup paints nothing new and does not throw', async () => {
  const w = world();
  const tab = w.open('N/c.md');
  w.notes.ports.chapterPaths = async () => { throw new Error('x'); };
  await w.notes.refresh();
  assert.equal(w.live(tab).length, 0);
});
test('apply seam (T6): the header button, the menu item twin and the command twin all call applyNotes with the chapter path; a non-chapter never does', async () => {
  const w = world({ files: { 'N/c.md': note('==甲==%%備註#1：a%%'), 'N/o.md': note('x') } });
  const tab = w.open('N/c.md'); const other = w.open('N/o.md'); await w.notes.refresh();
  w.live(tab)[0].run();
  w.notes.apply('N/c.md');
  w.notes.apply('N/o.md');
  w.notes.apply(undefined);
  assert.deepEqual(w.applied, ['N/c.md', 'N/c.md']);
  tab.path = 'N/o.md'; // the tab switched but the button was not yet repainted: a stale press does nothing
  w.live(tab)[0].run();
  assert.equal(w.applied.length, 2);
  void other;
});

// ---- the input dialog ----
test('dialog: shows the selected text and one input; save with a bad note keeps it open with the reason; a good note closes it', () => {
  const answers = [];
  const modal = new b.BookNoteModal({}, '小熊', note => { answers.push(note); return note === 'ok' ? null : '不行'; });
  modal.open();
  assert.ok(dom.texts(modal.contentEl).includes('小熊'));
  const input = dom.find(modal.contentEl, i => i.tag === 'input');
  assert.ok(input);
  const save = dom.button(modal.modalEl, '儲存');
  input.value = 'bad'; save.click();
  assert.equal(modal.closeCount, 0);
  assert.ok(dom.texts(modal.contentEl).includes('不行'));
  input.value = 'ok'; save.click();
  assert.equal(modal.closeCount, 1);
  assert.deepEqual(answers, ['bad', 'ok']);
});
