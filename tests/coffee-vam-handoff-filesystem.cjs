const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
class TFolder {
  constructor(filePath) { this.path = filePath; this.name = path.posix.basename(filePath); }
}
class TFile {
  constructor(filePath) {
    this.path = filePath;
    this.name = path.posix.basename(filePath);
    this.basename = this.name.replace(/\.md$/, '');
    this.extension = path.extname(this.name).slice(1);
  }
}
const yaml = require('yaml');
const obsidian = {
  TFile,
  TFolder,
  normalizePath: value => value.replace(/\\/g, '/').replace(/\/+/g, '/'),
  parseYaml: value => yaml.parse(value),
  stringifyYaml: value => yaml.stringify(value),
};

function load(entry) {
  const code = buildSync({
    entryPoints: [path.join(root, entry)], bundle: true, write: false,
    platform: 'node', format: 'cjs', external: ['obsidian', 'node:*'],
  }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: name => name === 'obsidian' ? obsidian : require(name),
    console, crypto: require('node:crypto').webcrypto, AbortController, Buffer,
    window: { setTimeout, clearTimeout },
  });
  return module.exports;
}

function makeDiskVault(diskRoot) {
  const physical = virtualPath => path.join(diskRoot, ...virtualPath.split('/').filter(Boolean));
  const asFile = virtualPath => new TFile(virtualPath);
  const files = async (folder = '') => {
    const directory = physical(folder);
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const entry of entries) {
      const child = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) result.push(...await files(child));
      else if (entry.name.endsWith('.md')) result.push(asFile(child));
    }
    return result;
  };
  const abstract = virtualPath => {
    const target = physical(virtualPath);
    if (!fsSync.existsSync(target)) return null;
    return fsSync.statSync(target).isDirectory() ? new TFolder(virtualPath) : asFile(virtualPath);
  };
  const adapter = {
    async exists(virtualPath) { return fsSync.existsSync(physical(virtualPath)); },
    async mkdir(virtualPath) { await fs.mkdir(physical(virtualPath), { recursive: true }); },
    async read(virtualPath) { return fs.readFile(physical(virtualPath), 'utf8'); },
    async write(virtualPath, contents) {
      await fs.mkdir(path.dirname(physical(virtualPath)), { recursive: true });
      await fs.writeFile(physical(virtualPath), contents, 'utf8');
    },
    async process(virtualPath, change) {
      const target = physical(virtualPath), current = await fs.readFile(target, 'utf8'), next = change(current);
      await fs.writeFile(target, next, 'utf8'); return next;
    },
    async list(virtualPath) {
      let entries;
      try { entries = await fs.readdir(physical(virtualPath), { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return { files: [], folders: [] }; throw error; }
      return {
        files: entries.filter(entry => entry.isFile()).map(entry => `${virtualPath}/${entry.name}`),
        folders: entries.filter(entry => entry.isDirectory()).map(entry => `${virtualPath}/${entry.name}`),
      };
    },
  };
  const allMarkdownFiles = directory => {
    const target = physical(directory);
    if (!fsSync.existsSync(target)) return [];
    return fsSync.readdirSync(target, { withFileTypes: true }).flatMap(entry => {
      const child = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return allMarkdownFiles(child);
      return entry.name.endsWith('.md') ? [asFile(child)] : [];
    });
  };
  let failNextMapSave = false;
  const vault = {
    adapter,
    getAbstractFileByPath: abstract,
    getMarkdownFiles: () => allMarkdownFiles(''),
    async createFolder(virtualPath) {
      await fs.mkdir(physical(virtualPath), { recursive: true });
      return abstract(virtualPath);
    },
    async create(virtualPath, contents) {
      const target = physical(virtualPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents, { flag: 'wx' });
      return asFile(virtualPath);
    },
    async read(file) { return fs.readFile(physical(file.path), 'utf8'); },
    async cachedRead(file) { return fs.readFile(physical(file.path), 'utf8'); },
    async process(file, change) {
      if (failNextMapSave && file.path.endsWith('/Map.md')) {
        failNextMapSave = false;
        throw new Error('simulated transient map persistence failure');
      }
      const target = physical(file.path);
      const next = change(await fs.readFile(target, 'utf8'));
      await fs.writeFile(target, next, 'utf8');
      return next;
    },
    _failNextMapSave() { failNextMapSave = true; },
    _physical: physical,
    _allFiles: files,
  };
  const metadataCache = {
    getFileCache(file) {
      try {
        const content = fsSync.readFileSync(physical(file.path), 'utf8');
        const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
        return block ? { frontmatter: yaml.parse(block) ?? {} } : null;
      } catch { return null; }
    },
  };
  const app = { vault, metadataCache };
  return { app, vault, metadataCache, files, physical };
}

test('filesystem-backed Repository recovers a saved orphan VAM note after map save fails and a new Repository reopens', async t => {
  const diskRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'coffee-vam-handoff-'));
  t.after(() => fs.rm(diskRoot, { recursive: true, force: true }));
  const { app, vault, physical } = makeDiskVault(diskRoot);
  const { Repository, DEFAULT_SETTINGS } = load('repository.ts');
  const { ExperienceRouter } = load('core/experience-router.ts');
  const { createVisualMapHandoffHandler } = load('experiences/visual-map/handoff.ts');
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts');
  const { createSession } = load('experiences/coffee-tables/types.ts');
  const { buildCoffeeSource, createCoffeeHandoffArtifact } = load('experiences/coffee-tables/handoff-source.ts');
  const settings = {
    ...DEFAULT_SETTINGS,
    language: 'en',
    workspaceFolder: 'Workspace',
    topicsFolder: 'Workspace/Topics',
    inboxFolder: 'Workspace/Inbox',
    notesFolder: 'Workspace/Nodes',
    mapsFolder: 'Workspace/Maps',
  };
  const session = createSession('Fictional library hours', 'fixture-model', 'low', 'en');
  session.id = 'coffee-fs-session'; session.status = 'completed'; session.dirtyNotes = false;
  session.rounds = [{ id: 'r1', status: 'completed', createdAt: session.createdAt, markdown: 'P dialogue source.\nQ dialogue source.\nR dialogue source.', notes: '' }];
  session.observerNotes = ['# Observer’s notes\n\n## Questions worth pursuing\n- Evening access can help library users <!-- coffee-insight:v1:id=accepted-p --> <!-- source: P dialogue source. -->\n  - Reason: evening access addresses the barrier.\n\n## Questions and possible solutions\n- Keep a staffed desk for complex requests <!-- coffee-insight:v1:id=accepted-q --> <!-- source: Q dialogue source. -->\n  - Dissent: remote support reaches more people.\n  - Conditions and limits: staffing costs remain unknown.\n- Extend all hours <!-- coffee-insight:v1:id=unaccepted-r --> <!-- source: R dialogue source. -->\n  - Limitation: R remains unaccepted.'];
  const storage = new CoffeeStorage(vault, 'Workspace');
  await storage.save(session);
  const coffeePath = storage.sessionPath(session.id);
  const source = buildCoffeeSource(await new CoffeeStorage(vault, 'Workspace').load(coffeePath), ['accepted-p', 'accepted-q']);
  const reverseSource = buildCoffeeSource(await new CoffeeStorage(vault, 'Workspace').load(coffeePath), ['accepted-q', 'accepted-p']);
  assert.equal(source.artifactId, reverseSource.artifactId, 'selected insight ID order does not change the multi-insight identity');
  assert.equal(source.content, reverseSource.content, 'selected insight ID order does not change the multi-insight source payload');
  for (const preserved of ['Reason: evening access addresses the barrier.', 'Dissent: remote support reaches more people.', 'staffing costs remain unknown.', 'P dialogue source.', 'Q dialogue source.']) assert.ok(source.content.includes(preserved), `fresh CoffeeStorage read preserves ${preserved}:\n${source.content}`);
  const confirmation = {
    sessionId: session.id, sourcePath: coffeePath, topic: session.topic, source,
    question: source.question, content: `${source.content}\n\nUser-confirmed context`,
    model: session.model, reasoning: session.reasoning, language: session.language, reframingMethod: 'manual',
  };
  const artifact = createCoffeeHandoffArtifact(confirmation);
  assert.equal(createCoffeeHandoffArtifact({ ...confirmation, source: reverseSource }).id, artifact.id, 'formal handoff API preserves identity across selected ID order');
  assert.doesNotMatch(artifact.content, /R remains unaccepted|Extend all hours|R dialogue source/);

  const firstRepository = new Repository(app, settings);
  const registerHandoff = repo => {
    const router = new ExperienceRouter();
    router.register('visual-map', createVisualMapHandoffHandler({
      repo, defaultModel: () => 'fixture-model',
      exists: virtualPath => !!app.vault.getAbstractFileByPath(virtualPath),
      mutate: work => work(), navigate: async () => {},
    }));
    return router;
  };
  vault._failNextMapSave();
  await assert.rejects(
    registerHandoff(firstRepository).handoff({ target: 'visual-map', artifact }),
    error => error.name === 'HandoffWriteError' && error.paths.some(value => value.endsWith(`/Notes/${artifact.title}.md`)),
  );
  const mapPath = `Workspace/Topics/${artifact.title}/Map.md`;
  const orphanPath = `Workspace/Topics/${artifact.title}/Notes/${artifact.title}.md`;
  assert.ok(fsSync.existsSync(physical(orphanPath)), 'Repository wrote the note to a real file before the simulated Map save failure');
  assert.equal((await new Repository(app, settings).readMap(mapPath)).nodes.length, 0, 'the on-disk Map still has no link to the note');
  const orphan = await new Repository(app, settings).readNote(orphanPath);
  assert.match(orphan.detail, /evening access addresses the barrier/);
  assert.match(orphan.detail, /remote support reaches more people/);
  assert.match(orphan.detail, /staffing costs remain unknown/);
  assert.doesNotMatch(orphan.detail, /R remains unaccepted|Extend all hours|R dialogue source/);
  assert.match(orphan.thinkingOrigin, new RegExp(`artifact: ${artifact.id}`));

  const retryStorage = new CoffeeStorage(vault, 'Workspace');
  const retrySession = await retryStorage.load(coffeePath);
  const retrySource = buildCoffeeSource(retrySession, ['accepted-p', 'accepted-q']);
  assert.doesNotMatch(retrySource.content, /R remains unaccepted|Extend all hours|R dialogue source/);
  for (const preserved of ['Reason: evening access addresses the barrier.', 'Dissent: remote support reaches more people.', 'staffing costs remain unknown.', 'P dialogue source.', 'Q dialogue source.']) assert.ok(retrySource.content.includes(preserved), `retry fresh-load preserves ${preserved}`);
  const retryArtifact = createCoffeeHandoffArtifact({
    ...confirmation, topic: retrySession.topic, source: retrySource,
    question: retrySource.question,
    content: `${retrySource.content}\n\nUser-confirmed context`,
    model: retrySession.model, reasoning: retrySession.reasoning, language: retrySession.language,
  });
  assert.notStrictEqual(retryArtifact, artifact, 'retry rebuilds a new artifact from the fresh CoffeeStorage read');
  assert.equal(retryArtifact.id, artifact.id, 'fresh-loading the same selected insights preserves retry identity');

  const reopenedRepository = new Repository(app, settings);
  const result = await registerHandoff(reopenedRepository).handoff({ target: 'visual-map', artifact: retryArtifact });
  const savedMap = await new Repository(app, settings).readMap(mapPath);
  const savedNote = await new Repository(app, settings).readNote(orphanPath);
  assert.equal(savedMap.nodes.length, 1);
  assert.equal(savedMap.nodes[0].path, orphanPath);
  assert.equal(result.targetPath, mapPath);
  assert.ok(result.paths.includes(orphanPath));
  assert.match(savedNote.detail, /evening access addresses the barrier/);
  assert.match(savedNote.detail, /remote support reaches more people/);
  assert.match(savedNote.detail, /staffing costs remain unknown/);
  assert.doesNotMatch(savedNote.detail, /R remains unaccepted|Extend all hours|R dialogue source/);
  assert.match(savedNote.thinkingOrigin, new RegExp(`artifact: ${artifact.id}`));
  assert.equal((await fs.readdir(path.join(diskRoot, 'Workspace', 'Topics', artifact.title, 'Notes'))).filter(name => name.endsWith('.md')).length, 1);
  assert.equal((await fs.readdir(path.join(diskRoot, 'Workspace', 'Topics'))).filter(name => name === artifact.title).length, 1);
});
