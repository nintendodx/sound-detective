const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'data', 'releases');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: false,
    ...options
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

function required(name) {
  if (!process.env[name]) throw new Error(`缺少环境变量 ${name}`);
}

function parseArgs() {
  const flags = new Set(process.argv.slice(2));
  return {
    prod: !flags.has('--preview'),
    syncData: !flags.has('--no-data'),
    syncAssets: !flags.has('--no-assets')
  };
}

function releaseId() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function writeManifest(id, options) {
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'store.json'), 'utf8'));
  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    mode: options.prod ? 'production' : 'preview',
    gitCommit: capture('git', ['rev-parse', '--short', 'HEAD']) || null,
    gitBranch: capture('git', ['branch', '--show-current']) || null,
    siteId: process.env.NETLIFY_SITE_ID || '',
    storeName: process.env.DX100_BLOBS_STORE || 'dx100-sound-game',
    counts: {
      sounds: store.sounds?.length || 0,
      enabledSounds: (store.sounds || []).filter((sound) => sound.enabled).length,
      users: store.users?.length || 0,
      sessions: store.sessions?.length || 0,
      analyticsEvents: store.analyticsEvents?.length || 0
    }
  };
  const file = path.join(RELEASE_DIR, `${id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`release manifest: ${path.relative(ROOT, file)}`);
}

function main() {
  loadEnvFile(path.join(ROOT, '.env.cloud'));
  const options = parseArgs();
  required('NETLIFY_SITE_ID');
  required('NETLIFY_AUTH_TOKEN');
  required('ADMIN_SECRET_PATH');
  required('ADMIN_TOKEN');
  required('BAIDU_API_KEY');
  required('BAIDU_SECRET_KEY');

  run('npm', ['run', 'check']);
  run('npm', ['run', 'build:netlify']);

  const syncArgs = ['scripts/sync-cloud-data.mjs', 'push'];
  if (options.syncData && !options.syncAssets) syncArgs.push('--data');
  if (!options.syncData && options.syncAssets) syncArgs.push('--assets', '--images');
  if (options.syncData && options.syncAssets) syncArgs.push('--data', '--assets', '--images');
  if (options.syncData || options.syncAssets) run('node', syncArgs);

  const deployArgs = ['netlify', 'deploy', '--site', process.env.NETLIFY_SITE_ID];
  if (options.prod) deployArgs.push('--prod');
  run('npx', deployArgs);
  writeManifest(releaseId(), options);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
