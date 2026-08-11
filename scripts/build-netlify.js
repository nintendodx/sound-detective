const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DIST_DIR = path.join(ROOT, 'dist');
const DIST_PUBLIC_DIR = path.join(DIST_DIR, 'public');
const EXCLUDE = new Set([
  'admin.html',
  'admin-users.html',
  'admin-tags.html',
  'admin-analytics.html',
  'admin.js',
  'admin-users.js',
  'admin-tags.js',
  'admin-analytics.js',
  'admin.css',
  'dx100-root-ca.crt'
]);

function appVersion() {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  const match = source.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!match) throw new Error('无法从 public/app.js 读取 APP_VERSION');
  return match[1];
}

function updateHtmlVersion(file, version) {
  const target = path.join(DIST_DIR, file);
  let html = fs.readFileSync(target, 'utf8');
  html = html.replace(/(\/public\/(?:style\.css|app\.js|team\.js|brand-wordmark\.svg|how-to-play\.svg)\?v=)[^"']+/g, `$1${version}`);
  html = html.replace(/(<span id="appVersion">)[^<]+(<\/span>)/, `$1${version}$2`);
  html = html.replace(/(<b id="changelogTitle">)[^<]+(<\/b>)/, `$1${version}$2`);
  fs.writeFileSync(target, html);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

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
    ''
  ].join('\n')
);

console.log(`Netlify static build ready: ${path.relative(ROOT, DIST_DIR)}`);
