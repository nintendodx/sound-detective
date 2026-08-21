import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE_FILE = path.join(ROOT, "data", "store.json");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const IMAGES_DIR = path.join(ROOT, "图片文件");
const KV_BINDING = "SOUND_DETECTIVE_DATA";

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
process.env.WRANGLER_LOG_PATH ||= path.join(ROOT, ".wrangler", "logs");

function usage() {
  console.log([
    "Usage:",
    "  node scripts/sync-cloudflare-data.mjs push [--data] [--assets] [--images]",
    "  node scripts/sync-cloudflare-data.mjs pull [--data] [--assets] [--images]",
    "  node scripts/sync-cloudflare-data.mjs list",
    "",
    "Uses Wrangler auth. Run `npx wrangler login` or set CLOUDFLARE_API_TOKEN first."
  ].join("\n"));
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

function runWrangler(args) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    shell: false
  });
  if (result.status !== 0) throw new Error(`npx wrangler ${args.join(" ")} failed with exit code ${result.status}`);
}

function captureWrangler(args, options = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
    env: process.env,
    shell: false,
    encoding: options.encoding ?? "buffer",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`npx wrangler ${args.join(" ")} failed with exit code ${result.status}`);
  return result.stdout;
}

function filesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => path.join(dir, entry.name));
}

function putFile(key, file) {
  runWrangler(["kv", "key", "put", "--binding", KV_BINDING, key, "--path", file, "--remote"]);
}

function pushJson() {
  const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  putFile("store.json", STORE_FILE);
  console.log(`pushed store.json (${data.sounds?.length || 0} sounds, ${data.users?.length || 0} users)`);
}

function pushFiles(dir, prefix) {
  const files = filesIn(dir);
  for (const file of files) {
    const key = `${prefix}/${path.basename(file)}`;
    putFile(key, file);
    console.log(`pushed ${key}`);
  }
  console.log(`pushed ${files.length} ${prefix} file(s)`);
}

function listRemote() {
  runWrangler(["kv", "key", "list", "--binding", KV_BINDING, "--remote"]);
}

function backupFile(file) {
  if (!fs.existsSync(file)) return "";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const backup = `${file.replace(/\.json$/i, "")}.backup-${stamp}.json`;
  fs.copyFileSync(file, backup);
  return backup;
}

function getKey(key) {
  return captureWrangler(["kv", "key", "get", "--binding", KV_BINDING, key, "--remote"]);
}

function listKeys(prefix) {
  const raw = captureWrangler(["kv", "key", "list", "--binding", KV_BINDING, "--prefix", prefix, "--remote"], { encoding: "utf8" });
  const items = JSON.parse(String(raw || "[]"));
  return items.map((item) => item.name || item.key).filter(Boolean);
}

function pullJson() {
  const raw = getKey("store.json");
  const data = JSON.parse(raw.toString("utf8"));
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const backup = backupFile(STORE_FILE);
  fs.writeFileSync(STORE_FILE, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`pulled store.json (${data.sounds?.length || 0} sounds, ${data.users?.length || 0} users, ${data.sessions?.length || 0} sessions)`);
  if (backup) console.log(`local backup: ${path.relative(ROOT, backup)}`);
}

function pullFiles(prefix, dir) {
  const keys = listKeys(`${prefix}/`);
  fs.mkdirSync(dir, { recursive: true });
  for (const key of keys) {
    const target = path.join(dir, path.basename(key));
    fs.writeFileSync(target, getKey(key));
    console.log(`pulled ${key}`);
  }
  console.log(`pulled ${keys.length} ${prefix} file(s)`);
}

function main() {
  const options = parseArgs();
  if (!["push", "pull", "list"].includes(options.command)) {
    usage();
    process.exit(1);
  }
  if (options.command === "list") return listRemote();
  if (options.command === "pull") {
    if (options.data) pullJson();
    if (options.assets) pullFiles("uploads", UPLOADS_DIR);
    if (options.images) pullFiles("images", IMAGES_DIR);
    return;
  }
  if (options.data) pushJson();
  if (options.assets) pushFiles(UPLOADS_DIR, "uploads");
  if (options.images) pushFiles(IMAGES_DIR, "images");
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
