// Run after installing repository dependencies: node scripts/benchmark-reference-lookup.mjs
// Synthetic source resolution only; not an Obsidian or whole-product benchmark.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const { load, obsidian } = createRequire(import.meta.url)('../tests/support.cjs');
const api = load('ai/reference-materials.ts', { obsidian });

function legacy(text, groups) {
  const docs = api.dedupeReferenceGroups(groups).flatMap(group => group.documents);
  return text.replace(/\[\[([^\]]+)\]\]/g, (original, target) => {
    const name = target.split('|')[0].trim();
    const exact = docs.filter(doc => doc.path === name);
    const matches = exact.length ? exact : docs.filter(doc => {
      const basename = doc.path.split('/').pop() ?? doc.path;
      return basename === name || basename.replace(/\.md$/i, '') === name;
    });
    if (matches.length > 1) return 'Source to confirm: ' + name;
    if (matches.length !== 1 || !matches[0].external) return original;
    return 'External source: ' + matches[0].path;
  });
}
function medianMs(fn) {
  fn();
  const samples = Array.from({ length: 7 }, () => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  });
  return samples.sort((a, b) => a - b)[3];
}
for (const [count, links] of [[1000, 200], [10000, 500], [10000, 1]]) {
  const groups = [{ id: 'g', documents: Array.from({ length: count }, (_, i) => ({ path: 'folder' + (i % 7) + '/note' + i + '.md', content: '', external: true })) }];
  const text = Array.from({ length: links }, (_, i) => '[[note' + ((i * 17) % count) + ']]').join(' ');
  const baseline = () => legacy(text, groups);
  const candidate = () => api.resolveSummaryReferences(text, groups);
  assert.equal(candidate(), baseline());
  process.stdout.write(JSON.stringify({ count, links, baselineMs: medianMs(baseline), candidateMs: medianMs(candidate) }) + '\n');
}
