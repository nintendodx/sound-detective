const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DIST_DIR = path.join(ROOT, 'dist-cloudflare');
const DIST_PUBLIC_DIR = path.join(DIST_DIR, 'public');
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.css', '.toml', '.json', '.jsonc', '.md', '.sql']);
const METRIC_EXCLUDED_DIRS = new Set(['.git', '.netlify', '.wrangler', '.certs', 'node_modules', 'dist', 'dist-cloudflare', 'data', 'uploads', '图片文件', '声音文件']);
const METRIC_EXCLUDED_PREFIXES = ['tools/whisper-local', 'tools/sensevoice'];
const METRIC_EXCLUDED_FILES = new Set(['package-lock.json']);
const REMOVED_ADMIN_ASSETS = new Set([
  'admin.html',
  'admin.js',
  'admin-users.html',
  'admin-users.js',
  'admin-tags.html',
  'admin-tags.js',
  'admin-analytics.html',
  'admin-analytics.js',
  'admin.css'
]);

function metricRelative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function isMetricExcludedDir(relative) {
  return METRIC_EXCLUDED_DIRS.has(relative) || METRIC_EXCLUDED_PREFIXES.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`));
}

function isMetricExcludedFile(relative) {
  return METRIC_EXCLUDED_FILES.has(relative);
}

function metricCategory(relative) {
  if (relative.startsWith('public/') && /\.(?:html|css|js)$/i.test(relative)) return '前端界面';
  if (relative === 'server.js' || relative.startsWith('cloudflare/')) return '服务端/API';
  if (relative.startsWith('scripts/') || relative.startsWith('docs/') || relative.startsWith('tools/') || relative === 'wrangler.jsonc' || relative === 'package.json' || relative === 'README.md' || relative === 'DX100-声音游戏.md') return '脚本/配置';
  return '其他工程文件';
}

function countMetricLines(text) {
  if (!text) return { sourceLines: 0, codeLines: 0 };
  return {
    sourceLines: (text.match(/\n/g) || []).length + (text.endsWith('\n') ? 0 : 1),
    codeLines: text.split(/\r?\n/).filter(line => line.trim()).length
  };
}

function writeEngineeringStats() {
  const stack = [ROOT];
  const files = [];
  const categories = {};
  let codeLines = 0;
  let sourceLines = 0;
  let sourceBytes = 0;

  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      const relative = metricRelative(file);
      if (entry.isDirectory()) {
        if (!isMetricExcludedDir(relative)) stack.push(file);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      if (isMetricExcludedDir(path.dirname(relative)) || isMetricExcludedFile(relative)) continue;

      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const lines = countMetricLines(text);
      const category = metricCategory(relative);
      categories[category] ||= { fileCount: 0, codeLines: 0, sourceLines: 0 };
      categories[category].fileCount += 1;
      categories[category].codeLines += lines.codeLines;
      categories[category].sourceLines += lines.sourceLines;
      files.push(relative);
      codeLines += lines.codeLines;
      sourceLines += lines.sourceLines;
      sourceBytes += Buffer.byteLength(text);
    }
  }

  files.sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const stats = {
    source: 'build-metrics-manifest',
    updatedAt: new Date().toISOString(),
    rootName: path.basename(ROOT),
    fileCount: files.length,
    codeLines,
    sourceLines,
    sourceBytes,
    categories,
    excludes: '不含声音素材、图片素材、题库数据、录音和依赖包',
    files
  };
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'engineering-stats.json'), `${JSON.stringify(stats, null, 2)}\n`);
  console.log(`工程量统计已更新：${stats.codeLines} 行代码，${stats.fileCount} 个工程文件`);
}

function appVersion() {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  const match = source.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!match) throw new Error('无法从 public/app.js 读取 APP_VERSION');
  return match[1];
}

function updateHtmlVersion(file, version) {
  const target = path.join(DIST_DIR, file);
  let html = fs.readFileSync(target, 'utf8');
  html = html.replace(/(\/public\/(?:style\.css|app\.js|team\.js|brand-wordmark\.svg|how-to-play\.svg|admin(?:[-.]|$)[^"']*)\?v=)[^"']+/g, `$1${version}`);
  html = html.replace(/(<span id="appVersion">)[^<]+(<\/span>)/, `$1${version}$2`);
  html = html.replace(/(<b id="changelogTitle">)[^<]+(<\/b>)/, `$1${version}$2`);
  fs.writeFileSync(target, html);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'dx100-root-ca.crt') continue;
    if (from === PUBLIC_DIR && REMOVED_ADMIN_ASSETS.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

writeEngineeringStats();
fs.rmSync(DIST_DIR, { recursive: true, force: true });
copyDir(PUBLIC_DIR, DIST_PUBLIC_DIR);
const version = appVersion();
for (const page of ['index.html', 'team.html']) {
  fs.copyFileSync(path.join(PUBLIC_DIR, page), path.join(DIST_DIR, page));
  updateHtmlVersion(page, version);
}
fs.writeFileSync(
  path.join(DIST_DIR, '_headers'),
  [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/public/*',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    ''
  ].join('\n')
);

console.log(`Cloudflare static build ready: ${path.relative(ROOT, DIST_DIR)}`);
