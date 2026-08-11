const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CERT_DIR = path.join(ROOT, '.certs');
const PORT = Number(process.env.HTTPS_PORT || 3443);
const TARGET_PORT = Number(process.env.TARGET_PORT || 3000);

const options = {
  key: fs.readFileSync(path.join(CERT_DIR, 'dx100-local.key')),
  cert: fs.readFileSync(path.join(CERT_DIR, 'dx100-local.crt'))
};

function proxy(req, res) {
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${TARGET_PORT}`,
      'x-forwarded-proto': 'https'
    }
  }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on('error', error => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `HTTPS 代理无法连接本地游戏服务：${error.message}` }));
  });

  req.pipe(upstream);
}

https.createServer(options, proxy).listen(PORT, '0.0.0.0', () => {
  console.log(`DX100 HTTPS 已启动：https://localhost:${PORT}`);
});
