// Ticket 26: the plan card's Apply button must not be clipped by the lower edge of the chat log.
// The log is a scrolling flex column; its rows must keep their full height and the log needs room below them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const declarations = selector => {
  const found = [];
  for (const m of css.matchAll(/(^|\n)([^{}\n/][^{}]*)\{([^{}]*)\}/g)) {
    if (m[2].split(',').some(s => s.trim() === selector)) found.push(m[3]);
  }
  return found.join(';');
};
const px = (text, prop) => {
  const m = new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+)`).exec(text);
  return m ? m[1].trim() : '';
};

test('chat log rows are never shrunk below their content, so the plan card keeps its button row', () => {
  const rows = declarations('.vam-map-chat-log > *');
  assert.match(rows, /flex-shrink:\s*0|flex:\s*0 0 auto/, 'direct children of the scrolling log do not shrink');
});

test('plan card and its button row keep their full height', () => {
  for (const sel of ['.vam-map-chat-plan', '.vam-map-chat-plan-buttons']) {
    assert.match(declarations(sel), /flex-shrink:\s*0|flex:\s*0 0 auto/, `${sel} does not shrink`);
  }
});

test('chat log leaves room below the last row for the focus ring of the Apply button', () => {
  const log = declarations('.vam-map-chat-log');
  const padding = px(log, 'padding').split(/\s+/).map(v => parseFloat(v));
  const bottom = padding.length === 1 ? padding[0] : padding.length === 2 ? padding[0] : padding[2];
  const explicit = parseFloat(px(log, 'padding-bottom'));
  assert.ok(Math.max(bottom || 0, explicit || 0) >= 4, 'bottom padding fits the 2px outline + 1px offset of a focused button');
});
