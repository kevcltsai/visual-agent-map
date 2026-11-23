// YouTube embeds in a research note (canvas-image-anchors P3): only videos whose page the provider opened stay.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const { keepOpenedVideoEmbeds, youtubeVideoId } = S.load('core/video-embeds.ts');

const A = 'abcdefghijk';
const B = 'ZYXWVUTSRQP';
const keep = (detail, opened) => keepOpenedVideoEmbeds(detail, opened);

test('an opened video stays and is rewritten to the one documented form; all hosts and url shapes of the same id', () => {
  const opened = [`https://www.youtube.com/watch?v=${A}&t=5s`];
  for (const url of [`https://youtu.be/${A}`, `https://youtube.com/watch?v=${A}`, `https://m.youtube.com/watch?v=${A}`, `https://www.youtube.com/embed/${A}`])
    assert.equal(keep(`![](${url})`, opened), `![](https://www.youtube.com/watch?v=${A})`, url);
  assert.equal(keep(`![demo](https://youtu.be/${A})`, [`https://youtu.be/${A}`]), `![demo](https://www.youtube.com/watch?v=${A})`);
});
test('an id that was not opened deletes the whole line; the lines around it stay', () => {
  assert.equal(keep(`before\n![](https://www.youtube.com/watch?v=${B})\nafter`, [`https://www.youtube.com/watch?v=${A}`]), 'before\nafter');
  assert.equal(keep(`![](https://www.youtube.com/watch?v=${B})`, []), '');
  assert.equal(keep(`a\r\n![](https://youtu.be/${B})\r\nb`, []), 'a\r\nb', 'CRLF');
});
test('Quick research opens no pages: every YouTube embed goes', () => {
  assert.equal(keep(`x\n![](https://youtu.be/${A})\n![](https://www.youtube.com/watch?v=${B})\ny`, []), 'x\ny');
});
test('a fake host, a wrong id length and a non-video YouTube url are deleted even when the id was opened', () => {
  const opened = [`https://www.youtube.com/watch?v=${A}`];
  for (const url of [`https://youtube.com.evil.example/watch?v=${A}`, `https://www.youtube.com.evil.example/watch?v=${A}`, `https://youtu.be.evil.example/${A}`,
    `https://www.youtube-nocookie.com/embed/${A}`, 'https://www.youtube.com/watch?v=short', `https://www.youtube.com/watch?v=${A}x`, 'https://www.youtube.com/', 'https://youtu.be/', `ftp://youtu.be/${A}`])
    assert.equal(keep(`![](${url})`, opened), '', url);
  const other = `![](https://evil.example/youtu.be/${A})`;
  assert.equal(keep(other, opened), other, 'a path that only mentions youtu.be is an ordinary embed');
});
test('the look-alike hosts are not YouTube: they are no id source for the opened set either', () => {
  assert.equal(youtubeVideoId(`https://youtube.com.evil.example/watch?v=${A}`), null);
  assert.equal(youtubeVideoId(`https://www.youtube.com/watch?v=${A}`), A);
  const text = `![](https://www.youtube.com/watch?v=${A})`;
  assert.equal(keep(text, [`https://youtube.com.evil.example/watch?v=${A}`]), '', 'an evil opened url does not open the id');
});
test('code fences are left alone, including fences of ~ and a longer closing one', () => {
  const body = `![](https://youtu.be/${B})`;
  assert.equal(keep('```md\n' + body + '\n```', []), '```md\n' + body + '\n```');
  assert.equal(keep('~~~\n' + body + '\n~~~~\n' + body, []), '~~~\n' + body + '\n~~~~\n', 'after the fence closes the embed is checked again');
  assert.equal(keep('````\n```\n' + body + '\n````', []), '````\n```\n' + body + '\n````');
});
test('plain links, other embeds and images stay byte for byte', () => {
  const text = [`[watch](https://www.youtube.com/watch?v=${B})`, '![](https://example.org/a.png)', '![](https://vimeo.com/123456789)', `Text with https://youtu.be/${B} bare`, '![[local.png]]'].join('\n');
  assert.equal(keep(text, []), text);
});
test('an embed inside a sentence is removed alone; nothing else changes', () => {
  assert.equal(keep(`Watch ![](https://youtu.be/${B}) now`, []), 'Watch  now');
  assert.equal(keep('', []), '');
});
test('an id already embedded in the existing note survives a rewrite; a new un-opened id is still removed', () => {
  const C = 'abcdefghijk';
  const existing = `Intro\n![](https://youtu.be/${B})\n`;
  const out = keepOpenedVideoEmbeds(`Rewritten\n![](https://www.youtube.com/watch?v=${B})\n![](https://www.youtube.com/watch?v=${C})\n`, [], existing);
  assert.equal(out, `Rewritten\n![](https://www.youtube.com/watch?v=${B})\n`);
  assert.equal(keepOpenedVideoEmbeds(`![](https://www.youtube.com/watch?v=${B})`, [], ''), '');
});
test('hook: ai-task-service filters task-mode details with the opened urls of countsWeb runs and none otherwise', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'ai-task-service.ts'), 'utf8');
  assert.match(source, /keepOpenedVideoEmbeds\(result\.detail, countsWeb \? openedUrlsFromEvents\(webEvents\) : \[\], input\.detail\)/);
  assert.match(source, /if \(keepsEvents \|\| countsWeb\) webEvents\.push\(event\)/);
});
