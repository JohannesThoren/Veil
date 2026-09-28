// Copyright (c) 2026 Johannes Thorén. All rights reserved.
// Licensed under the LGJT License v1. See LICENSE in the project root.
// Bundles the PWA into web/dist.
// JS/CSS get a content hash in their file name (app-3F9A1C2B.js), and the HTML and service worker
// are rewritten to point at them. A new deploy therefore can never mix with stale cached files,
// and hashed files can be cached "forever".
import { build } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'web');
const out = path.join(root, 'web/dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
const assets = {}; // "/app.js" -> "/app-<hash>.js"

// 1. JS bundles
const result = await build({
  entryPoints: [path.join(src, 'app.js'), path.join(src, 'admin.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022', 'safari16'],
  minify: true,
  sourcemap: true,
  outdir: out,
  entryNames: '[name]-[hash]',
  metafile: true,
  logLevel: 'info',
});
for (const [file, meta] of Object.entries(result.metafile.outputs)) {
  if (!meta.entryPoint || !file.endsWith('.js')) continue;
  assets[`/${path.basename(meta.entryPoint)}`] = `/${path.basename(file)}`;
}

// 2. Plain files that get hashed names
for (const f of ['app.css', 'theme.js']) {
  const buf = fs.readFileSync(path.join(src, f));
  const ext = path.extname(f);
  const name = `${path.basename(f, ext)}-${hash(buf)}${ext}`;
  fs.writeFileSync(path.join(out, name), buf);
  assets[`/${f}`] = `/${name}`;
}

// 3. HTML pages: point at hashed assets
for (const f of ['index.html', 'admin.html']) {
  let html = fs.readFileSync(path.join(src, f), 'utf8');
  for (const [from, to] of Object.entries(assets)) html = html.replaceAll(`"${from}"`, `"${to}"`);
  fs.writeFileSync(path.join(out, f), html);
}

// 4. Static files with stable names
for (const f of ['manifest.webmanifest', 'icon.svg', 'icon-maskable.svg']) fs.copyFileSync(path.join(src, f), path.join(out, f));
fs.cpSync(path.join(src, 'icons'), path.join(out, 'icons'), { recursive: true });

// 5. Service worker: versioned cache name + exact shell list, so every deploy installs a fresh worker
const version = hash(Object.values(assets).join('|') + fs.readFileSync(path.join(src, 'sw.js')));
const shell = ['/', assets['/app.js'], assets['/app.css'], assets['/theme.js'], '/manifest.webmanifest', '/icon.svg',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-96.png'];
let sw = fs.readFileSync(path.join(src, 'sw.js'), 'utf8');
sw = sw.replace(/const CACHE = '[^']*';/, `const CACHE = 'veil-${version}';`)
  .replace(/const SHELL = \[[\s\S]*?\];/, `const SHELL = ${JSON.stringify(shell)};`);
fs.writeFileSync(path.join(out, 'sw.js'), sw);

fs.writeFileSync(path.join(out, 'assets.json'), JSON.stringify({ version, assets }, null, 2));
console.log(`built web/dist (version ${version})`);
for (const [from, to] of Object.entries(assets)) console.log(`  ${from} → ${to}`);
