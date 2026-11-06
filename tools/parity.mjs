// Checks that defaults restated by hand (C++, QML) still match settings.json; gen.mjs --check
// only proves the generator agrees with itself.
//
//   node tools/parity.mjs
//
//   1. every kcfg component's generated main.xml carries exactly its settings.json entries
//   2. every `kcfg: false` component reads every declared key from C++ with the same default
//   3. every line carrying a `settings.json: <component>.<Key>` marker restates that default
//      within it or the two lines after (deliberately loose: the shapes vary too much)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const settings = JSON.parse(read("settings.json"));
const problems = [];
const fail = (msg) => problems.push(msg);

const same = (a, b) => (typeof a === "number" || typeof b === "number")
  ? Number(a) === Number(b)
  : String(a) === String(b);

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

// readEntry() arguments arrive wrapped (qBound, QStringLiteral, QString()), so parentheses are walked.
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

// Unrecognised spellings are returned as-is so they fail the comparison loudly.
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

// Keys built at run time (`QStringLiteral("Key%1").arg(i)`) name no single setting.
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
      // Any wider window starts passing on coincidences elsewhere.
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
