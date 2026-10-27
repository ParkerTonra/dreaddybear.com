// Copies the Ant Arena browser client into ants/play/ so the site serves a static copy.
// Usage: node tools/sync-ants.mjs <path-to-ants-folder>   (or set ANTS_DIR)
// Module files are renamed .mjs -> .js: the host serves .js as JavaScript, and browsers refuse a module
// served as text/plain.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const antsArg = process.argv[2] ?? process.env.ANTS_DIR;
if (!antsArg) {
  console.error("Usage: node tools/sync-ants.mjs <path-to-ants-folder>   (or set ANTS_DIR)");
  process.exit(1);
}
const antsDir = path.resolve(antsArg);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "ants", "play");

const src = path.join(antsDir, "public");
if (!existsSync(path.join(src, "index.html"))) {
  console.error(`No public/index.html under ${antsDir}`);
  process.exit(1);
}

// The OneLobby browser bundle (the game's server.js serves it at /onelobby.bundle.mjs).
const bundle = createRequire(path.join(antsDir, "package.json")).resolve("onelobby/bundle");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(src, out, { recursive: true });
cpSync(bundle, path.join(out, "onelobby.bundle.js"));

function rewrite(file, from, to) {
  const text = readFileSync(file, "utf8");
  if (!text.includes(from)) throw new Error(`${path.relative(out, file)}: ${from} not found`);
  writeFileSync(file, text.replace(from, to));
}

// net/onelobby.mjs -> .js, and its absolute bundle import becomes relative (the copy lives under /ants/play/).
renameSync(path.join(out, "net", "onelobby.mjs"), path.join(out, "net", "onelobby.js"));
rewrite(path.join(out, "net", "onelobby.js"), "'/onelobby.bundle.mjs'", "'../onelobby.bundle.js'");
rewrite(path.join(out, "client.js"), "import('./net/onelobby.mjs')", "import('./net/onelobby.js')");

// Without a join code there is nothing to play, so send the visitor to the join page.
// The onelobby and share-base metas stay empty here (server.js fills them only when it serves the page).
const redirect = `<script>if(!/[?&]dc=/.test(location.search))location.replace('/ants/');</script>`;
rewrite(path.join(out, "index.html"), "<head>", `<head>${redirect}`);

console.log(`Synced ${src} -> ${out}`);
