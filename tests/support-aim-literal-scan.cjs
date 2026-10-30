// Shared by tests/steps-aim-literal-inventory.cjs (G2). Finds every string/template literal in experiences/aim/**/*.ts that
// contains a capitalized Latin word of 3+ letters, outside Error/throw/import and outside translate()/t() key arguments.
const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const CAPITALIZED_WORD = /(?:^|[^A-Za-z])[A-Z][a-z]{2,}/;
function walk(directory, extension) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full, extension) : full.endsWith(extension) ? [full] : [];
  }).sort();
}
function literalsOf(relativeDirectory) {
  const found = [];
  for (const file of walk(path.join(root, relativeDirectory), '.ts')) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = node => {
      let text = null;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
      else if (ts.isTemplateExpression(node)) text = node.head.text + node.templateSpans.map(span => `\${}${span.literal.text}`).join('');
      if (text !== null) {
        let skip = false;
        for (let up = node.parent; up; up = up.parent) {
          if (ts.isNewExpression(up) && /Error$/.test(up.expression.getText())) skip = true;
          if (ts.isThrowStatement(up) || ts.isImportDeclaration(up)) skip = true;
          if (ts.isCallExpression(up) && /^(translate|t|this\.t|this\.message)$/.test(up.expression.getText()) && up.arguments.some((argument, index) => index <= 1 && argument === node)) skip = true;
        }
        if (!skip && CAPITALIZED_WORD.test(text))
          found.push({ file: relative, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
      }
      if (ts.isTemplateExpression(node)) node.templateSpans.forEach(span => visit(span.expression));
      else ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}
const markdownFiles = relativeDirectory => walk(path.join(root, relativeDirectory), '.md').map(file => path.relative(root, file).split(path.sep).join('/'));
module.exports = { literalsOf, markdownFiles, root };
