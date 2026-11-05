// Persona 09: the response schema's field descriptions are part of what the model reads. A fixed Chinese wording
// ("完整的繁體中文 Markdown 分析") made a Standard research in an English interface come back in Chinese, so the
// descriptions must name the output language of the request. Traditional Chinese keeps its old wording byte for byte.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { promptsFor } = require('./support-replay.cjs');

const HAN = /\p{Script=Han}/u;
const base = { title: 'Topic T', summary: 'S', rules: '', detail: '', task: 'Do task X', ancestors: '', workingFindings: '', sourceContext: '', mode: 'task', researchMode: 'research', researchDepth: 'normal', visualMode: 'auto' };
const descriptions = schema => [schema.properties.summary.description, schema.properties.detail.description];

test('persona 09: a Standard research in English sends no Chinese in the response schema', async () => {
  const [call] = await promptsFor({ ...base, outputLanguage: 'en' }, { language: 'en' });
  for (const text of descriptions(call.schema)) {
    assert.doesNotMatch(text, HAN, text);
    assert.match(text, /English/);
  }
  assert.doesNotMatch(call.prompt, HAN);
});

test('persona 09: the schema follows the output language of the request, not the interface language', async () => {
  const [call] = await promptsFor({ ...base, outputLanguage: 'en' }, { language: 'zh-TW' });
  for (const text of descriptions(call.schema)) assert.doesNotMatch(text, HAN, text);
});

test('persona 09: a Standard research in a Chinese interface still asks for Chinese (zh-TW wording unchanged)', async () => {
  const [tw] = await promptsFor({ ...base, outputLanguage: 'zh-TW' }, { language: 'zh-TW' });
  assert.deepEqual(descriptions(tw.schema), ['適合心智圖的一句繁體中文結論，80 字內', '完整的繁體中文 Markdown 分析']);
});

test('persona 38: a Simplified Chinese run asks for Simplified Chinese in the schema, never Traditional', async () => {
  const [cn] = await promptsFor({ ...base, outputLanguage: 'zh-CN' }, { language: 'zh-CN' });
  assert.deepEqual(descriptions(cn.schema), ['适合思维导图的一句简体中文结论，80 字内', '完整的简体中文 Markdown 分析']);
  for (const text of descriptions(cn.schema)) assert.doesNotMatch(text, /繁體/);
});

test('persona 09: another output language is named in English in the schema', async () => {
  const [call] = await promptsFor({ ...base, outputLanguage: 'ja' }, { language: 'en' });
  for (const text of descriptions(call.schema)) assert.match(text, /Japanese/);
});
