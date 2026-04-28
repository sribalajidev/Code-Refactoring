#!/usr/bin/env node

/**
 * cssfix — Drupal CSS refactor tool
 *
 * USAGE:
 *   cssfix <dir> scan                  ← always run this first
 *   cssfix <dir> crawl --site <url>    ← build DOM ancestry map
 *   cssfix <dir> report                ← coverage check
 *   cssfix <dir> preview               ← dry run
 *   cssfix <dir> fix                   ← apply fixes
 *   cssfix <dir> diff                  ← review changes
 *   cssfix <dir> restore               ← undo everything
 */

const fs   = require("fs");
const path = require("path");

const { scanProject, formatScanReport }     = require("./lib/scanner");
const { crawlSite }                         = require("./lib/crawler");
const { CACHE_FILENAME }                    = require("./lib/ancestry-builder");
const { fixCSS, reportIssues }              = require("./lib/fixer");
const { fixSCSS, reportSCSSIssues }         = require("./lib/scss-fixer");
const { buildCoverageReport,
        formatCoverageReport }              = require("./lib/coverage");
const { mapToJSON, mapFromJSON, mergeInto } = require("./lib/dom-crawler");
const { formatReport }                      = require("./lib/reporter");
const git                                   = require("./lib/git");

// ─── Args ─────────────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
if (rawArgs.length < 2 || rawArgs.includes("--help") || rawArgs.includes("-h")) {
  printHelp(); process.exit(0);
}

const [target, command] = rawArgs;
const COMMANDS = ["scan", "crawl", "fix", "preview", "report", "diff", "restore"];

if (!COMMANDS.includes(command)) {
  console.error(`❌ Unknown command: "${command}". Valid: ${COMMANDS.join(", ")}`);
  process.exit(1);
}

if (!fs.existsSync(target)) {
  console.error(`❌ Path not found: "${target}"`); process.exit(1);
}

const opts = parseFlags(rawArgs.slice(2));
const cwd  = process.cwd();
const inGit = git.isGitRepo(cwd);

run().catch(e => { console.error(`\n❌ Fatal: ${e.message}\n${e.stack}`); process.exit(1); });

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {

  // ── SCAN ──────────────────────────────────────────────────────────────────
  if (command === "scan") {
    const result = scanProject(path.resolve(target));
    console.log(formatScanReport(result));

    // Persist scan result so other commands can use it
    const scanCache = path.join(cwd, ".cssfix-scan.json");
    fs.writeFileSync(scanCache, JSON.stringify({
      projectType:     result.projectType,
      buildCommand:    result.buildCommand,
      buildOutputDirs: result.buildOutputDirs,
      scannedAt:       new Date().toISOString(),
    }, null, 2));

    return;
  }

  // ── Load scan result if available ─────────────────────────────────────────
  let scanResult = null;
  const scanCachePath = path.join(cwd, ".cssfix-scan.json");
  if (fs.existsSync(scanCachePath)) {
    try {
      scanResult = JSON.parse(fs.readFileSync(scanCachePath, "utf8"));
    } catch (_) {}
  }

  // Determine whether we're working with SCSS or CSS
  // --scss flag forces SCSS mode, otherwise infer from scan or file extensions
  const isScssMode = opts.scss ||
    (scanResult && (scanResult.projectType === "scss" || scanResult.projectType === "mixed")) ||
    hasSCSSFiles(target);

  // ── RESTORE ───────────────────────────────────────────────────────────────
  if (command === "restore") {
    const files  = getSourceFiles(target, isScssMode);
    const bakFiles = files.filter(f => fs.existsSync(f + ".bak"));

    if (bakFiles.length === 0) {
      console.log(`\n⚠️  No .bak files found — nothing to restore`);
      if (inGit) console.log(`   Try: git checkout -- ${target}`);
      return;
    }

    console.log(`\n♻️  Restoring ${bakFiles.length} file(s) from .bak backups...\n`);
    for (const f of bakFiles) {
      fs.copyFileSync(f + ".bak", f);
      fs.unlinkSync(f + ".bak");
      console.log(`  ✅ Restored: ${shorten(f)}`);
    }
    console.log(`\n✅ Restore complete — all .bak files removed`);
    if (inGit) console.log(`   Run: git diff ${target}  to confirm clean`);
    return;
  }

  // ── DIFF ──────────────────────────────────────────────────────────────────
  if (command === "diff") {
    const files = getSourceFiles(target, isScssMode);
    console.log(`\n📋 Diff for ${shorten(target)}:\n`);
    const hadGitDiff = inGit && git.showDiff(files, cwd);
    if (!hadGitDiff) {
      const hadBakDiff = git.showBakDiff(files);
      if (!hadBakDiff) console.log(`   No differences found — run "fix" first`);
    }
    if (inGit) {
      console.log(`\n💡 Also visible in:`);
      console.log(`   git diff ${target}`);
      console.log(`   VSCode source control panel (Ctrl+Shift+G)`);
      console.log(`   PHPStorm → Git → Show Diff`);
    }
    return;
  }

  // ── CRAWL ─────────────────────────────────────────────────────────────────
  if (command === "crawl") {
    if (!opts.site) {
      console.error(`❌ --site <url> is required\n   Example: cssfix . crawl --site http://localhost`);
      process.exit(1);
    }

    const { ancestryMap, classPageMap, stats, crawledURLs } = await crawlSite(opts.site, {
      maxPages: opts.maxPages, maxDepth: opts.maxDepth, concurrency: opts.concurrency,
      basicAuth: opts.auth, ignoreTLS: opts.ignoreTLS,
      extraURLs: opts.urls, log: console.log,
    });

    if (opts.twig && fs.existsSync(opts.twig)) {
      const { buildClassAncestryMap } = require("./lib/twig-parser");
      console.log(`\n🌿 Supplementing with Twig: ${opts.twig}`);
      const twigMap = buildClassAncestryMap(opts.twig);
      let added = 0;
      for (const [cls, chain] of twigMap)
        if (!ancestryMap.has(cls)) { ancestryMap.set(cls, chain); added++; }
      console.log(`   +${added} classes from Twig not in DOM`);
    }

    const cacheData = {
      ancestryMap:  Object.fromEntries(ancestryMap),
      classPageMap: Object.fromEntries(classPageMap),
      crawledURLs, crawledAt: new Date().toISOString(), stats,
    };
    fs.writeFileSync(opts.cache, JSON.stringify(cacheData, null, 2), "utf8");
    console.log(`\n💾 Cache saved: ${opts.cache} (${ancestryMap.size} classes, ${crawledURLs.length} pages)`);

    // Quick coverage snapshot
    const cssFiles = getSourceFiles(target, false); // CSS only for coverage
    if (cssFiles.length > 0) {
      const report = buildCoverageReport(cssFiles, ancestryMap, classPageMap);
      console.log(formatCoverageReport(report, { fallbackWrapper: opts.wrapper }));
    }

    console.log(`\n✅ Done. Next: cssfix ${target} report`);
    return;
  }

  // ── Load ancestry map ──────────────────────────────────────────────────────
  let ancestryMap = new Map(), classPageMap = new Map();

  if (opts.cache && fs.existsSync(opts.cache)) {
    try {
      const raw    = JSON.parse(fs.readFileSync(opts.cache, "utf8"));
      ancestryMap  = new Map(Object.entries(raw.ancestryMap  || {}));
      classPageMap = new Map(Object.entries(raw.classPageMap || {}));
      const age    = raw.crawledAt
        ? Math.round((Date.now() - new Date(raw.crawledAt)) / 3600000) : null;
      console.log(`📦 Cache: ${ancestryMap.size} classes${age !== null ? ` (${age}h ago)` : ""}`);
      if (age > 24) console.log(`   ⚠️  Cache is ${age}h old — consider re-crawling`);
    } catch (e) { console.warn(`⚠️  Cache load failed: ${e.message}`); }
  } else {
    console.warn(`⚠️  No cache found — run "cssfix . crawl --site <url>" first`);
    console.warn(`   Specificity will use fallback wrapper: "${opts.wrapper}"`);
  }

  if (opts.twig && fs.existsSync(opts.twig)) {
    const { buildClassAncestryMap } = require("./lib/twig-parser");
    const twigMap = buildClassAncestryMap(opts.twig);
    let added = 0;
    for (const [cls, chain] of twigMap)
      if (!ancestryMap.has(cls)) { ancestryMap.set(cls, chain); added++; }
    if (added > 0) console.log(`🌿 +${added} classes from Twig`);
  }

  // ── REPORT ────────────────────────────────────────────────────────────────
  if (command === "report") {
    const cssFiles  = getSourceFiles(target, false);
    const scssFiles = isScssMode ? getSourceFiles(target, true).filter(f => f.endsWith(".scss")) : [];

    console.log(`\n📄 Report — ${cssFiles.length} CSS + ${scssFiles.length} SCSS file(s)\n`);

    // Per-file issue count
    for (const f of cssFiles) {
      const issues = reportIssues(fs.readFileSync(f, "utf8"));
      if (issues.importantCount > 0 || issues.idSelectorCount > 0)
        console.log(`  📄 ${shorten(f)}: ${issues.importantCount} !important, ${issues.idSelectorCount} IDs`);
    }
    for (const f of scssFiles) {
      const issues = reportSCSSIssues(fs.readFileSync(f, "utf8"));
      if (issues.importantCount > 0 || issues.idCount > 0) {
        console.log(`  📄 ${shorten(f)}: ${issues.importantCount} !important` +
          `${issues.inMixinCount > 0 ? ` (${issues.inMixinCount} in mixin ⚠️ )` : ""}` +
          `, ${issues.idCount} IDs`);
      }
    }

    // Coverage report (CSS only — SCSS compiled to different classes)
    if (cssFiles.length > 0) {
      const report = buildCoverageReport(cssFiles, ancestryMap, classPageMap);
      console.log(formatCoverageReport(report, { fallbackWrapper: opts.wrapper }));
    }

    if (isScssMode) {
      console.log(`\n💡 SCSS mode: fix will edit .scss source files`);
      console.log(`   After fix, recompile with: ${scanResult?.buildCommand || "yarn build / npm run build"}`);
    }
    return;
  }

  // ── FIX / PREVIEW ─────────────────────────────────────────────────────────
  const sourceFiles = getSourceFiles(target, isScssMode);
  if (sourceFiles.length === 0) {
    console.log(`No ${isScssMode ? "SCSS" : "CSS"} files found in: ${target}`);
    return;
  }

  if (isScssMode) console.log(`\n🎨 SCSS mode — editing source files (not compiled output)\n`);

  // Git stash before fix
  let didStash = false;
  if (command === "fix" && inGit && opts.stash) {
    if (!git.isWorkingTreeClean(cwd)) {
      console.log(`\n📦 Stashing uncommitted changes before fix...`);
      try {
        const { stashed } = git.stash(cwd);
        if (stashed) { didStash = true; console.log(`   ✅ Stashed`); }
      } catch (e) { console.warn(`   ⚠️  Stash failed: ${e.message}`); }
    }
  }

  let totalFixed = 0, totalImportant = 0, totalIDs = 0;
  const fixedFiles = [];
  const allSkipped = []; // mixin/loop lines needing manual review

  for (const filePath of sourceFiles) {
    const source    = fs.readFileSync(filePath, "utf8");
    const isScss    = filePath.endsWith(".scss") || filePath.endsWith(".sass");
    const issues    = isScss
      ? reportSCSSIssues(source)
      : reportIssues(source);
    const hasIssues = isScss
      ? (issues.importantCount > 0 || issues.idCount > 0)
      : (issues.importantCount > 0 || issues.idSelectorCount > 0);

    if (!hasIssues) {
      if (command === "fix") console.log(`✅ ${shorten(filePath)} — clean`);
      continue;
    }

    let output, log, skipped = [];

    if (isScss) {
      ({ output, log, skipped } = fixSCSS(source, filePath, { ancestryMap, fallbackWrapper: opts.wrapper }));
      if (skipped.length > 0) allSkipped.push({ file: filePath, lines: skipped });
    } else {
      ({ output, log } = fixCSS(source, filePath, { ancestryMap, fallbackWrapper: opts.wrapper }));
    }

    if (command === "preview") {
      console.log(`\n📄 ${shorten(filePath)} [${isScss ? "SCSS" : "CSS"}]`);
      log.forEach(e => console.log(e));
      if (skipped.length > 0) {
        console.log(`   ⚠️  ${skipped.length} line(s) need manual review (inside mixin/loop):`);
        skipped.slice(0, 3).forEach(s => console.log(`      L${s.line}: ${s.code}`));
      }
      const ic = isScss ? issues.importantCount : issues.importantCount;
      const idc = isScss ? issues.idCount : issues.idSelectorCount;
      console.log(`   → ${ic} !important, ${idc} IDs would change\n`);
      continue;
    }

    // Write backup and fixed file
    fs.writeFileSync(filePath + ".bak", source, "utf8");
    fs.writeFileSync(filePath, output, "utf8");
    fixedFiles.push(filePath);
    totalFixed++;
    totalImportant += isScss ? issues.importantCount : issues.importantCount;
    totalIDs       += isScss ? issues.idCount : issues.idSelectorCount;

    const ic  = isScss ? issues.importantCount : issues.importantCount;
    const idc = isScss ? issues.idCount : issues.idSelectorCount;
    const warn = skipped.length > 0 ? ` ⚠️  ${skipped.length} line(s) skipped (manual review needed)` : "";
    console.log(`✅ ${shorten(filePath)} — ${ic} !important, ${idc} IDs${warn}`);
  }

  if (command === "fix" && totalFixed > 0) {
    console.log(`\n🎉 Fixed ${totalFixed} file(s) — ${totalImportant} !important(s), ${totalIDs} ID(s)`);
    console.log(`   .bak backups created next to each modified file`);

    // Show diff
    if (opts.diff) {
      console.log(`\n${"─".repeat(55)}\n📋 What changed:\n${"─".repeat(55)}`);
      const hadGitDiff = inGit && git.showDiff(fixedFiles, cwd);
      if (!hadGitDiff) git.showBakDiff(fixedFiles);
    }

    // Mixin/loop manual review warnings
    if (allSkipped.length > 0) {
      console.log(`\n${"─".repeat(55)}`);
      console.log(`⚠️  Manual review needed — ${allSkipped.reduce((a, f) => a + f.lines.length, 0)} line(s) skipped:`);
      for (const { file, lines } of allSkipped) {
        console.log(`\n   📄 ${shorten(file)}`);
        for (const s of lines.slice(0, 5)) {
          console.log(`      L${s.line}: ${s.code}`);
          console.log(`      Reason: ${s.reason}`);
        }
      }
      console.log(`\n   These are inside @mixin or @each/@for — auto-removal is unsafe.`);
      console.log(`   Check each one manually and decide if !important should be removed.`);
    }

    // SCSS rebuild reminder
    if (isScssMode && scanResult?.buildCommand) {
      console.log(`\n${"─".repeat(55)}`);
      console.log(`🔧 SCSS files edited — recompile now:`);
      console.log(`   ${scanResult.buildCommand}`);
    }

    // Undo instructions
    console.log(`\n${"─".repeat(55)}`);
    console.log(`📌 Review & undo:`);
    if (inGit) {
      console.log(`   git diff                     ← in terminal`);
      console.log(`   git diff ${target}           ← scoped to this dir`);
      console.log(`   (VSCode: Ctrl+Shift+G / PHPStorm: Git panel)`);
    }
    console.log(`   cssfix ${target} diff          ← in terminal via cssfix`);
    console.log(`\n   To UNDO:`);
    console.log(`   cssfix ${target} restore       ← revert from .bak files`);
    if (didStash) console.log(`   git stash pop                ← restore pre-fix working state`);
    else if (inGit) console.log(`   git checkout -- ${target}  ← revert via git`);

    // Auto-commit
    if (opts.commit && inGit) {
      try {
        git.commitFixes(fixedFiles, cwd);
        console.log(`\n📝 Committed: "refactor(css): remove !important and ID selectors via cssfix"`);
      } catch (e) { console.warn(`\n⚠️  Commit failed: ${e.message}`); }
    }
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function getSourceFiles(target, scssMode) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return [target];

  const all = collectFiles(target);
  if (scssMode) {
    // SCSS mode: return .scss files, exclude partials starting with _
    // and exclude compiled output dirs
    const scssFiles = all.filter(f =>
      (f.endsWith(".scss") || f.endsWith(".sass")) &&
      !path.basename(f).startsWith("_") &&      // partials are @imported, not compiled directly
      !f.includes("node_modules")
    );
    // Also include plain .css files that are NOT in known output dirs
    return scssFiles;
  }
  // CSS mode
  return all.filter(f => f.endsWith(".css") && !f.endsWith(".min.css") && !f.includes("node_modules"));
}

function hasSCSSFiles(target) {
  try {
    return collectFiles(target).some(f => f.endsWith(".scss") || f.endsWith(".sass"));
  } catch (_) { return false; }
}

function collectFiles(dir, results = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", "vendor", ".git"].includes(e.name))
        collectFiles(full, results);
    } else {
      results.push(full);
    }
  }
  return results;
}

function shorten(p) {
  const parts = p.replace(cwd, "").split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

function parseFlags(args) {
  const opts = {
    site: null, urls: [], twig: null,
    wrapper: "body", cache: CACHE_FILENAME,
    auth: null, ignoreTLS: false,
    maxPages: 80, maxDepth: 4, concurrency: 5,
    stash: true, diff: true, commit: false, scss: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if      (a === "--site"      && args[i+1]) opts.site      = args[++i];
    else if (a === "--url"       && args[i+1]) opts.urls.push(args[++i]);
    else if (a === "--twig"      && args[i+1]) opts.twig      = args[++i];
    else if (a === "--wrapper"   && args[i+1]) opts.wrapper   = args[++i];
    else if (a === "--cache"     && args[i+1]) opts.cache     = args[++i];
    else if (a === "--auth"      && args[i+1]) opts.auth      = args[++i];
    else if (a === "--max-pages" && args[i+1]) opts.maxPages  = parseInt(args[++i]);
    else if (a === "--max-depth" && args[i+1]) opts.maxDepth  = parseInt(args[++i]);
    else if (a === "--ignore-tls")  opts.ignoreTLS = true;
    else if (a === "--no-stash")    opts.stash     = false;
    else if (a === "--no-diff")     opts.diff      = false;
    else if (a === "--commit")      opts.commit    = true;
    else if (a === "--scss")        opts.scss      = true;
    else if (a === "--no-cache")    opts.cache     = null;
  }
  return opts;
}

function printHelp() {
  console.log(`
cssfix — Drupal CSS/SCSS refactor tool

COMMANDS:
  scan       Detect project type, build system, where issues are  ← START HERE
  crawl      Crawl live site + cache DOM ancestry
  report     Coverage + issue summary
  preview    Dry-run, no files changed
  fix        Apply fixes (auto git stash + shows diff after)
  diff       Show what changed (git diff or .bak comparison)
  restore    Revert all files from .bak backups

WORKFLOW — plain CSS project:
  cssfix . scan
  cssfix . crawl --site http://localhost --twig ./templates
  cssfix ./css report
  cssfix ./css fix
  cssfix ./css diff
  cssfix ./css restore   ← if needed

WORKFLOW — SCSS project:
  cssfix . scan                                     ← detects SCSS + build system
  cssfix . crawl --site http://localhost --twig ./templates
  cssfix ./scss report
  cssfix ./scss fix                                 ← edits .scss source files
  yarn build                                        ← recompile
  cssfix ./scss diff                                ← review
  cssfix ./scss restore                             ← undo if needed

OPTIONS:
  --site <url>        Base URL for crawl (required)
  --url <url>         Extra URLs (repeatable)
  --twig <dir>        Templates dir
  --wrapper <sel>     Fallback selector (default: body)
  --max-pages <n>     Crawl limit (default: 80)
  --max-depth <n>     Spider depth (default: 4)
  --scss              Force SCSS mode
  --no-stash          Skip auto git stash
  --no-diff           Skip diff after fix
  --commit            Auto git commit after fix
  --auth <user:pass>  HTTP Basic auth
  --ignore-tls        Skip TLS check (ddev/lando)
`);
}
