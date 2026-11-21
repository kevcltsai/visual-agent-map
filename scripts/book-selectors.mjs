// Stable DOM selectors for the picture-book (圖文書) flow, for scenarios and CDP checks. Every value is a class the product renders
// (tests/book-harness.mjs fails when a class disappears from the source, so this file cannot silently rot).
// Use them in run-scenario steps: {"waitFor": ".vam-book-bar[data-mode='gate1']"}, {"click": ".vam-book-confirm"}.
//   header button   .vam-book-button            opens the start dialog (or answers with a Notice when the map cannot start)
//   start dialog    .vam-book-start-go          the Start button; .vam-book-start-field are the whole-book setting boxes
//   progress bar    .vam-book-bar               its data-mode is planning | gate1 | writing | gate2 | done | stopped | budget | changed
//   gate buttons    gate 1 (plan accepted): .vam-book-confirm   plan summary: .vam-book-open-plan   back: .vam-book-back-to-plan
//   cover           has no DOM class: it is a note block, check it with coverBlockExpression(path)
export const BOOK_SELECTORS = {
  startButton: ".vam-book-button",
  startGo: ".vam-book-start-go",
  startField: ".vam-book-start-field",
  startHint: ".vam-book-start-hint",
  bar: ".vam-book-bar",
  barTitle: ".vam-book-bar-title",
  barCounts: ".vam-book-bar-counts",
  barNow: ".vam-book-now",
  track: ".vam-book-track",
  stop: ".vam-book-stop",
  resume: ".vam-book-resume",
  restart: ".vam-book-restart",
  gate1Confirm: ".vam-book-confirm",
  openPlan: ".vam-book-open-plan",
  backToPlan: ".vam-book-back-to-plan",
  addBudget: ".vam-book-add-budget",
  openIssues: ".vam-book-open-issues",
  abandon: ".vam-book-abandon",
  abandonConfirm: ".vam-book-abandon-confirm",
  abandonCancel: ".vam-book-abandon-cancel",
  cardState: ".vam-book-state",
  cardRole: ".vam-book-role",
  appliedNotice: ".vam-book-applied-notice"
};

/** Selector for the bar in one mode, e.g. barMode("gate1"). */
export const barMode = mode => `${BOOK_SELECTORS.bar}[data-mode='${mode}']`;

/** JavaScript for an "eval"/"assert" step: true when the note at `path` carries a book-cover block (`<!-- book-cover:v1 ... -->`). */
export const coverBlockExpression = path => `app.vault.adapter.read(${JSON.stringify(path)}).then(text=>/<!-- book-cover:v1 /.test(text)&&/<!-- book-cover:end -->/.test(text))`;
