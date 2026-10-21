// Checks every registered language dictionary against English (the key source):
//   - key set equal to en (missing and extra keys)
//   - placeholder multisets equal: {0}, {1}, ... and {{name}}
//   - Markdown/structure token counts equal: **, `, [[, ]], ](, line-start #, > and "- ", HTML tags, newlines
//   - coffee.* keys contiguous between the coffee:begin / coffee:end markers of each dictionary file
// Usage: node scripts/check-i18n.mjs [--root <dir>]   (<dir> holds i18n/languages.ts; default: the repository root)
import { buildSync } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const count = (text, pattern) => (text.match(pattern) ?? []).length;
const placeholders = text => [...(text.match(/\{\{[^{}]*\}\}|\{\d+\}/g) ?? [])].sort().join(" ");
const TOKENS = [
  ["**", text => count(text, /\*\*/g)],
  ["`", text => count(text, /`/g)],
  ["[[", text => count(text, /\[\[/g)],
  ["]]", text => count(text, /\]\]/g)],
  ["](", text => count(text, /\]\(/g)],
  ["line-start #", text => count(text, /^#/gm)],
  ["line-start >", text => count(text, /^>/gm)],
  ["line-start '- '", text => count(text, /^- /gm)],
  ["HTML tag", text => count(text, /<\/?[A-Za-z][^<>]*>/g)],
  ["newline", text => count(text, /\n/g)]
];

/** Compares `dictionaries` ({ id: { key: string } }) with English; returns [{ language, key, reason }]. */
export function checkDictionaries(dictionaries) {
  const problems = [];
  const english = dictionaries.en;
  if (!english) return [{ language: "en", key: "-", reason: "English dictionary is not registered" }];
  const englishKeys = Object.keys(english);
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    if (language === "en") continue;
    const keys = new Set(Object.keys(dictionary));
    for (const key of englishKeys) if (!keys.has(key)) problems.push({ language, key, reason: "missing key (present in en)" });
    for (const key of keys) if (!(key in english)) problems.push({ language, key, reason: "extra key (absent from en)" });
    for (const key of englishKeys) {
      const value = dictionary[key];
      if (typeof value !== "string") continue;
      const source = english[key];
      if (placeholders(value) !== placeholders(source)) {
        problems.push({ language, key, reason: `placeholders differ: en [${placeholders(source)}] vs [${placeholders(value)}]` });
      }
      for (const [name, measure] of TOKENS) {
        const expected = measure(source);
        const actual = measure(value);
        if (expected !== actual) problems.push({ language, key, reason: `${name} count differs: en ${expected} vs ${actual}` });
      }
    }
  }
  return problems;
}

/** Each dictionary file keeps all coffee.* keys in one block between the coffee:begin and coffee:end markers. */
export function checkCoffeeBlock(language, source) {
  const problems = [];
  const lines = source.split("\n");
  const begin = lines.findIndex(line => line.includes("coffee:begin"));
  const end = lines.findIndex(line => line.includes("coffee:end"));
  if (begin < 0 || end < begin) return [{ language, key: "coffee.*", reason: "coffee:begin / coffee:end markers are missing" }];
  lines.forEach((line, index) => {
    const inCoffee = /^\s*"coffee\./.test(line);
    const inside = index > begin && index < end;
    if (inCoffee !== inside && (inCoffee || /^\s*"[^"]+":/.test(line))) {
      problems.push({ language, key: (line.match(/"([^"]+)"/) ?? [])[1] ?? `line ${index + 1}`, reason: inCoffee ? "coffee.* key outside the coffee block" : "non-coffee key inside the coffee block" });
    }
  });
  return problems;
}

function bundle(file) {
  const code = buildSync({ entryPoints: [file], bundle: true, write: false, format: "cjs", platform: "node", logLevel: "silent" }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports });
  return module.exports;
}

function loadFromRoot(root) {
  const registry = (bundle(path.join(root, "i18n", "languages.ts"))).LANGUAGES;
  const dictionaries = {};
  const problems = [];
  for (const { id } of registry) {
    const file = path.join(root, "i18n", `${id}.ts`);
    if (!existsSync(file)) {
      problems.push({ language: id, key: "-", reason: `dictionary file i18n/${id}.ts is missing` });
      continue;
    }
    dictionaries[id] = Object.values(bundle(file)).find(value => value && typeof value === "object");
    problems.push(...checkCoffeeBlock(id, readFileSync(file, "utf8")));
  }
  return { dictionaries, problems };
}

export function checkRoot(root) {
  const { dictionaries, problems } = loadFromRoot(root);
  return [...problems, ...checkDictionaries(dictionaries)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv.indexOf("--root");
  const root = flag >= 0 ? path.resolve(process.argv[flag + 1]) : path.resolve(here, "..");
  const problems = checkRoot(root);
  if (problems.length) {
    for (const { language, key, reason } of problems.slice(0, 200)) process.stderr.write(`check:i18n ${language} ${key}: ${reason}\n`);
    if (problems.length > 200) process.stderr.write(`check:i18n ... and ${problems.length - 200} more\n`);
    process.stderr.write(`check:i18n failed with ${problems.length} problem(s).\n`);
    process.exit(1);
  }
  process.stdout.write("check:i18n passed.\n");
}
