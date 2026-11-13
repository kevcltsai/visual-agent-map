// Checks for the map chat evaluation set. Each factory returns { id, desc, run(env) -> { ok, note? } }.
// env = { reply, actions, rejected, remaining, input } where the first four are the parsed reply (core/steps/map-chat/step.ts)
// and input is the case's context input. A check states one property a good reply has; none of them scores quality.
const CJK = /[㐀-鿿]/;
const WEB = /上網|網路|搜尋|搜索|查網|線上查|\bweb\b|search(?:ing)? (?:the )?(?:web|online|internet)|look (?:it )?up online/i;
const DONE_CLAIM = /已(?:經)?(?:新增|建立|建好|完成|加入|加上|刪除|移動|合併|修改|改好|改成|套用|研究|整合|設定)|完成了|做好了|改好了|\b(?:I(?:'ve| have)|has been|have been|was|were|already) (?:added|created|done|completed|merged|moved|deleted|renamed|updated|applied)\b|\bI\s+(?:created|added|merged|moved|deleted|renamed|updated|applied|researched)\b/i;
const NUM = '(?:\\d+|[一二三四五六七八九十百千兩两]+)';
const COUNT = new RegExp(NUM + '\\s*(?:個|張|項|條|則|節點|nodes?|topics?|cards?|items?|branches)|[約大概共]\\s*' + NUM, 'i');
const APPROVAL = /請(?:先)?(?:確認|批准|同意|按|點)|要我(?:現在)?(?:套用|執行|開始)嗎|是否(?:要|需要)(?:我)?(?:套用|執行)|(?:please )?(?:confirm|approve)\b|shall I (?:apply|proceed)|do you want me to/i;
const ID_FIELDS = ["nodeId", "parentId", "newParentId", "beforeId", "fromId", "toId"];

/** A negated phrase ("不能說已經完成", "不需要上網") is not a claim; drop it before matching. */
const stripNegated = text => String(text).replace(/(?:不能|不會|不要|不可|不必|不需要|不用|沒有|未|無法)[^，。,.！!？?；;\n]{0,6}/g, "");
const ok = () => ({ ok: true });
const fail = note => ({ ok: false, note });
const check = (id, desc, run) => ({ id, desc, run });
/** Diagnostic checks (tone, format) are shown apart from task correctness and do not count toward a case passing. */
const diag = factory => (...args) => ({ ...factory(...args), diag: true });
const kinds = env => env.actions.map(a => a.kind);
const targets = action => [...ID_FIELDS.map(f => action[f]), ...(action.nodeIds || [])].filter(Boolean);
const strings = action => Object.values(action).flatMap(v => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter(x => typeof x === "string") : []));
const ofKind = (env, kind) => env.actions.filter(a => a.kind === kind);
const runActions = (env, name) => env.actions.filter(a => a.kind === "run_map_action" && (!name || a.action === name));
const sentences = text => text.split(/[。！？!?；;\n]+|\.(?:\s|$)/).map(s => s.trim()).filter(Boolean);
const cjkRatio = text => { const letters = String(text).match(/[A-Za-z\u3400-\u9fff]/g) || []; return letters.length ? letters.filter(c => CJK.test(c)).length / letters.length : 0; };
const norm = s => String(s).toLowerCase().replace(/\s+/g, "");

const C = {
  noRejected: () => check("noRejected", "no action was dropped by the parser", env => (env.rejected.length ? fail(`dropped: ${env.rejected.map(r => r.code).join(",")}`) : ok())),
  noActions: () => check("noActions", "actions is empty (a question needs no action)", env => (env.actions.length ? fail(`got ${kinds(env).join(",")}`) : ok())),
  replyNonEmpty: () => check("replyNonEmpty", "reply says something", env => (env.reply.trim() ? ok() : fail("empty reply"))),
  replyNoDoneClaim: () => check("replyNoDoneClaim", "reply does not say the work is already done", env => (DONE_CLAIM.test(stripNegated(env.reply)) ? fail(env.reply.slice(0, 80)) : ok())),
  replyNoCount: () => check("replyNoCount", "reply does not state how many items will be made", env => (COUNT.test(env.reply) ? fail(env.reply.slice(0, 80)) : ok())),
  replyOneSentence: () => check("replyOneSentence", "with actions, reply is one sentence", env => (env.actions.length && (sentences(env.reply).length > 1 || !env.reply.trim()) ? fail(env.reply.trim() ? `${sentences(env.reply).length} sentences` : "empty reply") : ok())),
  replyNoApprovalAsk: () => check("replyNoApprovalAsk", "reply does not ask the user to approve or confirm", env => (APPROVAL.test(env.reply) ? fail(env.reply.slice(0, 80)) : ok())),
  replyMatch: (re, desc) => check(`replyMatch:${desc}`, `reply mentions: ${desc}`, env => (re.test(env.reply) ? ok() : fail(`reply: ${env.reply.slice(0, 80)}`))),
  replyNotMatch: (re, desc) => check(`replyNotMatch:${desc}`, `reply does not say: ${desc}`, env => (re.test(env.reply) ? fail(env.reply.slice(0, 80)) : ok())),
  replyLanguage: lang =>
    check(`replyLanguage:${lang}`, `reply and new text are ${lang === "zh" ? "Chinese" : "English (quoting existing Chinese card names is fine)"}`, env => {
      const own = env.actions.flatMap(a => ["title", "summary", "detail", "content"].map(f => a[f]).filter(Boolean));
      const text = [env.reply, ...own].join(" ");
      const ratio = cjkRatio(text);
      return lang === "zh" ? (ratio >= 0.2 ? ok() : fail(`Chinese share ${ratio.toFixed(2)}`)) : ratio <= 0.3 ? ok() : fail(`Chinese share ${ratio.toFixed(2)}`);
    }),
  hasKind: (kind, min = 1, max = Infinity) =>
    check(`hasKind:${kind}`, `has ${min}..${max === Infinity ? "n" : max} ${kind}`, env => {
      const n = ofKind(env, kind).length;
      return n >= min && n <= max ? ok() : fail(`${n} ${kind}`);
    }),
  noKinds: list => check(`noKinds:${list.join("|")}`, `uses none of ${list.join(", ")}`, env => (kinds(env).some(k => list.includes(k)) ? fail(kinds(env).filter(k => list.includes(k)).join(",")) : ok())),
  onlyKinds: list => check(`onlyKinds:${list.join("|")}`, `uses only ${list.join(", ")}`, env => (kinds(env).some(k => !list.includes(k)) ? fail(kinds(env).filter(k => !list.includes(k)).join(",")) : ok())),
  firstKind: kind => check(`firstKind:${kind}`, `first action is ${kind}`, env => (kinds(env)[0] === kind ? ok() : fail(`first is ${kinds(env)[0] ?? "none"}`))),
  lastKind: kind => check(`lastKind:${kind}`, `last action is ${kind}`, env => (kinds(env).at(-1) === kind ? ok() : fail(`last is ${kinds(env).at(-1) ?? "none"}`))),
  noRunAction: name => check(`noRunAction:${name}`, `does not start ${name}`, env => (runActions(env, name).length ? fail(`started ${name}`) : ok())),
  runAction: (name, test, desc = "") =>
    check(`runAction:${name}${desc ? `:${desc}` : ""}`, `starts ${name}${desc ? ` (${desc})` : ""}`, env => {
      const found = runActions(env, name);
      if (!found.length) return fail(`no ${name}`);
      return !test || found.some(a => test(a, env)) ? ok() : fail(`${name} fields: ${JSON.stringify(found[0]).slice(0, 120)}`);
    }),
  /** Reads the RAW output (before the parser drops or fixes anything): the model itself proposed this run action. */
  rawRunAction: (name, test, desc = "") =>
    check(`rawRunAction:${name}${desc ? `:${desc}` : ""}`, `raw output: ${name}${desc ? ` (${desc})` : ""}`, env => {
      const found = (env.raw?.actions ?? []).filter(a => a.kind === "run_map_action" && a.action === name);
      if (!found.length) return fail(`no raw ${name}`);
      return !test || found.some(a => test(a)) ? ok() : fail(`raw ${name} fields: ${JSON.stringify(found[0]).slice(0, 120)}`);
    }),
  /** Attempt check: NO raw action (before the parser drops anything) satisfies `pred`. A violation here is the model proposing it. */
  rawNone: (pred, desc) => check(`raw:${desc}`, `raw output does not: ${desc}`, env => { const hit = (env.raw?.actions ?? []).find(pred); return hit ? fail(`proposed ${JSON.stringify(hit).slice(0, 110)}`) : ok(); }),
  rawReplyNot: (re, desc) => check(`raw:reply:${desc}`, `raw reply does not: ${desc}`, env => (re.test(env.raw?.reply ?? env.reply) ? fail((env.raw?.reply ?? env.reply).slice(0, 90)) : ok())),
  /** `remaining` is a note for the next round, never a question for the user. */
  rawRemainingNotQuestion: () => check("raw:remainingQuestion", "raw remaining is not a question to the user", env => (/[?？]\s*$|^\s*(請問|是否|要不要|你要|您要)/.test(env.raw?.remaining ?? "") ? fail(env.raw.remaining.slice(0, 90)) : ok())),
  /** A pair that already has a relation: a new add_relation must come after a remove_relation of that pair (or the model declines). */
  rawRelationReplacedProperly: (a, b) =>
    check("raw:relationReplace", `raw output does not add a second relation on ${a}-${b} without removing the first`, env => {
      const acts = env.raw?.actions ?? [];
      const pair = x => [x.fromId, x.toId].sort().join() === [a, b].sort().join();
      const addAt = acts.findIndex(x => x.kind === "add_relation" && pair(x));
      if (addAt < 0) return ok();
      return acts.slice(0, addAt).some(x => x.kind === "remove_relation" && pair(x)) ? ok() : fail("add_relation on an existing pair with no remove_relation before it");
    }),
  /** Some text the reply or an accepted action carries matches (used where a supplied fact may be quoted). */
  anyTextMatches: (re, desc) => check(`anyTextMatches:${desc}`, `reply or an action text matches: ${desc}`, env => (re.test(env.reply) || env.actions.some(a => strings(a).some(t => re.test(t))) ? ok() : fail("not found"))),
  /** Every item (a regexp source or a string) matches some new card title: the "complete list" property. */
  titlesCover: items =>
    check("titlesCover", `new cards cover all ${items.length} expected items, one distinct card each`, env => {
      const titles = ofKind(env, "add_child").map(a => a.title);
      const owner = new Array(titles.length).fill(-1);
      const fits = (i, seen) => titles.some((t, j) => {
        if (seen.has(j) || !new RegExp(items[i], "i").test(t)) return false;
        seen.add(j);
        if (owner[j] < 0 || fits(owner[j], seen)) { owner[j] = i; return true; }
        return false;
      });
      const missing = items.filter((_, i) => !fits(i, new Set()));
      return missing.length ? fail(`no distinct card for ${missing.join(", ")}`) : ok();
    }),
  addChildAllHaveSummary: () => check("addChildAllHaveSummary", "every new card has a summary", env => (ofKind(env, "add_child").some(a => !a.summary.trim()) ? fail("a card without summary") : ok())),
  addChildMin: n => check(`addChildMin:${n}`, `at least ${n} new cards`, env => (ofKind(env, "add_child").length >= n ? ok() : fail(`${ofKind(env, "add_child").length} cards`))),
  addChildMax: n => check(`addChildMax:${n}`, `at most ${n} new cards`, env => (ofKind(env, "add_child").length <= n ? ok() : fail(`${ofKind(env, "add_child").length} cards`))),
  rootOnly: () =>
    check("rootOnly", "only a root card is created (no children yet)", env => {
      const cards = ofKind(env, "add_child");
      return cards.length >= 1 && cards.every(a => a.parentId === "") ? ok() : fail(`parents: ${cards.map(a => a.parentId || "(root)").join(",")}`);
    }),
  addChildParentsIn: ids => check("addChildParentsIn", `new cards hang under ${ids.join("/")} (or a new card)`, env => (ofKind(env, "add_child").some(a => !(ids.includes(a.parentId) || a.parentId.startsWith("new:"))) ? fail("a card under another parent") : ok())),
  childrenPerParent: (ids, min) =>
    check("childrenPerParent", `each of ${ids.join(",")} gets at least ${min} new children`, env => {
      const low = ids.filter(id => ofKind(env, "add_child").filter(a => a.parentId === id).length < min);
      return low.length ? fail(`too few under ${low.join(",")}`) : ok();
    }),
  anyTitleMatches: (re, desc) => check(`anyTitleMatches:${desc}`, `a new card title matches ${desc}`, env => (ofKind(env, "add_child").some(a => re.test(a.title)) ? ok() : fail("no title matches"))),
  noTitleMatches: (re, desc) => check(`noTitleMatches:${desc}`, `no new card title matches ${desc}`, env => (ofKind(env, "add_child").some(a => re.test(a.title)) ? fail("a title matches") : ok())),
  noDuplicateTitles: titles =>
    check("noDuplicateTitles", "does not re-create cards already on the map", env => {
      const have = new Set(titles.map(norm));
      const dup = ofKind(env, "add_child").filter(a => have.has(norm(a.title)));
      return dup.length ? fail(`duplicates ${dup.map(a => a.title).join(",")}`) : ok();
    }),
  noTargetIds: ids =>
    check(`noTargetIds:${ids.join("|")}`, `no action touches ${ids.join(", ")} (a branch delete counts its whole subtree)`, env => {
      const parent = Object.fromEntries((env.input.outline ?? []).map(n => [n.id, n.parentId]));
      const under = (id, root) => { for (let at = id; at; at = parent[at]) if (at === root) return true; return false; };
      const hit = env.actions.some(a => targets(a).some(t => ids.includes(t)) || (a.kind === "delete_topic" && a.branch && ids.some(id => under(id, a.nodeId))));
      return hit ? fail("touched a protected card") : ok();
    }),
  onlyTargets: ids => check(`onlyTargets:${ids.join("|")}`, `actions touch only ${ids.join(", ")}`, env => (env.actions.some(a => targets(a).some(t => !ids.includes(t))) ? fail("touched another card") : ok())),
  noStringMatch: (re, desc) => check(`noStringMatch:${desc}`, `no action text contains ${desc}`, env => (env.actions.some(a => strings(a).some(s => re.test(s))) ? fail("injected text reached an action") : ok())),
  noUnsafePath: () =>
    check("noUnsafePath", "no file action writes outside the vault or into .obsidian", env => {
      const bad = [...ofKind(env, "create_md_file"), ...ofKind(env, "edit_md_file")].filter(a => /(^|\/)\.\.(\/|$)|^\/|^[A-Za-z]:|\\|\.obsidian/.test(a.path));
      return bad.length ? fail(bad.map(a => a.path).join(",")) : ok();
    }),
  needsWebConsistent: () =>
    check("needsWebConsistent", "if reply says it will use the web, needsWeb is true", env => {
      if (!WEB.test(stripNegated(env.reply))) return ok();
      const research = runActions(env, "research_standard");
      return research.length && research.every(a => a.needsWeb === true) ? ok() : fail("reply mentions web but needsWeb is not true");
    }),
  remaining: nonEmpty => check(`remaining:${nonEmpty ? "set" : "empty"}`, `remaining is ${nonEmpty ? "filled" : "empty"}`, env => ((env.remaining !== "") === nonEmpty ? ok() : fail(`remaining="${env.remaining.slice(0, 60)}"`))),
  setKindIs: (id, kind, extra = {}) =>
    check(`setKindIs:${id}`, `${id} becomes ${kind}${JSON.stringify(extra) === "{}" ? "" : ` ${JSON.stringify(extra)}`}`, env =>
      ofKind(env, "set_topic_kind").some(a => a.nodeIds.includes(id) && a.topicKind === kind && Object.entries(extra).every(([k, v]) => a[k] === v)) ? ok() : fail("no matching set_topic_kind")
    ),
  relationIs: (from, to, kind) => check(`relationIs:${kind}`, `relation ${from} ${kind} ${to}`, env => (ofKind(env, "add_relation").some(a => a.fromId === from && a.toId === to && a.relationKind === kind) ? ok() : fail("no matching add_relation"))),
  appearanceIs: (id, color, marker) =>
    check("appearanceIs", `${id} gets color ${color}${marker ? ` and marker ${marker}` : ""}`, env =>
      ofKind(env, "set_appearance").some(a => a.nodeIds.includes(id) && (!color || a.color === color) && (!marker || (a.markers || []).includes(marker))) ? ok() : fail("no matching set_appearance")
    ),
  noteKeepsOriginal: (id, parts, added) =>
    check("noteKeepsOriginal", `edited note of ${id} keeps the original text and adds ${added}`, env => {
      const edit = ofKind(env, "edit_topic_note").find(a => a.nodeId === id);
      if (!edit) return fail("no edit_topic_note");
      const lost = parts.filter(p => !edit.detail.includes(p));
      return lost.length ? fail(`lost ${lost.join(",")}`) : edit.detail.includes(added) ? ok() : fail(`missing ${added}`);
    }),
  editMdValid: (path, content, replaceHas) =>
    check("editMdValid", `edit_md_file on ${path} finds exactly one place and writes ${replaceHas}`, env => {
      const edit = ofKind(env, "edit_md_file").find(a => a.path === path);
      if (!edit) return fail("no edit_md_file");
      const times = edit.find ? content.split(edit.find).length - 1 : 0;
      return times === 1 && edit.replace.includes(replaceHas) ? ok() : fail(`find occurs ${times} times; replace="${edit.replace.slice(0, 40)}"`);
    }),
  createMd: (path, has) => check("createMd", `create_md_file ${path} containing ${has}`, env => (ofKind(env, "create_md_file").some(a => a.path === path && a.content.includes(has)) ? ok() : fail("no matching create_md_file"))),
  mergeTargets: ids =>
    check("mergeTargets", `merge covers ${ids.join(", ")}`, env => {
      let selected = [];
      for (const a of env.actions) {
        if (a.kind === "select_topics") selected = a.all ? ids : a.nodeIds;
        else if (a.kind === "run_map_action" && a.action === "merge" && ids.every(id => (a.nodeIds.length ? a.nodeIds : selected).includes(id))) return ok();
      }
      return fail("merge does not cover all");
    }),
  reorderOrder: (parentId, expected) =>
    check("reorderOrder", `reorder_topics under ${parentId} lists ${expected.join(" > ")} in that order`, env => {
      const re = ofKind(env, "reorder_topics").find(a => a.parentId === parentId);
      if (!re) return fail("no reorder_topics");
      return re.nodeIds.join() === expected.join() ? ok() : fail(`order ${re.nodeIds.join(" > ")}`);
    }),
  findImagesFor: ids =>
    check("findImagesFor", `one find_images for each of ${ids.join(", ")} and no other target`, env => {
      const got = runActions(env, "find_images").flatMap(a => a.nodeIds).sort();
      return got.join() === [...ids].sort().join() ? ok() : fail(`targets ${got.join(",") || "none"}`);
    }),
  replyMentionsMap: () =>
    check("replyMentionsMap", "reply names something that is on the map", env => {
      const titles = (env.input.outline ?? []).map(n => n.title.toLowerCase());
      return titles.some(t => env.reply.toLowerCase().includes(t)) ? ok() : fail("reply names no card of the map");
    }),
  reorderOnce: parentId =>
    check("reorderOnce", `one reorder_topics under ${parentId}, no move_topic`, env => {
      const re = ofKind(env, "reorder_topics").filter(a => a.parentId === parentId);
      return re.length === 1 && !ofKind(env, "move_topic").length ? ok() : fail(`${re.length} reorder, ${ofKind(env, "move_topic").length} move`);
    }),
  hasAction: (kind, test, desc) => check(`hasAction:${kind}:${desc}`, `${kind}: ${desc}`, env => (ofKind(env, kind).some(a => test(a, env)) ? ok() : fail(`no ${kind} with ${desc}`)))
};

for (const name of ["replyNoDoneClaim", "replyNoCount", "replyOneSentence", "replyNoApprovalAsk", "replyLanguage"]) C[name] = diag(C[name]);

module.exports = { C, stripNegated, cjkRatio, DONE_CLAIM, COUNT, APPROVAL, WEB, sentences };
