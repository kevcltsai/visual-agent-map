// Picks the test files a change can affect, from the dependency table test-deps.json.
//   node scripts/test-affected.mjs [<base>] [--json]   prints the plan (default base: origin/main)
//   node scripts/test-affected.mjs --run [<base>]      runs the planned unit and integration tests (npm run test:affected)
//   node scripts/test-affected.mjs --write-deps <dir>  merges the records tests/build.cjs wrote into <dir> (VAM_TEST_DEPS_DIR) with a static scan into test-deps.json
// Every doubt is answered with the full suite: a missing or stale table, an unknown changed file, or any error here.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
export const DEPS_VERSION = 1;
export const depsPath = (root = defaultRoot) => process.env.VAM_TEST_DEPS_FILE || join(root, "test-deps.json");

// Changes that can alter any test: infrastructure, fixtures, tooling, configuration (fail-closed, spec 3).
export const FULL_SUITE_PATTERNS = [
  /^tests\/support[^/]*$/, /^tests\/build\.cjs$/, /^tests\/run\.cjs$/, /^tests\/tools\//, /^tests\/fixtures\//,
  /^scripts\//, /^package\.json$/, /^package-lock\.json$/, /^esbuild\.config\.mjs$/, /(^|\/)tsconfig[^/]*\.json$/, /^\.github\//, /^\.githooks\//,
];
// Documentation that no product code reads. A document a test does read is in the table and is handled like code.
export const DOC_PATTERNS = [/^README[^/]*$/, /^CHANGELOG[^/]*$/, /^INSTALL\.md$/, /^docs\//];
const isDoc = file => DOC_PATTERNS.some(pattern => pattern.test(file));
const fullSuiteReason = file => FULL_SUITE_PATTERNS.some(pattern => pattern.test(file));

const HELPER = /^tests\/(?:support[^/]*|build\.cjs|run\.cjs)$/;
/** Test files: every suite under tests/suites and every non-helper .cjs/.mjs directly under tests/. */
export function listTestFiles(root = defaultRoot) {
  const suites = readdirSync(join(root, "tests/suites")).filter(name => name.endsWith(".cjs")).map(name => `tests/suites/${name}`);
  const top = readdirSync(join(root, "tests")).filter(name => /\.(?:cjs|mjs)$/.test(name)).map(name => `tests/${name}`).filter(file => !HELPER.test(file));
  return [...suites, ...top].sort();
}

// ---------- static scan ----------
const LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)`/g;
const FILE_LIKE = /\.(?:ts|md|json|css|js|mjs|cjs|html|svg|txt|yml|yaml|png)$/;
const FS_CALL = /\b(?:readFileSync|readFile|readdirSync|readdir|existsSync|statSync|lstatSync|opendirSync|createReadStream|cpSync|copyFileSync|accessSync|realpathSync)\s*\(/g;
const SPAWN = /(?:require\(\s*['"](?:node:)?child_process['"]\s*\)|from\s+['"](?:node:)?child_process['"]|import\(\s*['"](?:node:)?child_process['"]\s*\))/;
const OWN_ESBUILD = /(?:require\(\s*['"]esbuild['"]\s*\)|from\s+['"]esbuild['"]|import\(\s*['"]esbuild['"]\s*\))/;

function splitTopLevel(text) {
  const parts = []; let depth = 0, quote = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}
/** Text between the "(" that ends at `open` and its matching ")". */
function argumentsAt(text, open) {
  let depth = 1, quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(open, i);
  }
  return null;
}

const ROOT_NAMES = /^(?:root|projectRoot|repoRoot|ROOT|REPO_ROOT|S\.root)$/;
const MENTIONS_ROOT = /\b(?:root|projectRoot|repoRoot|ROOT|REPO_ROOT|__dirname|cwd)\b/;
const PATH_CALL = /^(?:[A-Za-z_$][\w$]*\.|require\(\s*['"](?:node:)?path['"]\s*\)\.)?(join|resolve)\(([\s\S]*)\)$/;
/**
 * Evaluates a path expression made of literals, the repo root, __dirname and consts built from them.
 * Returns { value, exact }: `exact` false means a run-time part followed `value` (a directory prefix); null when nothing is known.
 */
function evalPartial(expr, env) {
  const text = expr.trim().replace(/^\(\s*([\s\S]*)\s*\)$/, "$1").replace(/\s+as\s+\w+$/, "");
  const literal = text.match(/^(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")$/);
  if (literal) return { value: literal[1] ?? literal[2], exact: true };
  if (text === "process.cwd()" || ROOT_NAMES.test(text)) return { value: env.root, exact: true };
  if (text === "__dirname") return { value: env.dir, exact: true };
  if (Object.hasOwn(env.consts, text)) return { value: env.consts[text], exact: true };
  const template = text.match(/^`((?:[^`\\]|\\.)*)`$/);
  if (template) {
    let value = "";
    for (const piece of template[1].split(/(\$\{[^}]*\})/).filter(Boolean)) {
      if (!piece.startsWith("${")) { value += piece; continue; }
      const inner = evalPartial(piece.slice(2, -1), env);
      if (!inner?.exact) return value ? { value: value.replace(/[^/]*$/, ""), exact: false } : null;
      value += inner.value;
    }
    return { value, exact: true };
  }
  const call = text.match(PATH_CALL);
  if (call) {
    const pieces = [];
    for (const part of splitTopLevel(call[2])) {
      const piece = evalPartial(part, env);
      if (!piece) return pieces.length ? { value: (call[1] === "join" ? join : resolve)(...pieces), exact: false } : null;
      pieces.push(piece.value);
      if (!piece.exact) return { value: (call[1] === "join" ? join : resolve)(...pieces), exact: false };
    }
    return { value: (call[1] === "join" ? join : resolve)(...pieces), exact: true };
  }
  const url = text.match(/^(?:fileURLToPath\()?new URL\(\s*(['"])([^'"]*)\1\s*,\s*import\.meta\.url\s*\)\)?$/);
  if (url) return { value: resolve(env.dir, url[2]), exact: true };
  return null;
}
function collectConsts(text, env) {
  // Two passes so a const may use one declared after the first sweep resolved it.
  for (let pass = 0; pass < 3; pass++) {
    for (const match of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
      if (Object.hasOwn(env.consts, match[1])) continue;
      const value = evalPartial(match[2], env);
      if (value?.exact) env.consts[match[1]] = value.value;
    }
  }
}

/** Reads one test file's text: the repo files it names, the helpers it requires, and why its dependencies cannot be listed (always: reason). */
export function scanTestFile(root, rel, text = readFileSync(join(root, rel), "utf8")) {
  const dir = join(root, dirname(rel));
  const sources = new Set(), prefixes = new Set(), requires = new Set();
  const inRepo = abs => { const r = relative(root, abs).split("\\").join("/"); return r && !r.startsWith("..") && !r.startsWith("node_modules/") ? r : null; };
  const addAbs = abs => {
    const r = inRepo(abs);
    if (!r || !existsSync(abs)) return;
    if (statSync(abs).isDirectory()) prefixes.add(`${r.replace(/\/$/, "")}/`);
    else sources.add(r);
  };
  const reasons = [];
  if (SPAWN.test(text)) reasons.push("spawns a child process");
  if (rel !== "tests/build.cjs" && OWN_ESBUILD.test(text)) reasons.push("uses esbuild directly");
  const env = { root, dir, consts: {} };
  collectConsts(text, env);
  // Local requires: other files under tests/ form the helper closure, any other file is a source.
  for (const match of text.matchAll(/(?:require\(|import\(|from\s+)\s*(['"])(\.{1,2}\/[^'"]+)\1/g)) {
    const base = resolve(dir, match[2]);
    const found = [base, ...[".cjs", ".js", ".mjs", ".json", ".ts"].map(ext => base + ext), join(base, "index.js")].find(candidate => existsSync(candidate) && statSync(candidate).isFile());
    if (!found) continue; // a stub key such as overrides['./core/ai-calls'], not a file read
    const r = inRepo(found);
    if (r?.startsWith("tests/") && /\.(?:cjs|mjs|js)$/.test(r)) requires.add(r); else addAbs(found);
  }
  // File-system reads: every first argument must evaluate to a path, else the read cannot be tied to files.
  for (const match of text.matchAll(FS_CALL)) {
    const args = argumentsAt(text, match.index + match[0].length);
    if (args === null) { reasons.push("unparsed file read"); continue; }
    const first = splitTopLevel(args)[0] ?? "";
    const value = evalPartial(first, env);
    const rooted = MENTIONS_ROOT.test(first);
    // A bare variable (a temp directory, a parameter) has its repo paths in the literals scanned below; a path rooted in the repo but finished at run time is covered by its literal prefix.
    if (!value) { if (rooted) reasons.push(`reads a path built at run time: ${first.replace(/\s+/g, " ").slice(0, 60)}`); continue; }
    const abs = resolve(root, value.value);
    if (value.exact) { addAbs(abs); continue; }
    // A literal prefix only bounds the read when the path cannot climb out of it again.
    if (!/['"]\.\.\/?['"]|\.\.\//.test(first) && inRepo(abs) && existsSync(abs)) { prefixes.add(`${inRepo(abs).replace(/\/$/, "")}/`); continue; }
    if (rooted) reasons.push(`reads a path built at run time: ${first.replace(/\s+/g, " ").slice(0, 60)}`);
  }
  // Any string that names a repo file or directory (load('core/x.ts'), a JSON path, a fixture directory).
  for (const match of text.matchAll(LITERAL)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (!value || value.length > 200 || /\s/.test(value) || !(FILE_LIKE.test(value) || value.includes("/"))) continue;
    const bare = value.replace(/^(?:\.{1,2}\/)+/, "").replace(/\/$/, "");
    if (!bare) continue;
    for (const base of [root, join(root, "tests"), join(root, "tests/suites"), dir]) {
      const abs = join(base, bare);
      if (existsSync(abs) && inRepo(abs)) addAbs(abs);
    }
  }
  // A helper that keeps a loaded module in a variable (`X ??= load('a.ts')`) loads it once per process, so only the first caller is recorded: its entry files are listed here and expanded to their bundles.
  const cachedLoads = [...text.matchAll(/(?:\?\?=|\|\|=)\s*[^;\n]*?\bload\(\s*(['"])([^'"]+)\1/g), ...text.matchAll(/if\s*\(\s*!\s*[\w$.]+\s*\)\s*[\w$.]+\s*=\s*[^;\n]*?\bload\(\s*(['"])([^'"]+)\1/g)].map(match => match[2]);
  return { sources: [...sources].sort(), prefixes: [...prefixes].sort(), requires: [...requires].sort(), reasons: [...new Set(reasons)], cachedLoads: [...new Set(cachedLoads)].sort() };
}

/** Reason class for a report: the first reason, shortened to its kind. */
export const reasonKind = reason => (reason.startsWith("reads a path") ? "reads a path built at run time" : reason.replace(/ \(in .*\)$/, ""));

// ---------- dependency table ----------
/**
 * records: { "tests/x.cjs": ["core/a.ts", ...] } merged from the build.cjs records of a full run; bundles: the same for entry files (a helper's cached loads).
 * scans: { file: scanTestFile result } for every file under tests/ that is a test or a helper.
 * Returns the table; a test's sources are its own records and scans plus those of every helper it requires.
 */
export function buildDeps({ testFiles, records, bundles = {}, scans, sha, generatedAt = new Date().toISOString() }) {
  const paths = [];
  const index = new Map();
  const id = file => { if (!index.has(file)) { index.set(file, paths.length); paths.push(file); } return index.get(file); };
  const tests = {};
  for (const file of testFiles) {
    const closure = new Set([file]);
    for (const next of closure) for (const required of scans[next]?.requires ?? []) closure.add(required);
    const sources = new Set(), prefixes = new Set(), reasons = [];
    for (const member of closure) {
      for (const source of records[member] ?? []) sources.add(source);
      for (const source of scans[member]?.sources ?? []) sources.add(source);
      for (const entry of scans[member]?.cachedLoads ?? []) for (const source of [entry, ...(bundles[entry] ?? [])]) sources.add(source);
      for (const prefix of scans[member]?.prefixes ?? []) prefixes.add(prefix);
      // A helper's own run-time reads take their paths from the callers, whose literals are scanned; only spawning and direct esbuild carry over.
      for (const reason of scans[member]?.reasons ?? []) if (member === file) reasons.push(reason); else if (/^(?:spawns|uses esbuild)/.test(reason)) reasons.push(`${reason} (in ${member})`);
      if (member !== file) sources.add(member);
    }
    tests[file] = { ...(reasons.length ? { always: [...new Set(reasons)].join("; ") } : {}), sources: [...sources].sort().map(id), prefixes: [...prefixes].sort() };
  }
  return { version: DEPS_VERSION, sha, generatedAt, paths, tests };
}

/** Parses and validates a table; anything else throws. */
export function parseDeps(text) {
  const deps = JSON.parse(text);
  if (!deps || deps.version !== DEPS_VERSION || typeof deps.sha !== "string" || !/^[0-9a-f]{7,40}$/.test(deps.sha) || !Array.isArray(deps.paths) || !deps.tests || typeof deps.tests !== "object") throw new Error("test-deps.json has an unexpected shape");
  return deps;
}

// ---------- selection ----------
const full = reason => ({ mode: "full", files: [], reasons: [reason] });

/**
 * changed: repo-relative paths. deps: parsed table or null. testFiles: tests that exist now.
 * shaIsAncestor: whether the table's commit is an ancestor of the base (the caller asks git).
 * Returns { mode: "full" | "none" | "files", files, reasons }; any throw is the caller's to turn into "full".
 */
export function selectTests({ changed, deps, testFiles, shaIsAncestor = true }) {
  const files = [...new Set(changed)].filter(file => file !== "test-deps.json");
  if (!files.length) return full("no changed files");
  const infra = files.find(fullSuiteReason);
  if (infra) return full(`${infra} changes what every test runs on`);
  if (!deps) return full("dependency table test-deps.json is missing or unreadable");
  if (!shaIsAncestor) return full(`dependency table commit ${deps.sha.slice(0, 9)} is not an ancestor of the base`);
  const covered = (entry, file) => entry.sources.some(i => deps.paths[i] === file) || entry.prefixes.some(prefix => file.startsWith(prefix));
  const picked = new Map(); // test file -> reasons
  const pick = (test, reason) => { if (!picked.has(test)) picked.set(test, []); picked.get(test).push(reason); };
  const current = new Set(testFiles);
  let relevant = 0;
  for (const file of files) {
    const entries = Object.entries(deps.tests);
    const readers = entries.filter(([, entry]) => covered(entry, file));
    const isTest = Object.hasOwn(deps.tests, file) || current.has(file);
    if (isDoc(file) && !readers.length) continue; // documentation no test reads
    relevant++;
    if (!readers.length && !isTest) return full(`${file} is not in the dependency table`);
    if (isTest && current.has(file)) pick(file, `${file} changed`);
    for (const [test] of readers) pick(test, `uses ${file}`);
  }
  for (const [test, entry] of Object.entries(deps.tests)) if (entry.always) pick(test, `always runs: ${entry.always}`);
  for (const test of testFiles) if (!Object.hasOwn(deps.tests, test)) pick(test, "not in the dependency table");
  if (!relevant) return { mode: "none", files: [], reasons: ["only documentation changed; no test reads it"] };
  const selected = [...picked.keys()].filter(test => current.has(test)).sort();
  return { mode: "files", files: selected, reasons: selected.flatMap(test => picked.get(test).map(reason => `${test}: ${reason}`)) };
}

// ---------- git ----------
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
export function changedFiles(root, base) {
  const lines = out => out.split("\n").map(line => line.trim()).filter(Boolean);
  return [...new Set([
    ...lines(git(root, "diff", "--name-only", `${base}...HEAD`)),
    ...lines(git(root, "diff", "--name-only", "HEAD")),
    ...lines(git(root, "ls-files", "--others", "--exclude-standard")),
  ])];
}
export function isAncestor(root, ancestor, descendant) {
  try { execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: root, stdio: "ignore" }); return true; } catch { return false; }
}

/** The whole decision for a working tree; never throws: an error is a full-suite answer. */
export function plan(root = defaultRoot, base = "origin/main") {
  try {
    const changed = changedFiles(root, base);
    let deps = null;
    try { deps = parseDeps(readFileSync(depsPath(root), "utf8")); } catch { /* absent or unreadable: selectTests answers full */ }
    return selectTests({ changed, deps, testFiles: listTestFiles(root), shaIsAncestor: deps ? isAncestor(root, deps.sha, base) : false });
  } catch (error) {
    return full(`test-affected failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

// ---------- writing the table ----------
export function writeDeps(root, recordDir, sha) {
  const records = {}, bundles = {};
  for (const name of readdirSync(recordDir).filter(file => file.endsWith(".json"))) {
    const dump = JSON.parse(readFileSync(join(recordDir, name), "utf8"));
    for (const [target, from] of [[records, dump.callers ?? {}], [bundles, dump.bundles ?? {}]]) {
      for (const [key, sources] of Object.entries(from)) {
        const set = (target[key] ??= new Set());
        for (const source of sources) set.add(source);
      }
    }
  }
  for (const target of [records, bundles]) for (const key of Object.keys(target)) target[key] = [...target[key]];
  const testFiles = listTestFiles(root);
  const everything = new Set([...testFiles, ...readdirSync(join(root, "tests")).filter(name => /\.(?:cjs|mjs)$/.test(name)).map(name => `tests/${name}`)]);
  const scans = {};
  for (const file of everything) scans[file] = scanTestFile(root, file);
  const deps = buildDeps({ testFiles, records, bundles, scans, sha });
  mkdirSync(dirname(depsPath(root)), { recursive: true });
  writeFileSync(depsPath(root), `${JSON.stringify(deps)}\n`);
  return deps;
}

function report(result, json) {
  if (json) return process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`test-affected: ${result.mode}${result.mode === "files" ? ` (${result.files.length} test files)` : ""}\n`);
  for (const reason of result.reasons) process.stdout.write(`  ${reason}\n`);
}

async function main(argv) {
  const args = argv.filter(arg => !arg.startsWith("--"));
  const root = defaultRoot;
  if (argv[0] === "--write-deps") {
    const sha = git(root, "rev-parse", "HEAD").trim();
    const deps = writeDeps(root, resolve(argv[1]), sha);
    const always = Object.entries(deps.tests).filter(([, entry]) => entry.always);
    process.stdout.write(`test-deps.json: ${Object.keys(deps.tests).length} test files at ${sha.slice(0, 9)}, ${always.length} always run\n`);
    return;
  }
  const result = plan(root, args[0] || "origin/main");
  report(result, argv.includes("--json"));
  if (!argv.includes("--run")) return;
  if (result.mode === "none") return;
  const env = { ...process.env };
  if (result.mode === "files") env.VAM_AFFECTED_TESTS = result.files.join(",");
  for (const script of ["test:unit", "test:integration"]) {
    const run = spawnSync("npm", ["run", script], { cwd: root, stdio: "inherit", env });
    if (run.status !== 0) { process.exitCode = run.status ?? 1; return; }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
