// The AI proofread's slot lifecycle as checkable invariants (R2 diagnostic reset). `checkAiProofInvariants` returns the violations
// (empty = all hold); every state a run leaves behind must satisfy it, so a branch that is wrong shows up whichever path reached it.
const S = require('./support.cjs');
const { effectiveOrder } = S.load('core/book-pipeline/model.ts');
const { bookBarState } = S.load('experiences/visual-map/book-pipeline-ui.ts');

const squash = text => String(text).replace(/\s+/g, '');
const REFUSED = /^(fix_refused_|hand_edited$|fix_quote_missing$|fix_forbidden_)/;

/**
 * `data`: the saved run. options:
 * - `bodyIds`: the chapters that have text (default: every chapter of the book).
 * - `stageOf(id)`: the card stage (counts needs-review chapters, which the bar and the page both list).
 * - `page`: the closing page text, when one was written.
 * - `refusedQuotes`: the quotes whose LAST fix event (the latest round that targeted that quote) was a block (I2, D6): their blocked reason is carried to the final check.
 * - `boxes`: per chapter id, the chapter's note text; the fix lines of all boxes (chapter and whole-book) must add up to the bar's number.
 * - `keys`: per chapter id, the aiProofKey the chapter's CURRENT text and revision give (I5).
 * - `applied`: per chapter id (or "book"), the replacement texts the run wrote (I4).
 */
function checkAiProofInvariants(data, options = {}) {
  const out = [];
  const order = effectiveOrder(data);
  const slots = data.aiProof ?? {};
  const stageOf = options.stageOf ?? (() => undefined);
  if (data.phase === 'done') {
    for (const id of order.filter(x => (options.bodyIds ?? order).includes(x))) {
      const slot = slots[id];
      if (!slot) out.push(`I1 ${id}: phase=done but the chapter has no aiProof slot`);
      else if (!slot.done) out.push(`I1 ${id}: phase=done but the slot is not done`);
    }
  }
  // I5: at the end of a run every chapter's AI slot was made for the text the chapter has now (an AI fix rises the key with it), so the box
  // never reports a verdict on a text that was rewritten later. Exempt: a chapter the whole-book proofread fixed (that fix rises the revision but not the chapter's key).
  if (data.phase === 'done' && options.keys) {
    const bookFixed = new Set((data.bookProof?.fixes ?? []).map(fix => fix.chapterId));
    for (const id of order.filter(x => slots[x]?.done && !slots[x].incomplete && x in options.keys))
      if (!bookFixed.has(id) && slots[id].key !== options.keys[id]) out.push(`I5 ${id}: the AI slot key ${slots[id].key} is not the current text's key ${options.keys[id]}`);
  }
  const all = [...order.map(id => [id, slots[id]]), ['book', data.bookProof]].filter(([, slot]) => slot);
  for (const [id, slot] of all) {
    if (slot.fixed !== (slot.fixes?.length ?? 0)) out.push(`I2 ${id}: fixed=${slot.fixed} but fixes.length=${slot.fixes?.length ?? 0}`);
    for (const item of slot.open ?? []) {
      if (REFUSED.test(item.reason) && !(options.refusedQuotes ?? []).some(q => squash(q) === squash(item.quote)))
        out.push(`I2 ${id}: open "${item.quote}" carries a blocked reason ${item.reason} but its last fix event was not a block`);
      const hit = (options.applied?.[id] ?? []).some(text => squash(item.quote) && (squash(text).includes(squash(item.quote)) || squash(item.quote).includes(squash(text))));
      if (hit && item.reason !== 'still_present') out.push(`I4 ${id}: "${item.quote}" hits an applied replacement but is ${item.reason}`);
      if (!hit && item.reason === 'still_present' && options.applied && id in options.applied) out.push(`I4 ${id}: "${item.quote}" is still_present but no replacement was written for it`);
    }
  }
  // I2 (whole-book fixes): every one is recorded on the chapter it changed, so the chapters' boxes can tell it.
  const bookFixes = data.bookProof?.fixes ?? [];
  if (bookFixes.some(fix => !fix.chapterId)) out.push('I2 book: a whole-book fix is not recorded on a chapter');
  const barFixed = bookBarState(data, undefined, stageOf).ai.fixed;
  if (options.boxes) {
    const listed = Object.values(options.boxes).reduce((sum, text) => sum + (text.match(/^> ・(?:修了：|Fixed: )/gm) ?? []).length, 0);
    if (listed !== barFixed) out.push(`I2 boxes list ${listed} fixes but the bar says ${barFixed}`);
  }
  const needsReview = order.filter(id => stageOf(id) === 'needs-review').length;
  const aiOpen = all.reduce((sum, [, slot]) => sum + (slot.open?.length ?? 0) + (slot.incomplete ? 1 : 0), 0);
  const barOpen = bookBarState(data, undefined, stageOf).ai.open;
  if (barOpen !== aiOpen + needsReview) out.push(`I3 bar open=${barOpen} but the slots say ${aiOpen + needsReview}`);
  if (options.page !== undefined && data.phase === 'done') {
    const bullets = options.page.split('\n').filter(line => line.startsWith('- ')).length;
    if (bullets !== aiOpen + needsReview) out.push(`I3 page lists ${bullets} items but the slots say ${aiOpen + needsReview}`);
    if (/全部解決/.test(options.page) && aiOpen > 0) out.push('I3 page says all solved while AI items are open');
  }
  return out;
}
module.exports = { checkAiProofInvariants };
