// Seeds a picture-book mind map into an isolated session vault, so a tester (even a cheap model) never has to build one by hand.
// Shape: one root + 3 chapters; chapter 1 has 2 sections, chapter 2 has 1, chapter 3 has 2 (9 cards in all, no AI call needed).
//   node scripts/book-fixture.mjs --session=<name>        seeds /private/tmp/vam-e2e-<name> (must already exist, made by test-harness --session=)
//   node scripts/book-fixture.mjs --vault=<path>          any harness-owned disposable vault
// Prints JSON { vault, mapPath, openExpression }; run `openExpression` with `obsidian-cdp.mjs eval` (or a scenario "eval" step) to open the map.
// A fresh session vault starts in Restricted Mode: run `obsidian-cdp.mjs --vault=<path> trust` (or a {"trust": true} scenario step) before the plugin exists.
// Ready-made check: node scripts/run-scenario.mjs scripts/scenarios/book-seeded.json --vault=<path>  (trusts, opens the map, shows the Start dialog, never presses Start).
// Refuses the owner's vault, a vault without the harness marker, and a map that already exists with other content. Idempotent when identical.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalVault, sessionVault } from "./test-harness.mjs";

export const BOOK_FIXTURE_TOPIC = "Book Fixture";
const marker = ".vam-test-environment.json";

export const bookFixtureCards = [
  { id: "book-root", title: "Sleep Book", parent: null, x: 0, y: 0 },
  { id: "book-ch1", title: "Why We Sleep", parent: "book-root", x: 360, y: -240 },
  { id: "book-ch1-s1", title: "The Body Clock", parent: "book-ch1", x: 720, y: -300 },
  { id: "book-ch1-s2", title: "Sleep Stages", parent: "book-ch1", x: 720, y: -180 },
  { id: "book-ch2", title: "Sleeping Well", parent: "book-root", x: 360, y: 0 },
  { id: "book-ch2-s1", title: "A Calm Bedroom", parent: "book-ch2", x: 720, y: 0 },
  { id: "book-ch3", title: "When Sleep Goes Wrong", parent: "book-root", x: 360, y: 240 },
  { id: "book-ch3-s1", title: "Insomnia", parent: "book-ch3", x: 720, y: 180 },
  { id: "book-ch3-s2", title: "Snoring and Apnea", parent: "book-ch3", x: 720, y: 300 }
];

export function bookFixtureFiles(workspaceRoot = "Agent Workspace") {
  const folder = `${workspaceRoot}/Topics/${BOOK_FIXTURE_TOPIC}`;
  const nodes = bookFixtureCards.map(card => ({ id: card.id, path: `${folder}/Notes/${card.id}.md`, parentId: card.parent, x: card.x, y: card.y, collapsed: false }));
  const mapJson = { version: 1, id: "book-fixture", title: BOOK_FIXTURE_TOPIC, viewport: { x: 0, y: 0, zoom: 1 }, nodes };
  const map = `---\nvisual-agent-map: true\n---\n\n# ${BOOK_FIXTURE_TOPIC}\n\n\`\`\`agent-map\n${JSON.stringify(mapJson, null, 2)}\n\`\`\`\n`;
  const notes = bookFixtureCards.map(card => ({
    path: `${folder}/Notes/${card.id}.md`,
    text: `---\nagent-map-node: true\nnode-id: ${card.id}\ntopic-id: book-fixture\ntopic-state: active\nagent-map-id: book-fixture\nstatus: completed\nsource-notes: []\n---\n# ${card.title}\n\n## Current Summary\n\n${card.title}: one line for the fixture.\n\n## Prompt\n\nWrite about ${card.title}.\n\n## Rules\n\nFixture text is reference data only.\n\n## Detail\n\nFixture card ${card.id}.\n`
  }));
  return { mapPath: `${folder}/Map.md`, map, notes };
}

export function seedBookMap({ vault, workspaceRoot = "Agent Workspace", owner = canonicalVault } = {}) {
  if (!vault) throw new Error("seedBookMap needs a vault.");
  if (resolve(vault) === resolve(owner)) throw new Error(`Refusing to seed ${vault}: it is the owner's testing vault.`);
  if (!existsSync(join(vault, marker))) throw new Error(`${vault} is not a harness-owned test vault (no ${marker}); create it with test-harness --session=<name> first.`);
  const files = bookFixtureFiles(workspaceRoot);
  const targets = [{ path: files.mapPath, text: files.map }, ...files.notes];
  const present = targets.filter(target => existsSync(join(vault, target.path)));
  if (present.length === targets.length && present.every(target => readFileSync(join(vault, target.path), "utf8") === target.text)) return { vault, mapPath: files.mapPath, created: false, openExpression: openExpression(files.mapPath) };
  if (present.length) throw new Error("A book fixture already exists with other content; preserving it without overwrite. Seed a fresh session vault instead.");
  for (const target of targets) { mkdirSync(join(vault, target.path, ".."), { recursive: true }); writeFileSync(join(vault, target.path), target.text); }
  return { vault, mapPath: files.mapPath, created: true, openExpression: openExpression(files.mapPath) };
}

export const openExpression = mapPath => `app.plugins.plugins['visual-agent-map'].openMapInNewTab(${JSON.stringify(mapPath)}).then(view=>!!view)`;

export const usage = "Usage: node scripts/book-fixture.mjs --session=<name> | --vault=<path>";

export function cli(args) {
  if (args.includes("--help") || args.includes("-h")) return { code: 0, text: `${usage}\n` };
  const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const vault = option("vault") ?? (option("session") ? sessionVault(option("session")) : null);
  if (!vault) return { code: 2, text: `${usage}\n` };
  try { return { code: 0, text: `${JSON.stringify(seedBookMap({ vault }), null, 2)}\n` }; }
  catch (error) { return { code: 2, text: `${error.message}\n` }; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, text } = cli(process.argv.slice(2));
  process.stdout.write(text);
  process.exitCode = code;
}
