// P3 (44): OPML and FreeMind conversion. The file is untrusted, so each counter-example is refused whole with a
// reason (never truncated, never fetched, never expanded) and nothing throws.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian } = require('./support.cjs');
const mod = load('experiences/visual-map/outline-exchange.ts', { obsidian });
// The module runs in its own vm realm, so results are copied into this realm before deepEqual compares them.
const plain = value => JSON.parse(JSON.stringify(value));
const parse = (text, options) => plain(mod.parseOutlineExchange(text, options));
const ok = (text, options) => { const r = parse(text, options); assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const bad = (text, options) => { const r = parse(text, options); assert.equal(r.ok, false, JSON.stringify(r).slice(0, 200)); return r; };
const shape = r => r.nodes.map(n => [n.title, n.parent, n.level]);

const opml = (body, head = '') => `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head>${head}</head><body>${body}</body></opml>`;
const mm = body => `<?xml version="1.0" encoding="UTF-8"?>\n<map version="1.0.1">${body}</map>`;
const chain = (n, open, close, text) => Array.from({ length: n }, (_, i) => open(`n${i}`)).join('') + Array.from({ length: n }, () => close).join('');
const opmlChain = n => opml(chain(n, t => `<outline text="${t}">`, '</outline>'));
const mmChain = n => mm(chain(n, t => `<node TEXT="${t}">`, '</node>'));

test('OPML: nesting, _note, line numbers, other elements dropped', () => {
  const r = ok(opml('<outline text="Root" _note="line1&#10;line2" type="rss" xmlUrl="http://x"><outline text="Child"/>\n<outline text="Child 2"><outline text="Leaf"/></outline></outline><junk><outline text="Not in body path"/></junk>'));
  assert.equal(r.format, 'opml'); assert.equal(r.synthesizedRoot, false);
  assert.deepEqual(shape(r), [['Root', null, 0], ['Child', 0, 1], ['Child 2', 0, 1], ['Leaf', 2, 2]]);
  assert.equal(r.nodes[0].body, 'line1\nline2'); assert.equal(r.nodes[1].body, '');
  assert.deepEqual(r.nodes.map(n => n.index), [0, 1, 2, 3]);
  assert.equal(r.nodes[2].line, 3);
  assert.deepEqual(Object.keys(r.nodes[0]).sort(), ['body', 'index', 'level', 'line', 'parent', 'title']);
});
test('FreeMind: TEXT, NOTE and NODE richcontent, other elements dropped', () => {
  const r = ok(mm(`<node ID="1" TEXT="Root"><icon BUILTIN="x"/><attribute NAME="a" VALUE="b"/><hook NAME="h"><text>no</text></hook>
    <richcontent TYPE="NOTE"><html><head><title>t</title></head><body><p>one</p><p>two<br/>three</p><ul><li>a</li><li>b</li></ul></body></html></richcontent>
    <node><richcontent TYPE="NODE"><html><body><p>Rich   title</p><p>second</p></body></html></richcontent></node></node>`));
  assert.equal(r.format, 'freemind');
  assert.deepEqual(shape(r), [['Root', null, 0], ['Rich title second', 0, 1]]);
  assert.equal(r.nodes[0].body, 'one\ntwo\nthree\na\nb');
});
test('billion laughs and a SYSTEM DOCTYPE are refused', () => {
  const laughs = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><opml><body><outline text="&lol2;"/></body></opml>';
  assert.equal(bad(laughs).reason, 'forbidden-doctype');
  const xxe = '<?xml version="1.0"?>\n<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><opml><body><outline text="&xxe;"/></body></opml>';
  assert.deepEqual(bad(xxe), { ok: false, reason: 'forbidden-doctype', line: 2 });
  assert.equal(bad(opml('<outline text="a"/>').replace('<opml', '<!DOCTYPE opml SYSTEM "http://evil/x.dtd"><opml')).reason, 'forbidden-doctype');
  assert.equal(bad(opml('<outline text="a"/>').replace('<body>', '<!ENTITY x "y"><body>')).reason, 'forbidden-doctype');
  assert.equal(bad(opml('<outline text="a"/>').replace('<opml', '<!doctype opml><opml')).reason, 'forbidden-doctype');
});
test('processing instructions other than the leading xml declaration are refused', () => {
  assert.equal(bad(opml('<outline text="a"/>').replace('<opml', '<?xml-stylesheet href="x"?><opml')).reason, 'forbidden-pi');
  assert.equal(bad(opml('<outline text="a"><?php echo 1 ?></outline>')).reason, 'forbidden-pi');
  assert.equal(bad(opml('<outline text="a"/>') + '<?x?>').reason, 'forbidden-pi');
  ok('<opml><body><outline text="a"/></body></opml>');
  ok('\uFEFF  <?xml version="1.0"?><opml><body><outline text="a"/></body></opml>');
});
test('5 MB is accepted, one byte more is refused before parsing; size counts UTF-8 bytes', () => {
  const MAX = 5 * 1024 * 1024;
  const head = '<opml><body><outline text="a" _note="', tail = '"/></body></opml>';
  const fill = 'x'.repeat(MAX - head.length - tail.length);
  const exact = head + fill + tail;
  assert.equal(exact.length, MAX);
  // The note is over the body limit, which proves the 5 MB check let it through.
  assert.equal(bad(exact).reason, 'body-too-long');
  assert.deepEqual(bad(exact + ' '), { ok: false, reason: 'too-large' });
  assert.equal(bad('\u4e2d'.repeat(1800000)).reason, 'too-large');
  assert.equal(bad('x'.repeat(MAX + 1) + '\u0001').reason, 'too-large');
});
test('500 nodes are accepted, 501 refused; the node count cannot be dodged by nesting', () => {
  const flat = n => opml(Array.from({ length: n }, (_, i) => `<outline text="t${i}"/>`).join(''));
  const r = ok(flat(500));
  assert.equal(r.nodes.length, 501); assert.equal(r.synthesizedRoot, true);
  assert.equal(bad(flat(501)).reason, 'too-many-nodes');
  const one = `<outline text="r">${Array.from({ length: 499 }, (_, i) => `<outline text="t${i}"/>`).join('')}</outline>`;
  assert.equal(ok(opml(one)).nodes.length, 500);
  assert.equal(bad(opml(one.replace('</outline>', '<outline text="x"/></outline>'))).reason, 'too-many-nodes');
  assert.equal(bad(mm(`<node TEXT="r">${Array.from({ length: 500 }, (_, i) => `<node TEXT="t${i}"/>`).join('')}</node>`)).reason, 'too-many-nodes');
});
test('depth 64 is accepted, 65 refused, in both formats', () => {
  assert.equal(ok(opmlChain(64)).nodes.length, 64);
  assert.equal(bad(opmlChain(65)).reason, 'too-deep');
  assert.equal(ok(mmChain(64)).nodes.length, 64);
  assert.equal(bad(mmChain(65)).reason, 'too-deep');
  // 300 levels of unrelated markup is refused by the tokenizer, without recursion.
  assert.equal(bad(opml(chain(300, () => '<x>', '</x>'))).reason, 'too-deep');
});
test('malformed XML is refused, never thrown', () => {
  const cases = ['', '   ', 'plain text', '<opml>', '<opml><body></opml>', '<opml></body>', '<opml/><opml/>', 'x<opml/>', '<opml/>x',
    '<opml a=b/>', '<opml a="1" a="2"/>', '<opml a="<"/>', '<opml a="1"b="2"/>', '<opml a/>', '<opml', '<opml a="1', '<1a/>', '<opml><!-- x</opml>',
    '<opml><![CDATA[x</opml>', '<opml>]]></opml>', '<opml>&nope;</opml>', '<opml>&nbsp;</opml>', '<opml>a & b</opml>', '<opml>&#xZZ;</opml>', '<opml>&amp</opml>', '</opml>'];
  for (const text of cases) { const r = bad(text); assert.ok(['bad-xml', 'bad-entity', 'not-outline', 'empty'].includes(r.reason), `${JSON.stringify(text)} -> ${r.reason}`); }
  for (const v of [undefined, null, 5, {}, []]) assert.deepEqual(bad(v), { ok: false, reason: 'not-text' });
});
test('entities: the five predefined and numeric ones work, anything else is refused', () => {
  const r = ok(opml('<outline text="&lt;&gt;&amp;&quot;&apos; &#65;&#x42;&#x1F600;"/>'));
  assert.equal(r.nodes[0].title, '<>&"\' AB\u{1F600}');
  for (const e of ['&#0;', '&#1;', '&#8;', '&#11;', '&#x1F;', '&#xD800;', '&#xFFFE;', '&#x110000;', '&#99999999;', '&Amp;', '&#X41;']) assert.equal(bad(opml(`<outline text="a${e}"/>`)).reason, 'bad-entity', e);
});
test('raw control characters are refused, tab, LF and CR are allowed', () => {
  for (const c of ['\u0000', '\u0001', '\u0008', '\u000b', '\u000c', '\u001f', '\uFFFE']) assert.equal(bad(opml(`<outline text="a${c}b"/>`)).reason, 'control-char', JSON.stringify(c));
  assert.equal(bad(opml('<outline text="a"/>') + '\u0000').reason, 'control-char');
  assert.equal(ok(opml('<outline text="a\tb\nc\r\nd"/>')).nodes[0].title, 'a b c d');
});
test('CDATA is text', () => {
  const r = ok(mm('<node TEXT="r"><richcontent TYPE="NOTE"><html><body><p><![CDATA[<b>x</b> & y]]></p></body></html></richcontent></node>'));
  assert.equal(r.nodes[0].body, '<b>x</b> & y');
  assert.equal(bad('<![CDATA[x]]>' + opml('<outline text="a"/>')).reason, 'bad-xml');
});
test('richcontent: script and img onerror leave only text, no markup or attributes survive', () => {
  const r = ok(mm(`<node TEXT="r"><richcontent TYPE="NOTE"><html><head><script>head()</script></head><body>
    <p>safe</p><script>alert(1)</script><style>p{x:y}</style><img src="x" onerror="alert(2)"/><p onclick="z()">after<a href="javascript:evil()">link</a></p>
    <iframe src="http://evil"><p>inner</p></iframe></body></html></richcontent></node>`));
  const body = r.nodes[0].body;
  assert.equal(body, 'safe\nafterlink\ninner');
  for (const frag of ['alert', '<', 'onerror', 'onclick', 'javascript', 'script', 'style', 'head()']) assert.equal(body.includes(frag), false, frag);
});
test('several top-level nodes get one root: head title, else file name, else a fixed name', () => {
  const tops = '<outline text="A"><outline text="A1"/></outline><outline text="B"/>';
  const a = ok(opml(tops, '<title>My map</title>'), { fileName: 'ignored.opml' });
  assert.equal(a.synthesizedRoot, true);
  assert.deepEqual(shape(a), [['My map', null, 0], ['A', 0, 1], ['A1', 1, 2], ['B', 0, 1]]);
  assert.deepEqual(shape(ok(opml(tops), { fileName: 'Folder/Trip plan.opml' })).at(0), ['Trip plan', null, 0]);
  assert.deepEqual(shape(ok(mm('<node TEXT="A"/><node TEXT="B"/>'), { fileName: 'C:\\x\\Plan.mm' })).at(0), ['Plan', null, 0]);
  assert.equal(ok(opml(tops)).nodes[0].title, 'Imported outline');
  assert.equal(ok(opml(tops, '<title>a [[ b</title>'), { fileName: 'x.opml' }).nodes[0].title, 'x');
  assert.equal(ok(opml('<outline text="Only"/>', '<title>Ignored</title>')).nodes[0].title, 'Only');
});
test('titles: 200 code points ok, 201 refused, empty, brackets and fence refused with the line', () => {
  assert.equal(ok(opml(`<outline text="${'x'.repeat(200)}"/>`)).nodes.length, 1);
  assert.equal(ok(opml(`<outline text="${'\u{1F600}'.repeat(200)}"/>`)).nodes.length, 1);
  assert.deepEqual(bad(opml(`<outline text="a"/>\n<outline text="${'x'.repeat(201)}"/>`)), { ok: false, reason: 'title-too-long', line: 3 });
  assert.equal(bad(opml(`<outline text="${'\u{1F600}'.repeat(201)}"/>`)).reason, 'title-too-long');
  assert.equal(bad(opml('<outline text="   "/>')).reason, 'empty-title');
  assert.equal(bad(opml('<outline/>')).reason, 'empty-title');
  assert.equal(bad(opml('<outline text="a [[b"/>')).reason, 'title-brackets');
  assert.equal(bad(opml('<outline text="a ``` b"/>')).reason, 'title-fence');
  assert.equal(bad(mm('<node TEXT="ok"><node TEXT="a ]] b"/></node>')).reason, 'title-brackets');
  assert.equal(bad(opml('<outline text="a&#x85;b"/>')).reason, 'bad-title');
  assert.equal(ok(opml('<outline text="a/b #tag"/>')).nodes[0].title, 'a/b #tag');
});
test('notes: a Visual Agent Map marker, leading front matter, or an oversized note is refused', () => {
  assert.equal(bad(opml('<outline text="a" _note="x&#10;&lt;!-- visual-agent-map:detail:start --&gt;"/>')).reason, 'bad-body');
  assert.equal(bad(opml('<outline text="a" _note="---&#10;k: v&#10;---"/>')).reason, 'bad-body');
  assert.equal(bad(opml(`<outline text="a" _note="${'x'.repeat(200001)}"/>`)).reason, 'body-too-long');
  assert.equal(ok(opml(`<outline text="a" _note="${'x'.repeat(200000)}"/>`)).nodes[0].body.length, 200000);
  assert.equal(ok(opml('<outline text="a" _note="a --- b"/>')).nodes[0].body, 'a --- b');
});
test('wrong or empty documents', () => {
  assert.equal(bad('<html><body><p>x</p></body></html>').reason, 'not-outline');
  assert.equal(bad('<svg onload="x()"/>').reason, 'not-outline');
  assert.equal(bad('<opml><body></body></opml>').reason, 'empty');
  assert.equal(bad('<map version="1.0.1"/>').reason, 'empty');
  assert.equal(bad('<opml><head/></opml>').reason, 'empty');
});
test('hostile attribute and element names do not pollute prototypes or reach the result', () => {
  const hostile = opml('<outline text="a" __proto__="x" constructor="y" prototype="z"><__proto__ text="no"/><constructor/></outline><outline text="b" toString="x"/>');
  const raw = mod.parseOutlineExchange(hostile);
  assert.equal(raw.ok, true); assert.equal(raw.nodes.length, 3);
  for (const o of [raw, ...raw.nodes]) {
    const proto = Object.getPrototypeOf(o);
    for (const key of ['x', 'y', 'z', 'text']) assert.equal(Object.hasOwn(proto, key), false, key);
  }
  assert.equal({}.x, undefined);
  assert.deepEqual(Object.keys(raw.nodes[1]).sort(), ['body', 'index', 'level', 'line', 'parent', 'title']);
  assert.deepEqual(plain(raw.nodes.map(n => n.title)), ['Imported outline', 'a', 'b']);
});

const map = { title: 'Trip "plan"', nodes: [{ id: 'r', parentId: null }, { id: 'a', parentId: 'r' }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'r' }] };
const notes = new Map([['r', { title: '"<&>', body: 'root & <note>\nsecond line\n\nafter blank' }], ['a', { title: "it's 'q' \"dq\" \u4e2d\u6587 \u{1F600}", body: '' }], ['b', { title: 'a&amp;b &lt;', body: 'x' }], ['c', { title: 'tab\there', body: '' }]]);
const titles = r => r.nodes.map(n => n.title);
const expectedTitles = ['"<&>', "it's 'q' \"dq\" \u4e2d\u6587 \u{1F600}", 'a&amp;b &lt;', 'tab here'];

test('toOpml: OPML 2.0 shape, everything escaped, well formed', () => {
  const text = mod.toOpml(map, notes);
  assert.ok(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">'));
  assert.ok(text.includes('<title>Trip "plan"</title>'));
  assert.ok(text.includes('text="&quot;&lt;&amp;&gt;"'));
  assert.ok(text.includes('_note="root &amp; &lt;note&gt;&#10;second line&#10;&#10;after blank"'));
  assert.equal(text.includes('relation'), false);
  assert.equal(parse(text).ok, true);
});
test('OPML round trip: titles with quote, less-than, ampersand and greater-than come back identical, and so do notes', () => {
  const r = ok(mod.toOpml(map, notes));
  assert.deepEqual(titles(r), expectedTitles);
  assert.deepEqual(r.nodes.map(n => n.parent), [null, 0, 1, 0]);
  assert.equal(r.nodes[0].body, 'root & <note>\nsecond line\n\nafter blank');
  assert.equal(r.nodes[2].body, 'x');
});
test('toFreeMind: 1.0.1 shape and round trip of titles and notes', () => {
  const text = mod.toFreeMind(map, notes);
  assert.ok(text.includes('<map version="1.0.1">'));
  assert.ok(text.includes('TEXT="&quot;&lt;&amp;&gt;"'));
  assert.equal(text.includes('<script'), false);
  const r = ok(text);
  assert.equal(r.format, 'freemind');
  assert.deepEqual(titles(r), expectedTitles);
  assert.deepEqual(r.nodes.map(n => n.parent), [null, 0, 1, 0]);
  assert.equal(r.nodes[0].body, 'root & <note>\nsecond line\n\nafter blank');
  assert.equal(r.nodes[2].body, 'x');
});
test('several roots: OPML keeps them and re-imports under the map title; FreeMind wraps them in one root', () => {
  const two = { title: 'Two roots', nodes: [{ id: 'x', parentId: null }, { id: 'y', parentId: null }, { id: 'z', parentId: 'x' }] };
  const n = new Map([['x', { title: 'X', body: '' }], ['y', { title: 'Y', body: '' }], ['z', { title: 'Z', body: '' }]]);
  const o = ok(mod.toOpml(two, n));
  assert.deepEqual(shape(o), [['Two roots', null, 0], ['X', 0, 1], ['Z', 1, 2], ['Y', 0, 1]]);
  const f = ok(mod.toFreeMind(two, n));
  assert.deepEqual(shape(f), [['Two roots', null, 0], ['X', 0, 1], ['Z', 1, 2], ['Y', 0, 1]]);
  assert.equal(plain(mod.parseOutlineExchange(mod.toFreeMind(two, n))).synthesizedRoot, false);
});
test('export never throws on odd maps: empty, orphan parent, parent loop, missing note; invalid characters are stripped', () => {
  assert.equal(parse(mod.toOpml({ title: 'E', nodes: [] }, new Map())).reason, 'empty');
  const odd = { title: 'T\u0000\ud800', nodes: [{ id: 'o', parentId: 'ghost' }, { id: 'l1', parentId: 'l2' }, { id: 'l2', parentId: 'l1' }, { id: 'self', parentId: 'self' }, { id: 'dup', parentId: null }, { id: 'dup', parentId: null }] };
  const n = new Map([['o', { title: 'Or\u0001ph\ud800an', body: 'b\u0000' }]]);
  for (const text of [mod.toOpml(odd, n), mod.toFreeMind(odd, n)]) {
    assert.equal(RAW.test(text), false);
    const r = ok(text);
    assert.ok(titles(r).includes('Orphan'));
  }
  assert.doesNotThrow(() => mod.toOpml(odd, new Map()));
});
const RAW = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff]/;
