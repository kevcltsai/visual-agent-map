// Child synthesis keeps the parent's earlier source links (core/steps/task/carry-sources.ts): pure, offline.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const mod = load('core/steps/task/carry-sources.ts');
const { carryForwardSources } = mod;
const carriedSourceLines = (...args) => [...mod.carriedSourceLines(...args)];
const { standardTemplate } = load('ai/detail-templates.ts');
const { canonicalDetail } = load('ai/result-utils.ts');
const { linksOf } = load('core/steps/task/merge-check.ts');

const en = standardTemplate('en'), zh = standardTemplate('zh-TW');
const sourcesName = template => template.sections.find(section => section.role === 'sources').name;
const carry = (detail, previous, next = [detail], language = 'en', template = en) => carryForwardSources(detail, previous, next, language, template);
const urls = text => [...text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)].map(match => match[0]);

test('nothing missing: the detail is returned byte-identical', () => {
  const detail = canonicalDetail('Body with [A](https://a.example/x).', 'en', en);
  assert.equal(carry(detail, ['Old text [A](https://a.example/x/)', 'old detail https://A.example/x']), detail);
  assert.equal(carry(detail, ['', '', '']), detail);
});

test('dropped links are carried once, in earlier order, in the sources section of the template', () => {
  const detail = canonicalDetail('New body.\n\n### ' + sourcesName(en) + '\n\n- [Kept](https://keep.example)\n\n### Next\n\ntail', 'en', en);
  const previous = '- [First](https://one.example/a)[^1] text\n- [Second](https://two.example/b)\n- [Kept](https://keep.example)\n\n[^1]: [[Note A]]';
  const out = carry(detail, ['', previous, '']);
  assert.match(out, /#### Sources from earlier research\n\n- \[First\]\(https:\/\/one\.example\/a\) text\n- \[Second\]\(https:\/\/two\.example\/b\)\n- \[\[Note A\]\]/);
  assert.equal(urls(out).filter(url => url.includes('keep.example')).length, 1, 'a kept link is not carried');
  assert.ok(out.indexOf('Sources from earlier research') > out.indexOf('keep.example'));
  assert.ok(out.indexOf('Sources from earlier research') < out.indexOf('tail') || out.indexOf('Sources from earlier research') < out.indexOf('### Next'));
  assert.doesNotMatch(out.split('#### Sources from earlier research')[1], /\[\^/, 'no footnote reference is carried');
});

test('line kinds: callout, image, table row, heading, footnote definition, bare url, wikilink', () => {
  const previous = [
    '> Quote [Q](https://q.example) [^2]',
    '![Chart](https://img.example/c.png)',
    '| Name | Link |',
    '| a | [T](https://table.example/t) and <https://angle.example> |',
    '#### Heading [H](https://head.example)',
    '[^3]: https://def.example/page',
    '1. Numbered https://bare.example/n.',
    'See [[Other Note|alias]] and ![[Embed]]'
  ].join('\n');
  const lines = carriedSourceLines([previous], ['nothing']);
  assert.deepEqual(lines, [
    '- Quote [Q](https://q.example)',
    '- [Chart](https://img.example/c.png)',
    '- [T](https://table.example/t)',
    '- <https://angle.example>',
    '- [H](https://head.example)',
    '- https://def.example/page',
    '- Numbered https://bare.example/n.',
    '- See [[Other Note|alias]] and ![[Embed]]'
  ]);
});

test('one carried line covers several links and the same line is not repeated', () => {
  const lines = carriedSourceLines(['- [A](https://a.example) and [B](https://b.example)', '- [A](https://a.example) and [B](https://b.example)'], ['x']);
  assert.deepEqual(lines, ['- [A](https://a.example) and [B](https://b.example)']);
});

test('fenced code on both sides is ignored', () => {
  const previous = '```mermaid\nA[https://code.example/x] --> B\n```\n\n[Real](https://real.example)';
  assert.deepEqual(carriedSourceLines([previous], ['```\nhttps://real.example\n```']), ['- [Real](https://real.example)']);
  assert.deepEqual(carriedSourceLines(['```\nhttps://only-code.example\n```'], ['x']), []);
});

test('encoded and decoded url forms are the same link; visual reference lines are carried', () => {
  assert.deepEqual(carriedSourceLines(['[A](https://x.example/caf%C3%A9)'], ['see https://X.example/café/']), []);
  const reference = '**Pic**\n\n![Pic](https://img.example/p.png)\n\nSource: https://src.example/page\nPurpose: p';
  const lines = carriedSourceLines([reference], ['none']);
  assert.deepEqual(lines, ['- [Pic](https://img.example/p.png)', '- Source: https://src.example/page']);
});

test('idempotent: a result that keeps the block carries nothing; one that drops it carries again without duplicates', () => {
  const detail = canonicalDetail('Body.', 'en', en);
  const first = carry(detail, ['', '- [A](https://a.example)\n- [B](https://b.example)', '']);
  assert.equal(carry(first, ['', first, ''], ['', first, '']), first, 'kept block, nothing new');
  const second = carry(detail, ['', first, '']);
  assert.equal(second, first, 'dropped block is carried again, exactly once');
  assert.equal((second.match(/Sources from earlier research/g) || []).length, 1);
  // The model kept the heading but lost one link: it joins the existing block.
  const partial = first.replace('\n- [B](https://b.example)', '');
  const merged = carry(partial, ['', first, ''], ['', partial, '']);
  assert.equal((merged.match(/Sources from earlier research/g) || []).length, 1);
  assert.ok(merged.includes('- [B](https://b.example)'));
  assert.equal([...linksOf([merged]).keys()].length, 2);
});

test('no sources section: the block is appended as ### at the end; zh heading follows the output language', () => {
  const adaptive = { ...en, sections: en.sections.filter(section => section.role !== 'sources') };
  const out = carry('Plain adaptive text.', ['', '[A](https://a.example)', ''], ['x'], 'en', adaptive);
  assert.equal(out, 'Plain adaptive text.\n\n### Sources from earlier research\n\n- [A](https://a.example)\n');
  const detail = canonicalDetail('內文', 'zh-TW', zh);
  const zhOut = carry(detail, ['', '[甲](https://a.example)', ''], [detail], 'zh-TW', zh);
  assert.match(zhOut, /#### 先前研究的來源\n\n- \[甲\]\(https:\/\/a\.example\)/);
  assert.equal(zhOut.indexOf('先前研究的來源') > zhOut.indexOf('### ' + sourcesName(zh)), true);
});

test('merge-check linksOf is shared and keeps its normalisation', () => {
  assert.deepEqual([...linksOf(['https://A.example/x/ [[N#h|a]] [f](docs/f.md) [m](mailto:a@b.c)']).keys()], ['https://a.example/x', 'wiki:n', 'link:docs/f']);
});

test('removing the inserted span from the output gives back the input exactly', () => {
  const inputs = [
    canonicalDetail('Body.\n\n### ' + sourcesName(en) + '\n\n- [Kept](https://keep.example)\n\n### Next\n\ntail', 'en', en),
    canonicalDetail('Body only.', 'en', en)
  ];
  for (const input of inputs) {
    const out = carry(input, ['', '- [A](https://a.example)\n- [B](https://b.example)', '']);
    assert.notEqual(out, input);
    const stripped = out.replace(/\n*#### Sources from earlier research\n\n(?:- .*\n?)+/, '\n');
    assert.equal(stripped.trim(), input.trim());
  }
  const adaptive = { ...en, sections: en.sections.filter(section => section.role !== 'sources') };
  const out = carry('Plain.', ['', '[A](https://a.example)', ''], ['x'], 'en', adaptive);
  assert.equal(out.replace(/\n*### Sources from earlier research\n\n(?:- .*\n?)+/, ''), 'Plain.');
});
