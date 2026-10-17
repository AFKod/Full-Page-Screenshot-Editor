import { readdir, readFile, access } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.type, "module");
assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "clipboardWrite"]);
assert.equal(manifest.host_permissions, undefined);
for (const file of [manifest.background.service_worker, "content.js", "editor.html", "editor.css", "editor.js", ...Object.values(manifest.icons)]) await access(join(root, file));
let checked = 0;
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "test-results"].includes(entry.name)) await check(path);
    else if (/\.(m?js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
      assert.equal(result.status, 0, `${path}\n${result.stderr}`); checked++;
    }
  }
}
await check(root);
const html = await readFile(join(root, "editor.html"), "utf8");
const js = await readFile(join(root, "editor.js"), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(ids.length, new Set(ids).size, "Duplicate HTML ids");
for (const match of js.matchAll(/\$\("([a-z-]+)"\)/g)) assert(ids.includes(match[1]), `Missing element #${match[1]}`);
assert(!/<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html), "Inline script violates MV3 CSP");
console.log(`PASS: Manifest V3, permissions, ${checked} JS syntax checks, HTML element references, local assets.`);
console.log("No compilation or production dependencies required. Load this folder unpacked.");
