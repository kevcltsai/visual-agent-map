// Shared source walk for tests that scan the whole repo. It skips agent worktrees kept inside the repo
// (`<root>/.claude/worktrees/`), whose copies of the sources are not part of the product under test.
const fs = require('node:fs');
const path = require('node:path');

const AGENT_WORKTREES = '.claude/worktrees';

/** True when `candidate` is `<root>/.claude/worktrees` or lies below it. Only the repo root's own folder counts. */
function isAgentWorktree(root, candidate) {
  const relative = path.relative(root, path.resolve(root, candidate)).split(path.sep).join('/');
  return relative === AGENT_WORKTREES || relative.startsWith(`${AGENT_WORKTREES}/`);
}

/**
 * Every file below `from` (default: the repo root) in directory order; `from` is relative to `root`.
 * `skipDirectories` are entry names left out at any depth; agent worktrees are always left out.
 * Returns paths relative to `root`, `/` separated.
 */
function repoFiles(root, { from = '', skipDirectories = [] } = {}) {
  const skipped = new Set(skipDirectories);
  return fs.readdirSync(path.join(root, from), { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(from, entry.name);
    if (isAgentWorktree(root, relative)) return [];
    if (!entry.isDirectory()) return [relative];
    return skipped.has(entry.name) ? [] : repoFiles(root, { from: relative, skipDirectories });
  });
}

module.exports = { isAgentWorktree, repoFiles };
