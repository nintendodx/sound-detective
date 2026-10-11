const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { spawnSync } = require('node:child_process');
const { syncSharedAsr } = require('./sync-shared-asr.cjs');

const root = path.resolve(__dirname, '..');
const configFlag = process.argv.slice(2).find(arg => arg.startsWith('--config='));
const configFile = configFlag ? configFlag.slice('--config='.length) : 'cloudflare.release.json';
const config = JSON.parse(fs.readFileSync(path.resolve(root, configFile), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const wrangler = path.join(root, 'node_modules', '.bin', 'wrangler');
const flags = new Set(process.argv.slice(2));
const validateOnly = flags.has('--validate-only');
const releaseId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const releaseVersion = config.version || `${pkg.version}-${config.versionDate}`;
const VERIFY_REQUEST_TIMEOUT_MS = 8_000;

function validateReleaseConfig() {
  for (const key of ['projectName', 'productionUrl', 'distDir', 'version']) {
    if (!String(config[key] || '').trim()) throw Error(`发布配置缺少 ${key}`);
  }
  if (String(pkg.version || '') !== String(config.version || '')) {
    throw Error(`package.json 与发布配置版本不一致：${pkg.version} / ${config.version}`);
  }
  const versionMatch = String(config.version).match(/^\d+\.\d+\.\d+-(\d{8})$/);
  if (!versionMatch) throw Error(`发布版本格式错误：${config.version}`);
  if (String(config.versionDate || '') !== versionMatch[1]) {
    throw Error(`发布日期与版本后缀不一致：${config.versionDate || 'empty'} / ${versionMatch[1]}`);
  }
  for (const key of ['productionUrl', 'verifyUrl', 'asrHealthUrl']) {
    if (config[key] && !/^https:\/\//.test(String(config[key]))) throw Error(`${key} 必须使用 HTTPS`);
  }
}

function loadEnv(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

function run(command, args, capture = false) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd:root,
    env:process.env,
    encoding:capture ? 'utf8' : undefined,
    stdio:capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    shell:false
  });
  if (result.status !== 0) throw Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  return capture ? result.stdout.trim() : '';
}

function captureOptional(command, args) {
  const result = spawnSync(command, args, { cwd:root, env:process.env, encoding:'utf8', stdio:['ignore', 'pipe', 'ignore'], shell:false });
  return result.status === 0 ? result.stdout.trim() : '';
}

function runScript(name) {
  if (name) run('npm', ['run', name]);
}

function putSecret(name) {
  const value = process.env[name];
  if (!value) throw Error(`缺少环境变量 ${name}`);
  console.log(`$ wrangler pages secret put ${name} --project-name ${config.projectName}`);
  const result = spawnSync(wrangler, ['pages', 'secret', 'put', name, '--project-name', config.projectName], {
    cwd:root,
    env:process.env,
    input:`${value}\n`,
    stdio:['pipe', 'inherit', 'inherit'],
    shell:false
  });
  if (result.status !== 0) throw Error(`同步 ${name} 失败`);
}

async function verify() {
  const deadline = Date.now() + 45_000;
  let latest = '';
  do {
    try {
      const response = await fetch(config.verifyUrl || config.productionUrl, {
        cache:'no-store',
        signal:AbortSignal.timeout(VERIFY_REQUEST_TIMEOUT_MS)
      });
      latest = await response.text();
      if (response.ok && latest.includes(releaseVersion)) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 3000));
  } while (Date.now() < deadline);
  if (!latest.includes(releaseVersion)) throw Error(`线上版本核对失败：期望 ${releaseVersion}`);
  if (!config.asrHealthUrl) return null;
  const response = await fetch(config.asrHealthUrl, {
    headers:{ Accept:'application/json' },
    cache:'no-store',
    signal:AbortSignal.timeout(VERIFY_REQUEST_TIMEOUT_MS)
  });
  const health = await response.json().catch(() => null);
  if (!response.ok || !health?.availableProviders?.length) throw Error('线上 ASR 健康检查失败');
  return health;
}

function manifest(options, health, asrModules) {
  const dir = path.join(root, config.releaseDir || 'data/releases');
  fs.mkdirSync(dir, { recursive:true });
  const record = {
    id:releaseId,
    createdAt:new Date().toISOString(),
    protocolVersion:1,
    projectName:config.projectName,
    productionUrl:config.productionUrl,
    version:releaseVersion,
    gitCommit:captureOptional('git', ['rev-parse', '--short', 'HEAD']) || null,
    synced:options,
    asrModules,
    asrStatus:health?.status || null,
    availableAsrProviders:health?.availableProviders || []
  };
  fs.writeFileSync(path.join(dir, `${releaseId}.cloudflare-pages.json`), `${JSON.stringify(record, null, 2)}\n`);
}

async function main() {
  validateReleaseConfig();
  if (!validateOnly && !fs.existsSync(wrangler)) throw Error('缺少本地 Wrangler，请先执行 npm install');
  if (!validateOnly) loadEnv(config.envFile ? path.resolve(root, config.envFile) : '');
  const options = {
    secrets:flags.has('--sync-secrets'),
    data:flags.has('--sync-data'),
    assets:flags.has('--sync-assets')
  };
  if (options.data && !config.syncData) {
    throw Error('当前项目不支持通过发布流程同步生产数据，请使用受保护的独立恢复命令');
  }
  if (options.assets && !config.syncAssets) {
    throw Error('当前项目未配置素材同步流程');
  }
  const asrModules = syncSharedAsr(root, config);
  runScript(config.checkScript || 'check');
  runScript(config.buildScript);
  if (validateOnly) {
    console.log(`release validation complete: ${config.projectName} ${releaseVersion}`);
    return;
  }
  if (options.secrets) for (const name of config.secrets || []) putSecret(name);
  run(wrangler, ['pages', 'deploy', config.distDir, '--project-name', config.projectName, '--branch', config.branch || 'main', '--commit-dirty', 'true']);
  if (options.data && config.syncData) run(config.syncData.command, config.syncData.args || []);
  if (options.assets && config.syncAssets) run(config.syncAssets.command, config.syncAssets.args || []);
  const health = await verify();
  manifest(options, health, asrModules);
  console.log(`release complete: ${config.productionUrl}`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
