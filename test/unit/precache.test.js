// The service worker's precache list and cache version are generated (npm run precache).
// These tests fail when sw.js is stale, so a forgotten run is caught by npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, checkSw, listShippable, renderBlock, applyBlock } from '../../tools/build-precache.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('sw.js lists every shippable file and the current content hash (run `npm run precache` if this fails)', () => {
  const { ok, expected, actual } = checkSw(ROOT);
  if (!ok) {
    const want = buildManifest(ROOT);
    const have = /CACHE_VERSION = '([^']*)'/.exec(actual)?.[1];
    assert.fail(`sw.js is stale: it has version ${have}, the files hash to ${want.version} (${want.urls.length} URLs). Run: npm run precache`);
  }
  assert.equal(expected, actual);
});

test('the list covers the app: pages, manifest, icons, styles and every module', () => {
  const urls = buildManifest(ROOT).urls;
  for (const must of ['./', 'index.html', 'reader-test.html', 'manifest.webmanifest', 'css/app.css', 'css/reader-test.css', 'js/app.js']) {
    assert.ok(urls.includes(must), `missing ${must}`);
  }
  assert.ok(urls.some((u) => u.startsWith('icons/') && u.endsWith('.png')), 'icons are precached');
  assert.ok(urls.some((u) => u.startsWith('js/reader/')), 'reader modules are precached');
  assert.ok(urls.some((u) => u.startsWith('js/ui/')) && urls.some((u) => u.startsWith('js/core/')) && urls.some((u) => u.startsWith('js/store/')));
});

test('tests, docs, tools, dotfiles and the worker itself are not shipped', () => {
  const urls = buildManifest(ROOT).urls;
  assert.equal(urls.some((u) => /^(test|docs|tools|node_modules)\//.test(u)), false);
  for (const skip of ['sw.js', 'package.json', 'README.md', '.gitignore', '.nojekyll']) assert.equal(urls.includes(skip), false, skip);
});

test('every URL is relative and every listed file exists', () => {
  for (const u of buildManifest(ROOT).urls) {
    assert.ok(!u.startsWith('/') && !/^[a-z]+:/i.test(u), `not relative: ${u}`);
    if (u !== './') assert.ok(existsSync(join(ROOT, u)), `missing file ${u}`);
  }
});

test('every local file the pages and the manifest point to is precached', () => {
  const urls = new Set(buildManifest(ROOT).urls);
  const refs = [];
  for (const page of ['index.html', 'reader-test.html']) {
    const html = readFileSync(join(ROOT, page), 'utf8');
    for (const m of html.matchAll(/(?:href|src)="([^"#?]+)"/g)) refs.push(m[1]);
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons) refs.push(icon.src);
  for (const ref of refs.filter((r) => !/^([a-z]+:|\/\/|#)/i.test(r))) assert.ok(urls.has(ref), `${ref} is not precached`);
});

test('the version changes with the content of a shipped file', () => {
  const block = renderBlock({ version: 'abc', urls: ['./', 'index.html'] });
  const out = applyBlock('before\n' + renderBlock({ version: 'old', urls: ['./'] }) + '\nafter', block);
  assert.ok(out.includes("CACHE_VERSION = 'abc'") && out.startsWith('before\n') && out.endsWith('\nafter'));
  assert.ok(listShippable(ROOT).length > 20);
});
