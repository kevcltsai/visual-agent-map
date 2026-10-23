// A small HTML parser and serializer for the sharing tests: enough DOM (text nodes, elements, attributes, cloning,
// insertBefore/removeChild/replaceChild, ownerDocument.createTextNode/createElement) for the translation segments,
// and a serializer that follows innerHTML's escaping so a no-op round trip can be compared byte for byte.
// It parses the cleaned, well-formed HTML the share exporter produces (no tag soup, no implied end tags).
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
  if (name[0] === '#') return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
  return NAMED[name] ?? all;
});
const escapeText = text => text.replace(/&/g, '&amp;').replace(/ /g, '&nbsp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = text => text.replace(/&/g, '&amp;').replace(/ /g, '&nbsp;').replace(/"/g, '&quot;');

class Doc {
  createTextNode(text) { return new TextNode(text, this); }
  createElement(tag) { return new El(tag, this); }
}
class Base {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; }
  get nextSibling() { const list = this.parentNode?.childNodes ?? []; return list[list.indexOf(this) + 1] ?? null; }
}
class TextNode extends Base {
  constructor(text, doc) { super(doc); this.nodeType = 3; this.nodeValue = text; }
  get textContent() { return this.nodeValue; }
  cloneNode() { return new TextNode(this.nodeValue, this.ownerDocument); }
  remove() { this.parentNode?.removeChild(this); }
}
class CommentNode extends Base {
  constructor(text, doc) { super(doc); this.nodeType = 8; this.nodeValue = text; }
  cloneNode() { return new CommentNode(this.nodeValue, this.ownerDocument); }
  remove() { this.parentNode?.removeChild(this); }
}
class El extends Base {
  constructor(tag, doc) { super(doc); this.nodeType = 1; this.localName = tag; this.attrs = new Map(); this.childNodes = []; }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get textContent() { return this.childNodes.map(node => node.textContent ?? '').join(''); }
  getAttributeNames() { return [...this.attrs.keys()]; }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  appendChild(node) { node.parentNode?.removeChild(node); node.parentNode = this; this.childNodes.push(node); return node; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  insertBefore(node, reference) {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    const at = reference ? this.childNodes.indexOf(reference) : -1;
    if (at < 0) this.childNodes.push(node); else this.childNodes.splice(at, 0, node);
    return node;
  }
  removeChild(node) { const at = this.childNodes.indexOf(node); if (at >= 0) { this.childNodes.splice(at, 1); node.parentNode = null; } return node; }
  replaceChild(next, old) { this.insertBefore(next, old); this.removeChild(old); return old; }
  remove() { this.parentNode?.removeChild(this); }
  replaceWith(node) { this.parentNode?.replaceChild(node, this); }
  cloneNode(deep) {
    const copy = new El(this.localName, this.ownerDocument);
    for (const [name, value] of this.attrs) copy.attrs.set(name, value);
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
    return copy;
  }
  get innerHTML() { return this.childNodes.map(serializeNode).join(''); }
}

function serializeNode(node) {
  if (node.nodeType === 3) {
    const parent = node.parentNode;
    return parent && RAW_TEXT.has(parent.localName) ? node.nodeValue : escapeText(node.nodeValue);
  }
  if (node.nodeType === 8) return `<!--${node.nodeValue}-->`;
  const attrs = [...node.attrs].map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join('');
  if (VOID.has(node.localName)) return `<${node.localName}${attrs}>`;
  return `<${node.localName}${attrs}>${node.childNodes.map(serializeNode).join('')}</${node.localName}>`;
}

/** Parses an HTML fragment into a detached <div> container. */
function parse(html) {
  const doc = new Doc();
  const root = new El('div', doc);
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      top().appendChild(new CommentNode(html.slice(i + 4, end), doc));
      i = end + 3;
    } else if (html[i] === '<' && /[A-Za-z]/.test(html[i + 1] ?? '')) {
      const match = /^<([A-Za-z][A-Za-z0-9:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/.exec(html.slice(i));
      if (!match) throw new Error(`cannot parse tag at ${i}: ${html.slice(i, i + 40)}`);
      const el = new El(match[1], doc);
      for (const attr of match[2].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
        el.attrs.set(attr[1], decode(attr[2] ?? attr[3] ?? attr[4] ?? ''));
      top().appendChild(el);
      i += match[0].length;
      if (RAW_TEXT.has(el.localName)) {
        const end = html.indexOf(`</${el.localName}>`, i);
        if (end > i) el.appendChild(new TextNode(html.slice(i, end), doc));
        i = end + el.localName.length + 3;
      } else if (!VOID.has(el.localName) && !match[3]) stack.push(el);
    } else if (html.startsWith('</', i)) {
      const end = html.indexOf('>', i);
      const name = html.slice(i + 2, end).trim();
      if (top().localName !== name) throw new Error(`mismatched </${name}> inside <${top().localName}>`);
      stack.pop();
      i = end + 1;
    } else {
      let end = html.indexOf('<', i + 1);
      while (end >= 0 && !/[A-Za-z/!]/.test(html[end + 1] ?? '')) end = html.indexOf('<', end + 1);
      if (end < 0) end = html.length;
      top().appendChild(new TextNode(decode(html.slice(i, end)), doc));
      i = end;
    }
  }
  if (stack.length !== 1) throw new Error('unclosed element');
  return root;
}

const serialize = root => root.childNodes.map(serializeNode).join('');
/** The Obsidian-side DOM the translation service needs: parse, serialize, a no-op sanitizer, and spans. */
function makeDom({ sanitize } = {}) {
  return {
    parse,
    serialize,
    sanitize: root => sanitize?.(root),
    createSpan: () => new El('span', new Doc()),
    createDiv: () => new El('div', new Doc())
  };
}

module.exports = { parse, serialize, makeDom, El, TextNode };
