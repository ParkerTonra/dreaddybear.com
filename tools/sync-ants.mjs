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

// The OneLobby browser bundle: the package ships it as onelobby.bundle.js too, the name the game loads
// (through document.baseURI, so it sits beside the page).
const bundleMjs = createRequire(path.join(antsDir, "package.json")).resolve("onelobby/bundle");
const bundle = path.join(path.dirname(bundleMjs), "onelobby.bundle.js");
if (!existsSync(bundle)) {
  console.error(`No onelobby.bundle.js next to ${bundleMjs} (needs OneLobby 0.5.0-dev-b885b82 or newer)`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(src, out, { recursive: true });
cpSync(bundle, path.join(out, "onelobby.bundle.js"));

function rewrite(file, from, to) {
  const text = readFileSync(file, "utf8");
  if (!text.includes(from)) throw new Error(`${path.relative(out, file)}: ${from} not found`);
  writeFileSync(file, text.replaceAll(from, to));
}

// net/onelobby.mjs -> .js (the bundle is already onelobby.bundle.js). ants/.htaccess (AddType for .js/.mjs) is not touched.
renameSync(path.join(out, "net", "onelobby.mjs"), path.join(out, "net", "onelobby.js"));
for (const f of ["client.js", "host.js"]) rewrite(path.join(out, f), "import('./net/onelobby.mjs')", "import('./net/onelobby.js')");

// Without ?dc= the page offers Host 1v1 / Host 2v2 (host.js: the node-server meta is empty in this copy).
// The onelobby and share-base metas stay empty here (server.js fills them only when it serves the page).
const left = readFileSync(path.join(out, "net", "onelobby.js"), "utf8") + readFileSync(path.join(out, "client.js"), "utf8") + readFileSync(path.join(out, "host.js"), "utf8");
if (/\.mjs['"]/.test(left)) throw new Error("a .mjs import is left in the copy");

console.log(`Synced ${src} -> ${out}`);
