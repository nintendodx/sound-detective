const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist-cloudflare');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
}

run('node', ['scripts/build-cloudflare.js']);
fs.writeFileSync(
  path.join(DIST_DIR, '_worker.js'),
  'export { default } from "../cloudflare/worker.mjs";\n'
);
console.log('Cloudflare Pages full game worker ready: dist-cloudflare/_worker.js');
