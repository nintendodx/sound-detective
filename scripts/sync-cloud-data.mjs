import { getStore } from "@netlify/blobs";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE_FILE = path.join(ROOT, "data", "store.json");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const IMAGES_DIR = path.join(ROOT, "图片文件");

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, ".env.cloud"));

const STORE_NAME = process.env.DX100_BLOBS_STORE || "dx100-sound-game";

function usage() {
  console.log([
    "Usage:",
    "  node scripts/sync-cloud-data.mjs push [--data] [--assets] [--images]",
    "  node scripts/sync-cloud-data.mjs pull [--data] [--assets] [--images]",
    "  node scripts/sync-cloud-data.mjs list",
    "",
    "Required for local sync:",
    "  NETLIFY_SITE_ID=...",
    "  NETLIFY_AUTH_TOKEN=..."
  ].join("\n"));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || "list";
  const flags = new Set(args.slice(1));
  const noneSelected = !flags.has("--data") && !flags.has("--assets") && !flags.has("--images");
  return {
    command,
    data: noneSelected || flags.has("--data"),
    assets: noneSelected || flags.has("--assets"),
    images: noneSelected || flags.has("--images")
  };
}

function store() {
  return getStore({
    name: STORE_NAME,
    siteID: requiredEnv("NETLIFY_SITE_ID"),
    token: requiredEnv("NETLIFY_AUTH_TOKEN"),
    consistency: "strong"
  });
}

function filesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => path.join(dir, entry.name));
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function pushJson(blobStore) {
  const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  await blobStore.setJSON("store.json", data);
  console.log(`pushed store.json (${data.sounds?.length || 0} sounds, ${data.users?.length || 0} users)`);
}

async function pushFiles(blobStore, dir, prefix) {
  const files = filesIn(dir);
  for (const file of files) {
    const key = `${prefix}/${path.basename(file)}`;
    await blobStore.set(key, toArrayBuffer(fs.readFileSync(file)));
    console.log(`pushed ${key}`);
  }
  console.log(`pushed ${files.length} ${prefix} file(s)`);
}

async function pullJson(blobStore) {
  const remote = await blobStore.get("store.json", { type: "json" });
  if (!remote) {
    console.log("remote store.json not found");
    return;
  }
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const backup = `${STORE_FILE}.backup-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  if (fs.existsSync(STORE_FILE)) fs.copyFileSync(STORE_FILE, backup);
  fs.writeFileSync(STORE_FILE, `${JSON.stringify(remote, null, 2)}\n`);
  console.log(`pulled store.json; local backup: ${path.relative(ROOT, backup)}`);
}

async function pullFiles(blobStore, dir, prefix) {
  const { blobs } = await blobStore.list({ prefix: `${prefix}/` });
  fs.mkdirSync(dir, { recursive: true });
  for (const item of blobs) {
    const data = await blobStore.get(item.key, { type: "arrayBuffer" });
    if (!data) continue;
    const target = path.join(dir, path.basename(item.key));
    fs.writeFileSync(target, Buffer.from(data));
    console.log(`pulled ${item.key}`);
  }
  console.log(`pulled ${blobs.length} ${prefix} file(s)`);
}

async function listRemote(blobStore) {
  const { blobs } = await blobStore.list();
  const groups = blobs.reduce((acc, item) => {
    const group = item.key.includes("/") ? item.key.split("/")[0] : "root";
    acc[group] = (acc[group] || 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({ store: STORE_NAME, total: blobs.length, groups }, null, 2));
}

async function main() {
  const options = parseArgs();
  if (!["push", "pull", "list"].includes(options.command)) {
    usage();
    process.exit(1);
  }
  const blobStore = store();
  if (options.command === "list") return listRemote(blobStore);
  if (options.command === "push") {
    if (options.data) await pushJson(blobStore);
    if (options.assets) await pushFiles(blobStore, UPLOADS_DIR, "uploads");
    if (options.images) await pushFiles(blobStore, IMAGES_DIR, "images");
    return;
  }
  if (options.data) await pullJson(blobStore);
  if (options.assets) await pullFiles(blobStore, UPLOADS_DIR, "uploads");
  if (options.images) await pullFiles(blobStore, IMAGES_DIR, "images");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
