// Bundles the PWA into web/dist.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'web/dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(root, 'web/app.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022', 'safari16'],
  minify: true,
  sourcemap: true,
  outfile: path.join(out, 'app.js'),
  logLevel: 'info',
});

for (const f of ['index.html', 'app.css', 'theme.js', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg']) {
  fs.copyFileSync(path.join(root, 'web', f), path.join(out, f));
}
fs.cpSync(path.join(root, 'web/icons'), path.join(out, 'icons'), { recursive: true });
console.log('built web/dist');
