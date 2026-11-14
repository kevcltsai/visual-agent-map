// Ticket 04: the same image is not embedded twice by new AI content. imageKey decides "same image"; dedupeImageEmbeds drops
// the repeated embed line of new content only; the repository keeps a repeated visual reference's text without its image.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const { imageKey, imageKeysIn, dedupeImageEmbeds } = load('core/image-keys.ts');

const THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Caf%C3%A9_Latte.jpg/1280px-Caf%C3%A9_Latte.jpg';
const ORIGINAL = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Café_Latte.jpg';

test('imageKey: a Wikimedia thumbnail, its original and Special:FilePath are one image; <> is stripped', () => {
  assert.equal(imageKey(THUMB), imageKey(ORIGINAL));
  assert.equal(imageKey(`<${THUMB}>`), imageKey(ORIGINAL));
  assert.equal(imageKey('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Café_Latte.jpg/640px-Café_Latte.jpg'), imageKey(ORIGINAL), 'another width');
  assert.equal(imageKey('https://commons.wikimedia.org/wiki/Special:FilePath/Caf%C3%A9_Latte.jpg?width=800'), imageKey(ORIGINAL));
});
test('imageKey: same file name in another project, another file name, another host or a near link are different images', () => {
  assert.notEqual(imageKey('https://upload.wikimedia.org/wikipedia/en/a/ab/Café_Latte.jpg'), imageKey(ORIGINAL), 'en is not commons');
  assert.notEqual(imageKey('https://commons.wikimedia.org/wiki/Special:FilePath/Café_Latte.jpg'), imageKey('https://upload.wikimedia.org/wikipedia/en/a/ab/Café_Latte.jpg'), 'FilePath is commons only');
  assert.notEqual(imageKey('https://upload.wikimedia.org/wikipedia/commons/a/ab/Espresso.jpg'), imageKey(ORIGINAL));
  assert.notEqual(imageKey('https://example.com/a/ab/Café_Latte.jpg'), imageKey(ORIGINAL));
  // Not Wikimedia: only identical strings are the same, whatever the link seems to mean.
  assert.notEqual(imageKey('https://source.unsplash.com/featured/?coffee'), imageKey('https://source.unsplash.com/featured/?latte'));
  assert.notEqual(imageKey('https://example.com/pic.jpg?w=200'), imageKey('https://example.com/pic.jpg'));
  assert.equal(imageKey('<https://example.com/pic.jpg>'), imageKey('https://example.com/pic.jpg'));
});
test('dedupeImageEmbeds: a repeated embed in new content is reduced to one; its source text stays', () => {
  const text = `![A](<${THUMB}>)\n\n[A](<https://s.example/a>)\n\nBody\n\n![A again](${ORIGINAL})\n\n[A](<https://s.example/b>)`;
  assert.equal(dedupeImageEmbeds(text), `![A](<${THUMB}>)\n\n[A](<https://s.example/a>)\n\nBody\n\n[A](<https://s.example/b>)`);
  assert.equal(dedupeImageEmbeds(dedupeImageEmbeds(text)), dedupeImageEmbeds(text));
  const different = '![x](https://example.com/1.jpg)\n\n![y](https://example.com/2.jpg)';
  assert.equal(dedupeImageEmbeds(different), different);
});
test('dedupeImageEmbeds: an image the surviving content has is not embedded again; fences and the Preview callout are not image content', () => {
  assert.equal(dedupeImageEmbeds(`![A](<${THUMB}>)\n\n[A](<https://s.example/a>)`, { seen: imageKeysIn(`Old\n\n![old](${ORIGINAL})`) }), '[A](<https://s.example/a>)');
  const fenced = '```md\n![x](https://example.com/1.jpg)\n```\n![x](https://example.com/1.jpg)\n```md\n![x](https://example.com/1.jpg)\n```';
  assert.equal(dedupeImageEmbeds(fenced), fenced, 'image syntax in a fence is text: neither seen nor dropped');
  const file = '---\nimage: x\n---\n# T\n\n## Preview\n\n> [!summary]\n> ![p](https://example.com/1.jpg)\n\n## Detail\n\n![p](https://example.com/1.jpg)\n';
  assert.equal(dedupeImageEmbeds(file, { file: true }), file, 'the Preview callout does not count');
  // A partial edit: the text outside the range survives and counts; nothing outside the range changes.
  const before = '![a](https://example.com/1.jpg)\n\nOld\n';
  const inserted = 'New\n\n![a](https://example.com/1.jpg)\n\n![b](https://example.com/2.jpg)\n';
  const all = before + inserted + '![a](https://example.com/1.jpg)\n';
  assert.equal(dedupeImageEmbeds(all, { range: { start: before.length, end: before.length + inserted.length } }), `${before}New\n\n![b](https://example.com/2.jpg)\n![a](https://example.com/1.jpg)\n`);
});

// The repository side: a visual reference written with new AI content.
const support = require('./support.cjs');
test('visual references of a new write: a repeated image keeps the reference title and source text, only its image line goes; elsewhere unchanged', async () => {
  const { repo, contents } = support.fixture('en');
  const n = await support.topicNote(repo, 'Latte');
  const { visualReferencesMarkdown } = support.load('ai/result-utils.ts');
  const refs = visualReferencesMarkdown([{ title: 'Latte art', imageUrl: ORIGINAL, sourceUrl: 'https://s.example/latte', description: '', palette: [], formula: '' }], 'en');
  const detail = `### Core conclusions\n\n![Latte](<${THUMB}>)\n\n\`\`\`md\n![x](${ORIGINAL})\n\`\`\``;
  await repo.updateNote(n.path, { detail, visualReferences: refs }, { newVisualReferences: true });
  const written = (await repo.readNote(n.path)).detail;
  assert.ok(written.includes('**Latte art**'), written);
  assert.ok(written.includes('https://s.example/latte'), `the source text stays: ${written}`);
  assert.equal((written.match(/!\[Latte art\]/g) || []).length, 0, written);
  assert.ok(written.includes(`\`\`\`md\n![x](${ORIGINAL})\n\`\`\``), 'image syntax in a fence unchanged');
  // Without the option (not a new AI write) the old rule stays: an exact repeat leaves the whole block out.
  const m = await support.topicNote(repo, 'Old rule');
  const exact = `### Core conclusions\n\n![Latte](${ORIGINAL})`;
  await repo.updateNote(m.path, { detail: exact, visualReferences: refs });
  assert.doesNotMatch((await repo.readNote(m.path)).detail, /Latte art/);
  assert.ok(contents.size > 0);
});
