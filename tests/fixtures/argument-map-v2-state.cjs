// A complete, well-formed argumentMap v2 value for tests of the contract (V2 packet V1). `ids` names the node ids the value points to:
// P proposition, PR premises group, C conclusion, Q1 premise claim, D1 premise datum, Q2 testable claim, CMP comparison card, H1 hypothesis, N1 need.
// Returns plain JSON; every field of plan "資料契約" appears at least once so a validator that drops one fails a test.
const DEFAULT_IDS = { P: 'p', PR: 'pr', C: 'c', Q1: 'q1', D1: 'd1', Q2: 'q2', CMP: 'cmp', H1: 'h1', N1: 'n1' };

function v2State(ids = DEFAULT_IDS) {
  const assessment = { relevant: true, stance: 'supports', scopeFit: true, scopeNote: 'same period', sourceType: 'official statistics', underlyingSource: 'stats-office', alsoRelevantTo: [ids.H1] };
  const proof = { url: 'https://example.org/report', quote: 'rose to 9.2 percent', claim: 'rate rose', check: 'page_match', checkedAt: '2026-11-10T00:00:00.000Z' };
  return {
    v: 2,
    roles: { proposition: ids.P, premises: ids.PR, conclusion: ids.C },
    framing: {
      original: 'Why did the rate rise?', restatement: 'What caused the rate to rise in 2025?', presuppositions: ['the rate rose'], loadedTerms: [], vagueTerms: ['rise'], outOfScope: ['2026'],
      candidates: [{ id: 'k1', question: 'What caused the rise?', answerShape: 'cause', diff: 'none', kind: 'interpretation', unanswered: false }, { id: 'k2', question: 'How large is the rise?', answerShape: 'size', diff: 'asks size', kind: 'related', unanswered: true }],
      chosen: 'k1', settings: ['use national data'], composition: 'report each claim', attempts: 1, lockedAt: '2026-11-10T00:00:00.000Z'
    },
    claims: [
      { id: ids.Q1, text: 'The rate rose', type: 'fact', role: 'premise', dependsOn: [], definitions: [{ term: 'rate', meaning: 'annual average' }], status: 'done', result: 'holds',
        data: [{ id: ids.D1, need: 'rate by year', attempts: 1, state: 'found', stance: 'supports', proof, reason: 'ok', assessment }] },
      { id: ids.Q2, text: 'Policy X caused the rise', type: 'causal', role: 'testable', dependsOn: [ids.Q1], definitions: [], status: 'in_progress',
        comparison: { nodeId: ids.CMP, attempts: 0, state: 'pending', vetoes: [{ kind: 'missed_alternative', detail: 'a common cause', resolved: false }], allocations: [{ needId: ids.N1, hypothesisId: ids.H1 }], missedAlternativeAdded: false } }
    ],
    hypotheses: [{
      id: ids.H1, claimId: ids.Q2, role: 'primary', round: 1,
      predictions: [{ id: 'pr1', kind: 'support', text: 'rate rises after X', alsoPredictedBy: [{ hypothesisId: ids.H1, strength: 'weaker' }], auxiliary: [ids.Q1], required: true }],
      identification: { strategy: 'difference in differences', assumptions: ['parallel trends'] },
      needs: [{ id: ids.N1, predictionId: 'pr1', text: 'rate before and after X', criteria: { supports: 'rises', refutes: 'flat', irrelevant: 'other region' }, registered: 'pre', addedRound: 1, state: 'found', proof, reason: 'found', assessment }],
      verdict: { value: 'supported', by: 'ai', reason: 'consistent', citedNeeds: [ids.N1], counterNotes: [], refutations: [{ needId: ids.N1, class: 'nondecisive', auxiliary: [ids.Q1] }], causal: 'conditional', assumptionStatus: [{ assumption: 'parallel trends', status: 'defended', defense: 'pre-trend flat' }], confidence: 'medium', reverdicts: 0 },
      userVerdict: 'refuted'
    }],
    run: { runId: 'run-2', phase: 'analysis', status: 'paused', stopReason: 'user', researchCalls: 3 },
    conclusion: { state: 'pending', answers: [{ claimId: ids.Q2, answer: 'causal_conditional', sentence: 'Under parallel trends, X raised the rate.', assumptions: ['parallel trends'] }], overall: 'partial', deleted: ['an unsupported sentence'] }
  };
}
module.exports = { v2State, DEFAULT_IDS };
