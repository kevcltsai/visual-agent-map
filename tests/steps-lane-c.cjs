// Runtime steering messages (retained after removal of the Coffee Tables reframing step).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, root } = require('./support-replay.cjs');
const { searchBudgetExhaustedMessage } = load('ai/runtime/messages/index.ts');
test('the search-budget steer text comes from runtime message files in both languages and is gone from i18n', () => {
  assert.equal(searchBudgetExhaustedMessage('en'), 'The web search budget is used up. Stop searching and finish the answer from the information already gathered; list anything missing as unconfirmed.');
  assert.equal(searchBudgetExhaustedMessage('zh-TW'), '網路搜尋預算已用完。請停止搜尋，根據已取得的資料完成答案；不足之處明確列為待確認。');
  assert.doesNotMatch(require('./support.cjs').i18nSource(), /prompt\.search_budget_exhausted/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'ai', 'runtime', 'codex-app-server.ts'), 'utf8'), /search_budget_exhausted/);
  assert.match(fs.readFileSync(path.join(root, 'ai', 'runtime', 'codex-app-server.ts'), 'utf8'), /searchBudgetExhaustedMessage\(\)/);
});

