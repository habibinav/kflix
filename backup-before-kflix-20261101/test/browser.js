// Static checks on the client bundle: every element the script looks up exists.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

test('every $(id) used by app.js exists in index.html', () => {
  const ids = [...js.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]);
  assert.ok(ids.length > 40);
  for (const id of new Set(ids)) assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
});

test('every icon referenced exists in the sprite', () => {
  const used = new Set([...(html + js).matchAll(/#i-([\w-]+)/g)].map(m => m[1]).filter(n => !n.includes('$')));
  for (const name of used) assert.ok(html.includes(`id="i-${name}"`), `missing icon ${name}`);
});
