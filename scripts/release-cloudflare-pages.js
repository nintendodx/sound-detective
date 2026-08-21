const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist-cloudflare');
const RELEASE_DIR = path.join(ROOT, 'data', 'releases');
let PROJECT_NAME = 'sound-detective';
const REQUIRED_SECRETS = [
  'BAIDU_APP_ID',
  'BAIDU_API_KEY',
  'BAIDU_SECRET_KEY',
  'TENCENT_ASR_APP_ID',
  'TENCENT_ASR_SECRET_ID',
  'TENCENT_ASR_SECRET_KEY',
  'DOUBAO_ASR_API_KEY'
];

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
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
    shell: false,
    ...options
  });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

function required(name) {
  if (!process.env[name]) throw new Error(`缺少环境变量 ${name}`);
}

function parseArgs() {
  const flags = new Set(process.argv.slice(2));
  return {
    syncData: !flags.has('--no-data'),
    syncAssets: !flags.has('--no-assets'),
    syncSecrets: !flags.has('--no-secrets')
  };
}

function releaseId() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function pagesProjects() {
  const raw = capture('npx', ['wrangler', 'pages', 'project', 'list', '--json']);
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ensurePagesProject() {
  const exists = pagesProjects().some((project) => (project.name || project['Project Name']) === PROJECT_NAME);
  if (exists) return;
  run('npx', [
    'wrangler',
    'pages',
    'project',
    'create',
    PROJECT_NAME,
    '--production-branch',
    'main',
    '--compatibility-date',
    '2026-08-18',
    '--compatibility-flags',
    'nodejs_compat'
  ]);
}

function putPagesSecret(name, value) {
  console.log(`$ npx wrangler pages secret put ${name} --project-name ${PROJECT_NAME}`);
  const result = spawnSync('npx', ['wrangler', 'pages', 'secret', 'put', name, '--project-name', PROJECT_NAME], {
    cwd: ROOT,
    input: `${value}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: process.env,
    shell: false
  });
  if (result.status !== 0) throw new Error(`npx wrangler pages secret put ${name} failed with exit code ${result.status}`);
}

function syncSecrets() {
  for (const name of REQUIRED_SECRETS) {
    required(name);
    putPagesSecret(name, process.env[name]);
    console.log(`synced Cloudflare Pages secret ${name}`);
  }
}

function writeManifest(id, options) {
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'store.json'), 'utf8'));
  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    mode: 'cloudflare-pages-direct',
    projectName: PROJECT_NAME,
    pagesDevUrl: `https://${PROJECT_NAME}.pages.dev`,
    gitCommit: capture('git', ['rev-parse', '--short', 'HEAD']) || null,
    gitBranch: capture('git', ['branch', '--show-current']) || null,
    counts: {
      sounds: store.sounds?.length || 0,
      enabledSounds: (store.sounds || []).filter((sound) => sound.enabled).length,
      users: store.users?.length || 0,
      sessions: store.sessions?.length || 0,
      analyticsEvents: store.analyticsEvents?.length || 0
    },
    synced: {
      data: options.syncData,
      assets: options.syncAssets,
      secrets: options.syncSecrets
    },
    recovery: {
      source: 'local-git-with-optional-github-backup',
      deployCommand: 'npm run release'
    }
  };
  const file = path.join(RELEASE_DIR, `${id}.cloudflare-pages.json`);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`release manifest: ${path.relative(ROOT, file)}`);
}

function main() {
  loadEnvFile(path.join(ROOT, '.env.cloud'));
  PROJECT_NAME = process.env.CLOUDFLARE_PAGES_PROJECT || PROJECT_NAME;
  process.env.WRANGLER_LOG_PATH ||= path.join(ROOT, '.wrangler', 'logs');
  const options = parseArgs();

  run('npm', ['run', 'check']);
  run('npm', ['run', 'build:cloudflare:pages']);
  ensurePagesProject();
  if (options.syncSecrets) syncSecrets();
  run('npx', [
    'wrangler',
    'pages',
    'deploy',
    DIST_DIR,
    '--project-name',
    PROJECT_NAME,
    '--branch',
    'main',
    '--commit-dirty',
    'true'
  ]);

  const syncArgs = ['scripts/sync-cloudflare-data.mjs', 'push'];
  if (options.syncData && !options.syncAssets) syncArgs.push('--data');
  if (!options.syncData && options.syncAssets) syncArgs.push('--assets', '--images');
  if (options.syncData && options.syncAssets) syncArgs.push('--data', '--assets', '--images');
  if (options.syncData || options.syncAssets) run('node', syncArgs);
  writeManifest(releaseId(), options);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
