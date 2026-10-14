// Checks that settings.json is still the one place a default is decided.
//
//   node tools/parity.mjs
//
// It asks three questions, and the second is the one that pays for the file. `tools/gen.mjs
// --check` already proves the generated kcfg files equal what the generator would write today --
// but that is a check of the generator against itself, and it says nothing about the defaults
// written by hand in another language, in another file, compiled by another toolchain:
// `outline.cpp` reads `readEntry("Thickness", 3)` and `main.qml` opens at `hintThickness: 3`, and
// before this nothing at all connected those two threes to the one in settings.json. Changing the
// default in one place and not the others is silent in every direction.
//
//   1. every kcfg component's generated main.xml carries exactly its settings.json entries,
//      with the same types and defaults
//   2. every component that reads kwinrc from C++ instead -- `kcfg: false` -- reads every key
//      settings.json declares for it, with the same default
//   3. every line anywhere carrying a `settings.json: <component>.<Key>` marker restates that
//      key's default somewhere on it
//
// The third is deliberately weak: it asserts the value appears near the marker, not that it is
// the subject of anything, because the shapes it has to cover range from
// `property int hintThickness: 3` to `isNaN(n) || n < 1 ? 3 : n`. It catches the case that
// actually happens -- the default moves in settings.json and the restatement does not follow --
// and nothing finer.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const settings = JSON.parse(read("settings.json"));
const problems = [];
const fail = (msg) => problems.push(msg);

// A default as settings.json spells it, rendered the way the language under test spells it, so
// the two can be compared as strings when they are not both numbers.
const same = (a, b) => (typeof a === "number" || typeof b === "number")
  ? Number(a) === Number(b)
  : String(a) === String(b);

// ---- 1. the generated kcfg files ----
//
// Shape is fixed because gen.mjs writes it, so a regex is enough and brings no dependency.
for (const [name, c] of Object.entries(settings.components)) {
  if (!c.kcfg) continue;
  const path = `${c.path}/contents/config/main.xml`;
  let xml;
  try {
    xml = read(path);
  } catch {
    fail(`${name}: ${path} is missing`);
    continue;
  }
  const found = new Map();
  for (const m of xml.matchAll(
    /<entry name="([^"]+)" type="([^"]+)">\s*<default>([^<]*)<\/default>/g
  )) {
    found.set(m[1], { type: m[2], dflt: m[3] });
  }
  for (const [key, e] of Object.entries(c.entries)) {
    const got = found.get(key);
    if (!got) { fail(`${name}.${key}: declared in settings.json, absent from ${path}`); continue; }
    if (got.type !== e.type) {
      fail(`${name}.${key}: type ${e.type} in settings.json, ${got.type} in ${path}`);
    }
    if (!same(got.dflt, e.default)) {
      fail(`${name}.${key}: default ${JSON.stringify(e.default)} in settings.json, `
         + `${JSON.stringify(got.dflt)} in ${path}`);
    }
    found.delete(key);
  }
  for (const key of found.keys()) {
    fail(`${name}.${key}: in ${path}, declared nowhere in settings.json`);
  }
}

// ---- 2. the components that read kwinrc from C++ ----
//
// `readEntry("Key", default)` arrives wrapped in whatever the call site needed -- qBound around
// the opacity, a QStringLiteral around some keys, a QString() for an empty default -- so the two
// arguments are taken by walking the parentheses rather than by one regex that would have to
// anticipate every wrapper.
function readEntryCalls(src) {
  const calls = [];
  const needle = "readEntry(";
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
    let i = at + needle.length;
    let depth = 1;
    let inString = false;
    const args = [""];
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (inString) {
        if (ch === "\\") { args[args.length - 1] += ch + src[++i]; continue; }
        if (ch === '"') inString = false;
        args[args.length - 1] += ch;
        continue;
      }
      if (ch === '"') { inString = true; args[args.length - 1] += ch; continue; }
      if (ch === "(") depth++;
      if (ch === ")") { depth--; if (depth === 0) break; }
      if (ch === "," && depth === 1) { args.push(""); continue; }
      args[args.length - 1] += ch;
    }
    if (depth === 0 && args.length === 2) calls.push(args.map((a) => a.trim()));
  }
  return calls;
}

// The C++ spelling of a default, back to what settings.json would hold. Anything not recognised
// is returned as-is and will fail the comparison loudly, which is the right outcome: a default
// this cannot read is a default nothing is checking.
function fromCpp(text) {
  const t = text.trim();
  if (t === "QString()" || t === "QString{}" || t === '""') return "";
  if (t === "true") return true;
  if (t === "false") return false;
  const str = t.match(/^(?:QStringLiteral\(\s*)?"(.*)"\s*\)?$/s);
  if (str) return str[1];
  if (/^-?\d+$/.test(t)) return Number(t);
  return t;
}

// A key whose name is built at run time -- `QStringLiteral("Key%1").arg(i)` -- names no single
// setting and is not settings.json's business.
const literalKey = (text) => {
  const m = text.trim().match(/^(?:QStringLiteral\(\s*)?"([A-Za-z0-9_]+)"\s*\)?$/);
  return m ? m[1] : null;
};

function sourcesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(join(ROOT, d))) {
      const rel = `${d}/${entry}`;
      if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue; }
      if ([".cpp", ".h"].includes(extname(entry))) out.push(rel);
    }
  };
  walk(dir);
  return out;
}

for (const [name, c] of Object.entries(settings.components)) {
  if (c.kcfg) continue;
  const seen = new Map();
  for (const file of sourcesUnder(c.path)) {
    for (const [keyArg, dfltArg] of readEntryCalls(read(file))) {
      const key = literalKey(keyArg);
      if (key && !seen.has(key)) seen.set(key, { file, dflt: fromCpp(dfltArg) });
    }
  }
  for (const [key, e] of Object.entries(c.entries)) {
    const got = seen.get(key);
    if (!got) {
      fail(`${name}.${key}: declared in settings.json, read by nothing under ${c.path}/`);
      continue;
    }
    if (!same(got.dflt, e.default)) {
      fail(`${name}.${key}: default ${JSON.stringify(e.default)} in settings.json, `
         + `${JSON.stringify(got.dflt)} in ${got.file}`);
    }
  }
}

// ---- 3. the defaults restated outside a generated file ----
//
// The applet opens its thickness slider before it has read anything, so it carries the plugin's
// default itself. Any such restatement declares which key it is restating, and this keeps it
// honest. Scanned over the tree rather than over a list of files so that a new one is covered the
// moment it is written.
const MARKER = /settings\.json:\s*([A-Za-z0-9-]+)\.([A-Za-z0-9_]+)/g;
const SKIP = new Set([".git", "build", "node_modules", "LICENSES", ".github"]);

function textFilesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(join(ROOT, d || "."))) {
      if (SKIP.has(entry)) continue;
      const rel = d ? `${d}/${entry}` : entry;
      if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue; }
      if ([".qml", ".js", ".mjs", ".cpp", ".h", ".sh"].includes(extname(entry))) out.push(rel);
    }
  };
  walk("");
  return out;
}

let markers = 0;
for (const file of textFilesUnder("")) {
  if (file === "tools/parity.mjs") continue; // the pattern above is not a restatement
  const lines = read(file).split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(MARKER)) {
      markers++;
      const [, comp, key] = m;
      const entry = settings.components[comp]?.entries?.[key];
      if (!entry) {
        fail(`${file}:${i + 1}: marker names ${comp}.${key}, which settings.json does not declare`);
        continue;
      }
      // The marker and the value it guards are usually not on the same line: the comment style
      // here is a paragraph above the code, so the window is the marker's line and the two after
      // it. Wider than that and the check starts passing on a coincidence somewhere else.
      const window = lines.slice(i, i + 3).join("\n").replaceAll(m[0], "");
      const want = String(entry.default);
      const present = want === ""
        ? /""|''|QString\(\)/.test(window)
        : new RegExp(`(^|[^\\w.-])${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w.]|$)`)
            .test(window);
      if (!present) {
        fail(`${file}:${i + 1}: restates ${comp}.${key} but neither it nor the two lines after `
           + `it carry its default ${JSON.stringify(entry.default)}`);
      }
    }
  });
}

const keys = Object.values(settings.components)
  .reduce((n, c) => n + Object.keys(c.entries).length, 0);

if (problems.length) {
  console.error("settings.json parity:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`   ${keys} keys paired, ${markers} restatements checked`);
