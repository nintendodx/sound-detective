import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "cloudflare.release.json"), "utf8"));
const SHARED_ENV_FILE = path.resolve(process.env.VOICE_GAME_ENV_FILE || RELEASE_CONFIG.envFile);
const DEFAULT_PAGES_PROJECT = "sound-detective";
const SECRET_NAMES = [...new Set(RELEASE_CONFIG.secrets || [])];

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

function putPagesSecret(projectName, name, value) {
  const result = spawnSync("npx", ["wrangler", "pages", "secret", "put", name, "--project-name", projectName], {
    cwd: ROOT,
    input: `${value}\n`,
    stdio: ["pipe", "inherit", "inherit"],
    env: process.env,
    shell: false
  });
  if (result.status !== 0) throw new Error(`Cloudflare Pages 项目 ${projectName} 写入 ${name} 失败`);
}

function pagesProjectsFromArgs() {
  const projects = [];
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--pages-project" && args[index + 1]) projects.push(args[++index]);
  }
  return [...new Set(projects.length ? projects : [process.env.CLOUDFLARE_PAGES_PROJECT || DEFAULT_PAGES_PROJECT])];
}

function main() {
  if (!SECRET_NAMES.length) throw new Error("cloudflare.release.json 未配置 secrets");
  loadEnvFile(SHARED_ENV_FILE);
  process.env.WRANGLER_LOG_PATH ||= path.join(ROOT, ".wrangler", "logs");
  const projects = pagesProjectsFromArgs();
  for (const name of SECRET_NAMES) {
    if (!process.env[name]) throw new Error(`缺少环境变量 ${name}`);
  }
  for (const projectName of projects) {
    for (const name of SECRET_NAMES) putPagesSecret(projectName, name, process.env[name]);
    console.log(`synced ${SECRET_NAMES.length} Cloudflare Pages secrets to ${projectName}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
