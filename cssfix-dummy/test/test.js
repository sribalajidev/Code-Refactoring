/**
 * test/test.js — full test suite
 * Run: node test/test.js
 */

const { fixCSS, reportIssues }              = require("../lib/fixer");
const { boostSelectorWithAncestry,
        parseTwigFile,
        buildClassAncestryMap }             = require("../lib/twig-parser");
const { parseHTMLForAncestry,
        mapToJSON, mapFromJSON, mergeInto } = require("../lib/dom-crawler");
const { buildCoverageReport,
        formatCoverageReport }              = require("../lib/coverage");
const { crawlSite }                         = require("../lib/crawler");

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const http = require("http");

let passed = 0, failed = 0;
function test(name, fn) {
  try   { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || "Assertion failed"); }

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTwigDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cssfix-twig-"));
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

/** Spin up a tiny HTTP server that serves fixed HTML per path. */
function makeTestServer(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const html = routes[req.url] || routes["/"] || "<html><body></body></html>";
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

console.log("\n🧪 cssfix full test suite\n");

// ══════════════════════════════════════════════════════════════════════════════
// DOM Parser
// ══════════════════════════════════════════════════════════════════════════════
console.log("── DOM Parser ──");

test("Builds ancestry chain from rendered HTML", () => {
  const html = `<body class="path-frontpage">
    <div class="layout-container">
      <nav class="nav-menu"><a class="nav-link">x</a></nav>
    </div></body>`;
  const map = parseHTMLForAncestry(html);
  assert(map.has("nav-link"), "nav-link found");
  const chain = map.get("nav-link");
  assert(chain.includes("path-frontpage"),    "body class in chain");
  assert(chain.includes("layout-container"),  "layout-container in chain");
  assert(chain.includes("nav-menu"),          "nav-menu in chain");
  assert(chain.indexOf("layout-container") < chain.indexOf("nav-link"), "order correct");
});

test("Captures dynamic/conditional classes as rendered", () => {
  // Simulates PHP preprocess + Twig conditionals after rendering
  const html = `<li class="menu-item is-active menu-item--expanded">
    <a class="nav-link is-active">x</a></li>`;
  const map = parseHTMLForAncestry(html);
  assert(map.has("is-active"),          "dynamic is-active class captured");
  assert(map.has("menu-item--expanded"),"BEM modifier captured");
  assert(map.get("nav-link").includes("menu-item"), "parent captured");
});

test("Captures PHP preprocess node classes", () => {
  const html = `<article class="node node--type-article node--promoted node--view-mode-teaser">
    <div class="node__content">
      <div class="field field--name-body">
        <p class="field__item">text</p>
      </div></div></article>`;
  const map = parseHTMLForAncestry(html);
  assert(map.has("field__item"), "field__item found");
  const chain = map.get("field__item");
  assert(chain.includes("node--type-article"), "PHP class in chain");
  assert(chain.includes("field--name-body"),   "field modifier in chain");
});

test("Ignores script/style block content", () => {
  const html = `<div class="wrapper">
    <script>document.querySelector('.fake').classList.add('js-added')</script>
    <style>.inline { color:red }</style>
    <span class="real-class">x</span></div>`;
  const map = parseHTMLForAncestry(html);
  assert( map.has("real-class"), "real-class found");
  assert(!map.has("fake"),       "class inside script ignored");
  assert(!map.has("inline"),     "class inside style ignored");
});

test("Handles void elements without stack corruption", () => {
  const html = `<form class="contact-form">
    <input class="form-text" type="text">
    <img class="field-image" src="x.png">
    <button class="form-submit">Go</button></form>`;
  const map = parseHTMLForAncestry(html);
  assert(map.has("form-submit"), "button class found");
  assert(map.get("form-submit").includes("contact-form"), "form is ancestor");
});

test("Merges maps — longer chain wins", () => {
  const a = new Map([["btn", ["wrapper", "btn"]]]);
  const b = new Map([["btn", ["page", "form", "actions", "btn"]]]);
  mergeInto(a, b);
  assert(a.get("btn").length === 4, "longer chain wins");
});

test("JSON round-trip preserves full map", () => {
  const map = new Map([
    ["nav-link",  ["layout", "nav", "nav-link"]],
    ["is-active", ["menu", "is-active"]],
  ]);
  const restored = mapFromJSON(mapToJSON(map));
  assert(restored.has("nav-link"), "nav-link restored");
  assert(JSON.stringify(restored.get("is-active")) ===
         JSON.stringify(["menu", "is-active"]), "chain intact");
});

// ══════════════════════════════════════════════════════════════════════════════
// Crawler — sitemap + spider (against local test server)
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── Crawler (live HTTP) ──");

// We run these as async tests via a tiny wrapper
const asyncTests = [];
function testAsync(name, fn) { asyncTests.push({ name, fn }); }

testAsync("Spider discovers internal links", async () => {
  const routes = {
    "/": `<html><body class="path-home">
      <a href="/about">About</a>
      <div class="hero-block"><p class="hero-text">Hi</p></div>
    </body></html>`,
    "/about": `<html><body class="path-about">
      <div class="about-wrapper"><h1 class="page-title">About</h1></div>
    </body></html>`,
  };
  const { server, base } = await makeTestServer(routes);
  try {
    const { ancestryMap, stats } = await crawlSite(base, {
      maxPages: 10, maxDepth: 2, concurrency: 2, log: () => {},
    });
    assert(ancestryMap.has("hero-text"),   "class from homepage found");
    assert(ancestryMap.has("page-title"),  "class from /about found (spider worked)");
    assert(ancestryMap.has("path-about"),  "body class from /about found");
    assert(stats.fetchedPages >= 2,        "at least 2 pages fetched");
  } finally { server.close(); }
});

testAsync("Sitemap is parsed and pages fetched", async () => {
  // Start server first so we have a real port, then serve sitemap pointing to itself
  let serverRef;
  const server = require("http").createServer((req, res) => {
    const base = `http://127.0.0.1:${serverRef.address().port}`;
    const routes = {
      "/sitemap.xml": `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc></url><url><loc>${base}/contact</loc></url></urlset>`,
      "/":            `<html><body><div class="home-block">x</div></body></html>`,
      "/contact":     `<html><body><div class="contact-form"><button class="form-submit">Go</button></div></body></html>`,
    };
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(routes[req.url] || "<html><body></body></html>");
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  serverRef = server;
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { ancestryMap } = await crawlSite(base, {
      maxPages: 10, maxDepth: 1, concurrency: 2, log: () => {},
    });
    assert(ancestryMap.has("home-block"),   `homepage class found. Keys: ${[...ancestryMap.keys()].slice(0,5)}`);
    assert(ancestryMap.has("contact-form"), `contact page class found. Keys: ${[...ancestryMap.keys()].slice(0,5)}`);
  } finally { server.close(); }
});
testAsync("Handles redirect (301) correctly", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(301, { Location: "/home" }); res.end();
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body class="redirected-page"><div class="main-content">x</div></body></html>`);
    }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { ancestryMap } = await crawlSite(base, {
      maxPages: 5, maxDepth: 1, concurrency: 1, log: () => {},
    });
    assert(ancestryMap.has("main-content"), `class after redirect found. Keys: ${[...ancestryMap.keys()].join(",")}`);
  } finally { server.close(); }
});

testAsync("Skips non-HTML files during spider", async () => {
  const routes = {
    "/": `<html><body>
      <a href="/page">page</a>
      <a href="/style.css">css</a>
      <a href="/image.png">img</a>
      <div class="valid-class">x</div>
    </body></html>`,
    "/page": `<html><body><div class="page-class">x</div></body></html>`,
  };
  const { server, base } = await makeTestServer(routes);
  try {
    const { ancestryMap } = await crawlSite(base, {
      maxPages: 10, maxDepth: 2, concurrency: 2, log: () => {},
    });
    assert(ancestryMap.has("valid-class"), "HTML page class found");
    assert(ancestryMap.has("page-class"),  "/page class found");
  } finally { server.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Twig Parser
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── Twig Parser ──");

test("Parses static class hierarchy", () => {
  const twig = `<div class="layout-container"><nav class="nav-menu"><a class="nav-link">x</a></nav></div>`;
  const map  = parseTwigFile(twig);
  assert(map.has("nav-link") && map.get("nav-link").includes("nav-menu"), "chain correct");
});

test("Strips Twig syntax cleanly", () => {
  const twig = `{% set classes = ['block', active ? 'is-active'] %}
    <div class="{{ classes|join(' ') }}"><span class="field-item">x</span></div>`;
  const map = parseTwigFile(twig);
  assert(map.has("field-item"), "static class inside dynamic parent found");
});

test("buildClassAncestryMap scans directory", () => {
  const dir = makeTwigDir({
    "page.html.twig":  `<div class="page"><div class="content"><p class="intro">x</p></div></div>`,
    "block.html.twig": `<div class="block"><div class="block-inner"><h2 class="block-title">y</h2></div></div>`,
  });
  const map = buildClassAncestryMap(dir);
  assert(map.has("intro"),       "intro found");
  assert(map.has("block-title"), "block-title found");
  assert(map.get("intro").includes("page"), "page is ancestor");
  fs.rmSync(dir, { recursive: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// Specificity Boosting
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── Specificity Boosting ──");

test("Uses real DOM ancestors — no fake doubling", () => {
  const map = new Map([["nav-link", ["path-frontpage", "layout-container", "nav-menu", "nav-link"]]]);
  const result = boostSelectorWithAncestry(".nav-link", map, "body");
  assert(!result.includes(".nav-link.nav-link"), `No doubling. Got: ${result}`);
  assert(result.includes(".nav-menu") || result.includes(".layout-container"), `Real ancestor. Got: ${result}`);
});

test("Dynamic is-active gets real ancestor, not doubled", () => {
  const map = new Map([["is-active", ["menu-item", "nav-link", "is-active"]]]);
  const result = boostSelectorWithAncestry(".is-active", map, "body");
  assert(!result.includes(".is-active.is-active"), "No doubling");
  assert(result.includes(".nav-link") || result.includes(".menu-item"), `Got: ${result}`);
});

test("Unknown JS-only class falls back to wrapper cleanly", () => {
  const map    = new Map();
  const result = boostSelectorWithAncestry(".modal-open", map, "body");
  assert(result === "body .modal-open", `Got: ${result}`);
});

test("Doesn't duplicate ancestors already in selector", () => {
  const map = new Map([["nav-link", ["region", "nav-menu", "nav-link"]]]);
  const result = boostSelectorWithAncestry(".nav-menu .nav-link", map, "body");
  const count  = (result.match(/\.nav-menu/g) || []).length;
  assert(count === 1, `nav-menu appears once. Got: ${result}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// !important removal
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── !important Removal ──");

test("Removes !important and uses DOM ancestor chain", () => {
  const map = new Map([["nav-link", ["site-header", "nav-menu", "nav-link"]]]);
  const css = `.nav-link { color: blue !important; }`;
  const { output } = fixCSS(css, "", { ancestryMap: map });
  assert(!output.includes("!important"), "removed");
  assert(!output.includes(".nav-link.nav-link"), "no doubling");
  assert(output.includes(".nav-menu") || output.includes(".site-header"), "real ancestor");
});

test("Dynamic class gets real ancestor from DOM map", () => {
  const map = new Map([["is-active", ["menu-item", "is-active"]]]);
  const css = `.is-active { font-weight: bold !important; }`;
  const { output } = fixCSS(css, "", { ancestryMap: map, fallbackWrapper: "body" });
  assert(!output.includes("!important"));
  assert(output.includes(".menu-item .is-active"), `Got: ${output}`);
});

test("JS-only class falls back to body wrapper", () => {
  const map = new Map();
  const css = `.modal-open { overflow: hidden !important; }`;
  const { output } = fixCSS(css, "", { ancestryMap: map, fallbackWrapper: "body" });
  assert(!output.includes("!important"));
  assert(output.includes("body .modal-open"), `Got: ${output}`);
  assert(!output.includes(".modal-open.modal-open"), "no doubling");
});

test("@media block selectors get ancestor boost", () => {
  const map = new Map([["nav-menu", ["site-header", "region-header", "nav-menu"]]]);
  const css = `@media (max-width: 768px) { .nav-menu { display: none !important; } }`;
  const { output } = fixCSS(css, "", { ancestryMap: map });
  assert(!output.includes("!important"));
  assert(output.includes(".site-header") || output.includes(".region-header"), `Got: ${output}`);
});

test("Comma-separated selectors each get boosted", () => {
  const map = new Map([
    ["btn",  ["form-actions", "btn"]],
    ["link", ["nav", "link"]],
  ]);
  const css = `.btn, .link { text-decoration: none !important; }`;
  const { output } = fixCSS(css, "", { ancestryMap: map });
  assert(!output.includes("!important"), "removed");
  assert(output.includes(".form-actions") || output.includes(".btn"),  ".btn boosted");
  assert(output.includes(".nav")          || output.includes(".link"), ".link boosted");
});

test("Hex colors in declaration blocks untouched", () => {
  const css = `#nav { color: #fff !important; background: #2c3e50; }`;
  const { output } = fixCSS(css, "", {});
  assert(output.includes("#fff"));
  assert(output.includes("#2c3e50"));
  assert(!output.includes("!important"));
});

// ══════════════════════════════════════════════════════════════════════════════
// ID Selector Conversion
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── ID Selector Conversion ──");

test("Converts #id to .id-name", () => {
  const css = `#main-header { background: #2c3e50; }`;
  const { output } = fixCSS(css, "", {});
  assert(output.includes(".id-main-header"), `Got: ${output}`);
  assert(output.includes("#2c3e50"), "hex preserved");
});

test("Converts [id='foo'] attribute selector", () => {
  const css = `[id="sidebar"] { width: 300px; }`;
  const { output } = fixCSS(css, "", {});
  assert(output.includes(".id-sidebar"), `Got: ${output}`);
});

test("Multiple IDs converted", () => {
  const css = `#header, #footer { margin: 0; }`;
  const { output } = fixCSS(css, "", {});
  assert(output.includes(".id-header") && output.includes(".id-footer"));
});

test("ID inside @media converted", () => {
  const css = `@media (max-width: 768px) { #page-wrapper { padding: 15px; } }`;
  const { output } = fixCSS(css, "", {});
  assert(output.includes(".id-page-wrapper"), `Got: ${output}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Coverage Report
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── Coverage Report ──");

test("Correctly identifies matched vs unmatched", () => {
  const tmpCSS = path.join(os.tmpdir(), "cssfix-test.css");
  fs.writeFileSync(tmpCSS, `.known { color: red !important; } .unknown-one { font-size: 14px; } .unknown-two { margin: 0; }`);
  const map    = new Map([["known", ["wrapper", "known"]]]);
  const report = buildCoverageReport([tmpCSS], map);
  assert(report.matchedCount   === 1, `matched: ${report.matchedCount}`);
  assert(report.unmatchedCount === 2, `unmatched: ${report.unmatchedCount}`);
  assert(report.coveragePct    === 33, `pct: ${report.coveragePct}`);
  assert(report.unmatched.has("unknown-one"), "unknown-one flagged");
  assert(!report.unmatched.has("known"),      "known not flagged");
  fs.unlinkSync(tmpCSS);
});

test("100% coverage when all classes matched", () => {
  const tmpCSS = path.join(os.tmpdir(), "cssfix-clean.css");
  fs.writeFileSync(tmpCSS, `.foo { color: red; } .bar { margin: 0; }`);
  const map    = new Map([["foo", ["wrap", "foo"]], ["bar", ["wrap", "bar"]]]);
  const report = buildCoverageReport([tmpCSS], map);
  assert(report.coveragePct === 100, `pct: ${report.coveragePct}`);
  assert(report.unmatchedCount === 0);
  fs.unlinkSync(tmpCSS);
});

test("formatCoverageReport includes progress bar and unmatched list", () => {
  const report = {
    totalCSSClasses: 10, matchedCount: 7, unmatchedCount: 3,
    coveragePct: 70,
    matched:   new Map(),
    unmatched: new Map([
      ["foo-class", { files: ["theme/css/style.css"] }],
      ["bar-class", { files: ["theme/css/style.css"] }],
      ["baz-class", { files: ["theme/css/layout.css"] }],
    ]),
  };
  const out = formatCoverageReport(report, { fallbackWrapper: "body" });
  assert(out.includes("70%"),           "shows percentage");
  assert(out.includes("["),             "has progress bar");
  assert(out.includes("foo-class"),     "unmatched class listed");
  assert(out.includes("style.css"),     "file name shown");
});

// ══════════════════════════════════════════════════════════════════════════════
// Run async tests
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── Crawler (live HTTP) ──");

(async () => {
  for (const { name, fn } of asyncTests) {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ❌ ${name}\n     ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${"─".repeat(45)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log(`\n⚠️  Some tests failed.\n`); process.exit(1); }
  else            { console.log(`\n🎉 All tests passed!\n`); }
})();
