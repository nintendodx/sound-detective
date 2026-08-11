import { getStore } from "@netlify/blobs";
import { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";

const require = createRequire(import.meta.url);
const app = require("../../server.js");

function storeName() {
  return Netlify.env.get("DX100_BLOBS_STORE") || "dx100-sound-game";
}

function headersFromRequest(request) {
  const headers = {};
  for (const [key, value] of request.headers.entries()) {
    headers[key.toLowerCase()] = value;
  }
  const url = new URL(request.url);
  if (!headers.host) headers.host = url.host;
  return headers;
}

async function bodyBuffer(request) {
  if (request.method === "GET" || request.method === "HEAD") return Buffer.alloc(0);
  return Buffer.from(await request.arrayBuffer());
}

function toNodeRequest(request, context, body) {
  const url = new URL(request.url);
  const nodeReq = Readable.from(body.length ? [body] : []);
  nodeReq.method = request.method;
  nodeReq.url = `${url.pathname}${url.search}`;
  nodeReq.headers = headersFromRequest(request);
  nodeReq.socket = { remoteAddress: context.ip || nodeReq.headers["x-forwarded-for"] || "" };
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

async function runNodeHandler(request, context) {
  const body = await bodyBuffer(request);
  const nodeReq = toNodeRequest(request, context, body);
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

export default async (request, context) => {
  try {
    const store = getStore({ name: storeName(), consistency: "strong" });
    return await app.withCloudRequest(store, () => runNodeHandler(request, context));
  } catch (error) {
    console.error(error);
    return Response.json({ error: error?.message || "云端请求处理失败" }, { status: 500 });
  }
};

export const config = {
  path: "/*",
  preferStatic: true
};
