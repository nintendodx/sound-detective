const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SHARED_FILES = Object.freeze([
  'voice-game-contract.js',
  'asr-cloudflare-core.mjs',
  'asr-health-worker.mjs',
  'asr-node.cjs',
  'asr-session-ticket.mjs',
  'voice-asr-client.js'
]);

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function syncSharedAsr(root, config) {
  const settings = config.sharedAsr;
  if (!settings?.sourceDir) throw Error('发布配置缺少 sharedAsr.sourceDir');
  const sourceDir = path.resolve(root, settings.sourceDir);
  const sharedTargetDir = path.resolve(root, settings.sharedTargetDir || 'shared');
  const voiceClientTarget = path.resolve(root, settings.voiceClientTarget || 'shared/voice-asr-client.js');
  const hashes = {};
  for (const name of SHARED_FILES) {
    const source = path.join(sourceDir, name);
    const target = name === 'voice-asr-client.js' ? voiceClientTarget : path.join(sharedTargetDir, name);
    if (!fs.existsSync(source)) throw Error(`共享 ASR 源文件不存在：${source}`);
    fs.mkdirSync(path.dirname(target), { recursive:true });
    if (path.resolve(source) !== path.resolve(target) && (!fs.existsSync(target) || fileHash(source) !== fileHash(target))) {
      fs.copyFileSync(source, target);
    }
    hashes[name] = fileHash(target);
  }
  return hashes;
}

module.exports = { SHARED_FILES, syncSharedAsr };

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const flag = process.argv.slice(2).find(arg => arg.startsWith('--config='));
  const configFile = flag ? flag.slice('--config='.length) : 'cloudflare.release.json';
  const config = JSON.parse(fs.readFileSync(path.resolve(root, configFile), 'utf8'));
  const hashes = syncSharedAsr(root, config);
  console.log(`共享 ASR 模块已同步：${Object.keys(hashes).length} 个文件`);
}
