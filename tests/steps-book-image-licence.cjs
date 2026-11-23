// Image licence status (book any-site images P1): deterministic open / restricted / unknown.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const { licenceStatus } = support.load('core/book-pipeline/image-licence.ts');

const COMMONS = 'https://commons.wikimedia.org/wiki/File:Mona_Lisa.jpg';
const BLOG = 'https://example.com/post';
const cases = [
  ['Commons file page, no licence text', COMMONS, undefined, 'open'],
  ['CC BY 4.0', BLOG, 'CC BY 4.0', 'open'],
  ['CC BY-SA 3.0', BLOG, 'CC BY-SA 3.0', 'open'],
  ['CC0', BLOG, 'CC0 1.0', 'open'],
  ['Public domain', BLOG, 'Public domain', 'open'],
  ['PD', BLOG, 'PD', 'open'],
  ['CC BY-NC 2.0', BLOG, 'CC BY-NC 2.0', 'restricted'],
  ['CC BY-NC-SA beats open', COMMONS, 'CC BY-NC-SA 4.0', 'restricted'],
  ['CC BY-NC-ND', BLOG, 'CC BY-NC-ND 4.0', 'restricted'],
  ['CC BY-ND', BLOG, 'CC BY-ND 4.0', 'restricted'],
  ['copyright sign', BLOG, '© 2020 Someone', 'restricted'],
  ['All rights reserved', BLOG, 'All rights reserved', 'restricted'],
  ['empty licence', BLOG, '', 'unknown'],
  ['missing licence', BLOG, undefined, 'unknown'],
  ['en.wikipedia local file page', 'https://en.wikipedia.org/wiki/File:Foo.jpg', undefined, 'unknown'],
  ['unrecognised licence text', BLOG, 'Standard licence', 'unknown']
];
for (const [name, source, license, expected] of cases) test(`licenceStatus: ${name}`, () => assert.equal(licenceStatus({ source, license }), expected));
