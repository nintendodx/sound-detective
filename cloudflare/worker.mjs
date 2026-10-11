import { Buffer } from "node:buffer";
import { Readable, Writable } from "node:stream";
import { handleLightGameApi } from "./light-game.mjs";
import engineeringStats from "../data/engineering-stats.json" with { type:"json" };

globalThis.__DX100_ENGINEERING_STATS ||= engineeringStats;

let appPromise = null;

const MIME = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
};

function syncProcessEnv(env) {
  if (!globalThis.process?.env) return;
  for (const [key, value] of Object.entries(env || {})) {
    if (typeof value === "string" && process.env[key] !== value) process.env[key] = value;
  }
}

async function loadApp(env) {
  syncProcessEnv(env);
  globalThis.__DX100_ROOT ||= ".";
  appPromise ||= import("../server.js");
  const mod = await appPromise;
  return mod.default || mod;
}

function headersFromRequest(request) {
  const headers = {};
  for (const [key, value] of request.headers.entries()) headers[key.toLowerCase()] = value;
  const url = new URL(request.url);
  if (!headers.host) headers.host = url.host;
  return headers;
}

function requestBodyAllowed(method) {
  return !["GET", "HEAD"].includes(String(method || "GET").toUpperCase());
}

async function bodyBuffer(request) {
  if (!requestBodyAllowed(request.method)) return Buffer.alloc(0);
  return Buffer.from(await request.arrayBuffer());
}

function toNodeRequest(request, body) {
  const url = new URL(request.url);
  const nodeReq = Readable.from(body.length ? [body] : []);
  nodeReq.method = request.method;
  nodeReq.url = `${url.pathname}${url.search}`;
  nodeReq.headers = headersFromRequest(request);
  nodeReq.socket = {
    remoteAddress:
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for") ||
      ""
  };
  return nodeReq;
}

function appendHeaders(target, values = {}) {
  for (const [key, value] of Object.entries(values || {})) {
    if (Array.isArray(value)) {
      for (const item of value) target.append(key, String(item));
    } else if (value !== undefined) {
      target.set(key, String(value));
    }
  }
}

function responseHeadersObject(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) out[key] = value;
  return out;
}

function methodCanServeAsset(request) {
  return request.method === "GET" || request.method === "HEAD";
}

function normalizePathname(pathname) {
  return String(pathname || "/").replace(/\/+$/, "") || "/";
}

function noStoreHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    ...extra
  };
}

function notFound() {
  return Response.json({ error: "未找到页面" }, { status: 404 });
}

function unifiedDataEnabled(env) {
  return Boolean(env.ADMIN_HUB_DATA);
}

function dataKv(env) {
  return env.ADMIN_HUB_DATA || env.SOUND_DETECTIVE_DATA;
}

function dataKey(env, key) {
  return unifiedDataEnabled(env) ? `games/sound/${key}` : key;
}

function assetBucket(env) {
  return env.ADMIN_HUB_ASSETS || null;
}

function assetKey(env, key) {
  return unifiedDataEnabled(env) ? `games/sound/${key}` : key;
}

async function getDataValue(env, key, type = "") {
  const kv = dataKv(env);
  if (!kv) return null;
  const primaryKey = dataKey(env, key);
  const read = (store, targetKey) => type ? store.get(targetKey, type) : store.get(targetKey);
  const value = await read(kv, primaryKey);
  if (value !== null && value !== undefined) return value;
  if (unifiedDataEnabled(env) && env.SOUND_DETECTIVE_DATA) return read(env.SOUND_DETECTIVE_DATA, key);
  return value;
}

async function getAssetValue(env, key) {
  const bucket = assetBucket(env);
  if (bucket) {
    const object = await bucket.get(assetKey(env, key));
    if (object) {
      return {
        body: await object.arrayBuffer(),
        contentType: object.httpMetadata?.contentType || ""
      };
    }
  }
  const value = await getDataValue(env, key, "arrayBuffer");
  return value ? { body: value, contentType: "" } : null;
}

function assetRequest(request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: request.headers
  });
}

async function serveStaticAsset(request, env, pathname, extraHeaders = {}) {
  if (!env.ASSETS) return notFound();
  const response = await env.ASSETS.fetch(assetRequest(request, pathname));
  if (response.status === 404) return response;
  const headers = new Headers(response.headers);
  const runtimeHeaders = /\.(?:html|js|css)$/i.test(pathname)
    ? noStoreHeaders()
    : {};
  for (const [key, value] of Object.entries({ ...runtimeHeaders, ...extraHeaders })) {
    if (value) headers.set(key, String(value));
  }
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function publicStaticAsset(pathname) {
  if (pathname === "/") return "/index.html";
  if (pathname === "/index.html" || pathname === "/team.html") return pathname;
  if (pathname.startsWith("/public/")) return pathname;
  return "";
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function basename(value) {
  const decoded = safeDecode(value);
  return decoded.split(/[\\/]/).filter(Boolean).pop() || "";
}

function kvAssetKey(pathname) {
  if (pathname.startsWith("/uploads/")) {
    const name = basename(pathname.slice("/uploads/".length));
    return name ? `uploads/${name}` : "";
  }
  if (pathname.startsWith("/images/")) {
    const name = basename(pathname.slice("/images/".length));
    return name ? `images/${name}` : "";
  }
  return "";
}

function extension(name) {
  const clean = String(name || "").toLowerCase();
  const idx = clean.lastIndexOf(".");
  return idx >= 0 ? clean.slice(idx) : "";
}

function parseByteRange(header, totalSize) {
  const raw = String(header || "").trim();
  if (!raw) return null;
  if (totalSize <= 0) return { unsatisfiable: true };
  const match = raw.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return { unsatisfiable: true };
  const [, startText, endText] = match;
  if (!startText && !endText) return { unsatisfiable: true };
  let start;
  let end;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : totalSize - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { unsatisfiable: true };
    if (end >= totalSize) end = totalSize - 1;
  }
  if (start < 0 || end < start || start >= totalSize) return { unsatisfiable: true };
  return { start, end };
}

async function serveKvAsset(request, env, key) {
  if (!dataKv(env) && !assetBucket(env)) return notFound();
  const asset = await getAssetValue(env, key);
  if (!asset) return notFound();
  const value = asset.body;
  const totalSize = value.byteLength;
  const headers = {
    "Content-Type": asset.contentType || MIME[extension(key)] || "application/octet-stream",
    "Cache-Control": "public, max-age=3600",
    "Accept-Ranges": "bytes"
  };
  const range = parseByteRange(request.headers.get("range"), totalSize);
  if (range?.unsatisfiable) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${totalSize}`, "Content-Length": "0" }
    });
  }
  if (range) {
    const chunk = value.slice(range.start, range.end + 1);
    return new Response(request.method === "HEAD" ? null : chunk, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${totalSize}`,
        "Content-Length": String(chunk.byteLength)
      }
    });
  }
  return new Response(request.method === "HEAD" ? null : value, {
    status: 200,
    headers: { ...headers, "Content-Length": String(totalSize) }
  });
}

class CloudflareKvStore {
  constructor(env) {
    this.env = env;
    this.kv = dataKv(env);
    this.assets = env.ASSETS;
  }

  key(key) {
    return dataKey(this.env, key);
  }

  async get(key, options = {}) {
    if (!this.kv) return null;
    if (options.type === "json") return getDataValue(this.env, key, "json");
    if (options.type === "arrayBuffer") return getDataValue(this.env, key, "arrayBuffer");
    return getDataValue(this.env, key);
  }

  async setJSON(key, value) {
    if (!this.kv) throw new Error("缺少 Cloudflare KV 绑定 ADMIN_HUB_DATA 或 SOUND_DETECTIVE_DATA");
    await this.kv.put(this.key(key), JSON.stringify(value));
  }

  async set(key, value) {
    if (!this.kv) throw new Error("缺少 Cloudflare KV 绑定 ADMIN_HUB_DATA 或 SOUND_DETECTIVE_DATA");
    const body = Buffer.isBuffer(value)
      ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      : value;
    await this.kv.put(this.key(key), body);
  }

  async delete(key) {
    if (!this.kv) throw new Error("缺少 Cloudflare KV 绑定 ADMIN_HUB_DATA 或 SOUND_DETECTIVE_DATA");
    await this.kv.delete(this.key(key));
  }

  async list(options = {}) {
    if (!this.kv) return { blobs: [] };
    const keyPrefix = dataKey(this.env, options.prefix || "");
    const blobs = [];
    let cursor = undefined;
    do {
      const result = await this.kv.list({ prefix:keyPrefix, cursor });
      for (const item of result.keys || []) blobs.push({ key: unifiedDataEnabled(this.env) ? item.name.replace(/^games\/sound\//, "") : item.name });
      cursor = result.cursor;
      if (result.list_complete) break;
    } while (cursor);
    return { blobs };
  }

  async fetchAsset(req, res, safe, headers = {}) {
    if (!this.assets) return false;
    const host = req.headers.host || "sound-detective.local";
    const pathname = `/${String(safe || "").replace(/^\/+/, "")}`;
    const assetUrl = new URL(pathname, `https://${host}`);
    const response = await this.assets.fetch(new Request(assetUrl, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers: new Headers(req.headers || {})
    }));
    if (response.status === 404) return false;
    const outHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(headers || {})) outHeaders.set(key, String(value));
    const payload = req.method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, responseHeadersObject(outHeaders));
    res.end(payload);
    return true;
  }
}

async function runNodeHandler(app, request, env) {
  const body = await bodyBuffer(request);
  const nodeReq = toNodeRequest(request, body);
  const chunks = [];
  const headers = new Headers();
  let status = 200;

  const nodeRes = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      callback();
    }
  });

  nodeRes.writeHead = (statusCode, statusMessageOrHeaders, maybeHeaders) => {
    status = statusCode;
    if (typeof statusMessageOrHeaders === "object") appendHeaders(headers, statusMessageOrHeaders);
    appendHeaders(headers, maybeHeaders);
    return nodeRes;
  };
  nodeRes.setHeader = (key, value) => {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, String(item));
    } else {
      headers.set(key, String(value));
    }
  };
  nodeRes.getHeader = (key) => headers.get(key);

  const finished = new Promise((resolve, reject) => {
    nodeRes.on("finish", () => resolve(new Response(Buffer.concat(chunks), { status, headers })));
    nodeRes.on("error", reject);
  });

  await app.handleRequest(nodeReq, nodeRes);
  return finished;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = normalizePathname(url.pathname);
      if (methodCanServeAsset(request)) {
        const staticAsset = publicStaticAsset(pathname);
        if (staticAsset) return serveStaticAsset(request, env, staticAsset);

        const key = kvAssetKey(pathname);
        if (key) return serveKvAsset(request, env, key);
      }

      const lightGameResponse = await handleLightGameApi(request, env, pathname);
      if (lightGameResponse) return lightGameResponse;

      const app = await loadApp(env);
      const store = new CloudflareKvStore(env);
      return await app.withCloudRequest(store, () => runNodeHandler(app, request, env));
    } catch (error) {
      console.error(error);
      return Response.json(
        { error: error?.message || "Cloudflare 请求处理失败" },
        { status: 500 }
      );
    }
  }
};
