// Every English text in app.js, logic.js and index.html has a Bahasa Melayu version in
// docs/i18n.ms.js, and translations keep the same HTML tags. Run: node --test tests/i18n.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const docs = path.join(__dirname, "..", "docs");
global.window = {};
require(path.join(docs, "i18n.ms.js"));
const MS = global.window.I18N_MS;

function literals(src, fn) {
  const out = [], re = new RegExp("\\b" + fn + "\\((\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')\\)", "g");
  let m;
  while ((m = re.exec(src))) out.push(Function("return " + m[1])());
  return out;
}

test("every wrapped text has a Bahasa Melayu translation", () => {
  const missing = [];
  [["app.js", "i18"], ["logic.js", "tr"]].forEach(([f, fn]) => {
    literals(fs.readFileSync(path.join(docs, f), "utf8"), fn).forEach((k) => { if (!(k in MS)) missing.push(f + ": " + k); });
  });
  const html = fs.readFileSync(path.join(docs, "index.html"), "utf8");
  const tagged = /<(\w+)[^>]*?\sdata-t(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = tagged.exec(html))) if (!(m[2].trim() in MS)) missing.push("index.html: " + m[2].trim());
  assert.deepEqual(missing, []);
});

test("translations keep the HTML tags and spacing of the English text", () => {
  const tags = (s) => (s.match(/<[^>]+>/g) || []).join("|");
  const bad = Object.keys(MS).filter((k) => tags(k) !== tags(MS[k]));
  assert.deepEqual(bad, []);
});
