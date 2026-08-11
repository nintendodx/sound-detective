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
for (const page of ['index.html', 'team.html']) {
  fs.copyFileSync(path.join(PUBLIC_DIR, page), path.join(DIST_DIR, page));
}
fs.writeFileSync(
  path.join(DIST_DIR, '_headers'),
  [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '',
    '/public/*',
    '  Cache-Control: public, max-age=3600',
    ''
  ].join('\n')
);

console.log(`Netlify static build ready: ${path.relative(ROOT, DIST_DIR)}`);
