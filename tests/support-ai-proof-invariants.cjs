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
 * - `refusedQuotes`: the quotes whose fix was blocked in the LAST fix round (I2).
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
  const all = [...order.map(id => [id, slots[id]]), ['book', data.bookProof]].filter(([, slot]) => slot);
  for (const [id, slot] of all) {
    if (slot.fixed !== (slot.fixes?.length ?? 0)) out.push(`I2 ${id}: fixed=${slot.fixed} but fixes.length=${slot.fixes?.length ?? 0}`);
    for (const item of slot.open ?? []) {
      if (REFUSED.test(item.reason) && !(options.refusedQuotes ?? []).some(q => squash(q) === squash(item.quote)))
        out.push(`I2 ${id}: open "${item.quote}" carries an old round's reason ${item.reason}`);
      const hit = (options.applied?.[id] ?? []).some(text => squash(item.quote) && (squash(text).includes(squash(item.quote)) || squash(item.quote).includes(squash(text))));
      if (hit && item.reason !== 'still_present') out.push(`I4 ${id}: "${item.quote}" hits an applied replacement but is ${item.reason}`);
    }
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
