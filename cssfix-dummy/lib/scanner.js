/**
 * lib/scanner.js
 *
 * Scans an unknown Drupal theme codebase before any fixes are applied.
 * Detects project type, build system, source vs compiled files,
 * and exactly where !important and ID selectors live.
 *
 * Output is a structured report — no files are modified.
 */

const fs   = require("fs");
const path = require("path");

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan a directory and return a full project profile.
 * @param {string} dir - Theme root directory
 * @returns {ScanResult}
 */
function scanProject(dir) {
  const result = {
    dir,
    projectType:  null,   // 'css-only' | 'scss' | 'less' | 'mixed'
    buildSystem:  null,   // 'yarn' | 'npm' | 'gulp' | 'grunt' | 'webpack' | null
    buildCommand: null,   // e.g. 'yarn build'
    buildOutputDirs: [],  // compiled CSS output dirs (don't edit these)
    scssSourceDirs:  [],  // SCSS source dirs (edit these for SCSS projects)
    cssDirs:         [],  // plain CSS dirs

    // Issue locations
    issues: {
      css:  [],  // { file, importantCount, idCount, mixinCount, important_in_mixin }
      scss: [],  // { file, importantCount, idCount, inMixin, inLoop, inNested }
    },

    // Summary counts
    totals: {
      cssFiles: 0, scssFiles: 0,
      cssImportant: 0, scssImportant: 0,
      cssIDs: 0, scssIDs: 0,
      compiledCSSFiles: 0,
    },

    // Warnings
    warnings: [],
    // Recommended actions
    recommendations: [],
  };

  // ── Detect build system ────────────────────────────────────────────────────
  detectBuildSystem(dir, result);

  // ── Collect all files ──────────────────────────────────────────────────────
  const allFiles = collectAllFiles(dir);
  const cssFiles  = allFiles.filter(f => f.endsWith(".css") && !f.endsWith(".min.css"));
  const scssFiles = allFiles.filter(f => f.endsWith(".scss") || f.endsWith(".sass"));
  const lessFiles = allFiles.filter(f => f.endsWith(".less"));

  // ── Detect project type ────────────────────────────────────────────────────
  if (scssFiles.length > 0 && cssFiles.length > 0)       result.projectType = "mixed";
  else if (scssFiles.length > 0)                          result.projectType = "scss";
  else if (lessFiles.length > 0)                          result.projectType = "less";
  else if (cssFiles.length > 0)                           result.projectType = "css-only";
  else                                                    result.projectType = "unknown";

  // ── Identify compiled vs source CSS ───────────────────────────────────────
  const compiledCSS = new Set();
  if (result.projectType === "mixed" || result.projectType === "scss") {
    for (const scssFile of scssFiles) {
      // For each .scss, check if a matching .css exists nearby (compiled output)
      const guesses = guessCompiledPaths(scssFile, dir);
      for (const g of guesses) {
        if (fs.existsSync(g)) compiledCSS.add(path.resolve(g));
      }
    }
    // Also detect common output dirs from build config
    for (const outDir of result.buildOutputDirs) {
      const full = path.resolve(dir, outDir);
      if (fs.existsSync(full)) {
        collectAllFiles(full)
          .filter(f => f.endsWith(".css"))
          .forEach(f => compiledCSS.add(path.resolve(f)));
      }
    }
  }

  result.totals.compiledCSSFiles = compiledCSS.size;

  // ── Scan SCSS files ────────────────────────────────────────────────────────
  for (const f of scssFiles) {
    if (f.includes("node_modules") || f.includes("vendor")) continue;
    const info = scanSCSSFile(f);
    if (info.importantCount > 0 || info.idCount > 0) {
      result.issues.scss.push(info);
      result.totals.scssImportant += info.importantCount;
      result.totals.scssIDs       += info.idCount;
    }
    result.totals.scssFiles++;
  }

  // ── Scan CSS files (excluding compiled output) ─────────────────────────────
  for (const f of cssFiles) {
    if (f.includes("node_modules") || f.includes("vendor")) continue;
    const isCompiled = compiledCSS.has(path.resolve(f));
    const info = scanCSSFile(f, isCompiled);
    if (info.importantCount > 0 || info.idCount > 0) {
      result.issues.css.push(info);
      if (!isCompiled) {
        result.totals.cssImportant += info.importantCount;
        result.totals.cssIDs       += info.idCount;
      }
    }
    result.totals.cssFiles++;
  }

  // ── Build recommendations ──────────────────────────────────────────────────
  buildRecommendations(result);

  return result;
}

// ─── Build System Detection ────────────────────────────────────────────────────

function detectBuildSystem(dir, result) {
  // package.json scripts
  const pkgPath = path.join(dir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const scripts = pkg.scripts || {};

      // Detect yarn vs npm
      const lockYarn = fs.existsSync(path.join(dir, "yarn.lock"));
      const lockNpm  = fs.existsSync(path.join(dir, "package-lock.json"));
      const runner   = lockYarn ? "yarn" : "npm run";

      // Find the build script
      const buildKeys = ["build", "compile", "sass", "css", "styles", "dist"];
      for (const key of buildKeys) {
        if (scripts[key]) {
          result.buildSystem  = lockYarn ? "yarn" : "npm";
          result.buildCommand = `${runner} ${key}`;
          break;
        }
      }

      // Detect webpack/gulp/grunt from devDependencies
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.webpack || deps["webpack-cli"])      result.buildSystem = result.buildSystem || "webpack";
      if (deps.gulp)                                result.buildSystem = result.buildSystem || "gulp";
      if (deps.grunt)                               result.buildSystem = result.buildSystem || "grunt";
      if (deps["node-sass"] || deps.sass || deps["dart-sass"]) {
        result.buildSystem = result.buildSystem || (lockYarn ? "yarn" : "npm");
      }

      // Detect output dirs from sass config in package.json
      const sassConfig = pkg.sass || pkg.sassConfig || {};
      if (sassConfig.dest || sassConfig.outDir) {
        result.buildOutputDirs.push(sassConfig.dest || sassConfig.outDir);
      }
    } catch (_) {}
  }

  // .sass-lint.yml / .sassrc / sass config files
  const sassConfigs = [".sassrc", ".sassrc.js", ".sassrc.json", "sass.config.js"];
  for (const sc of sassConfigs) {
    if (fs.existsSync(path.join(dir, sc))) {
      result.buildSystem = result.buildSystem || "sass";
    }
  }

  // gulpfile
  if (fs.existsSync(path.join(dir, "gulpfile.js")) ||
      fs.existsSync(path.join(dir, "gulpfile.babel.js"))) {
    result.buildSystem  = "gulp";
    result.buildCommand = result.buildCommand || "gulp";
    // Try to parse output dirs from gulpfile
    try {
      const gf = fs.readFileSync(path.join(dir, "gulpfile.js"), "utf8");
      const destMatches = [...gf.matchAll(/\.dest\(['"]([^'"]+)['"]\)/g)];
      for (const m of destMatches) {
        if (m[1].includes("css") || m[1].includes("dist") || m[1].includes("build")) {
          result.buildOutputDirs.push(m[1]);
        }
      }
    } catch (_) {}
  }

  // webpack.config.js
  if (fs.existsSync(path.join(dir, "webpack.config.js"))) {
    result.buildSystem = result.buildSystem || "webpack";
    try {
      const wc = fs.readFileSync(path.join(dir, "webpack.config.js"), "utf8");
      const pathMatches = [...wc.matchAll(/path\s*:\s*(?:path\.resolve\([^)]*\)|['"]([^'"]+)['"])/g)];
      for (const m of pathMatches) {
        if (m[1]) result.buildOutputDirs.push(m[1]);
      }
    } catch (_) {}
  }

  // Common Drupal theme output dirs if nothing detected
  if (result.buildOutputDirs.length === 0) {
    const commonOutputs = ["css", "dist", "dist/css", "build", "build/css", "assets/css"];
    for (const d of commonOutputs) {
      if (fs.existsSync(path.join(dir, d))) result.buildOutputDirs.push(d);
    }
  }
}

// ─── SCSS Scanner ──────────────────────────────────────────────────────────────

function scanSCSSFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const lines  = source.split("\n");
  const info   = {
    file: filePath, isCompiled: false,
    importantCount: 0, idCount: 0,
    inMixin: [], inLoop: [], inNested: [], inline: [],
    warnings: [],
  };

  let context = [];  // stack: 'mixin' | 'loop' | 'nested' | 'rule'

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const lineNo  = i + 1;
    const trimmed = line.trim();

    // Track context
    if (/^@mixin\s/.test(trimmed))       context.push("mixin");
    else if (/^@each|@for|@while/.test(trimmed)) context.push("loop");
    else if (/&/.test(trimmed) && trimmed.endsWith("{")) context.push("nested");
    else if (trimmed.endsWith("{"))      context.push("rule");

    if (trimmed === "}") context.pop();

    // Count !important
    const importantMatches = (line.match(/!important/gi) || []).length;
    if (importantMatches > 0) {
      info.importantCount += importantMatches;
      const ctx = context[context.length - 1] || "top";
      const entry = { line: lineNo, code: trimmed, context: ctx };
      if (ctx === "mixin")        info.inMixin.push(entry);
      else if (ctx === "loop")    info.inLoop.push(entry);
      else if (ctx === "nested")  info.inNested.push(entry);
      else                        info.inline.push(entry);
    }

    // Count ID selectors (in selector lines, not in values)
    if (!trimmed.startsWith("//") && !trimmed.startsWith("*")) {
      const idMatches = (trimmed.match(/(?<![a-zA-Z0-9_-])#([a-zA-Z_][a-zA-Z0-9_-]*)/g) || [])
        .filter(m => !m.match(/^#[0-9a-fA-F]{3,8}$/)); // exclude hex colors
      info.idCount += idMatches.length;
    }
  }

  return info;
}

// ─── CSS Scanner ───────────────────────────────────────────────────────────────

function scanCSSFile(filePath, isCompiled = false) {
  const source = fs.readFileSync(filePath, "utf8");
  const info   = {
    file: filePath, isCompiled,
    importantCount: (source.match(/!important/gi) || []).length,
    idCount: 0,
    warnings: [],
  };

  // Count IDs in selectors only (not in property values/hex colors)
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{[^{}]*\}/g, "");
  info.idCount = (stripped.match(/(?<![a-zA-Z0-9_-])#([a-zA-Z_][a-zA-Z0-9_-]*)/g) || []).length;

  if (isCompiled && (info.importantCount > 0 || info.idCount > 0)) {
    info.warnings.push("This appears to be compiled output — edit the SCSS source instead");
  }

  return info;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function guessCompiledPaths(scssFile, rootDir) {
  const base    = path.basename(scssFile, path.extname(scssFile));
  const scssDir = path.dirname(scssFile);

  // Skip partials (files starting with _)
  if (base.startsWith("_")) return [];

  return [
    // Same dir, .css extension
    path.join(scssDir, base + ".css"),
    // Parent dir's css/ folder
    path.join(scssDir, "..", "css", base + ".css"),
    // dist/ and build/ patterns relative to root
    path.join(rootDir, "css", base + ".css"),
    path.join(rootDir, "dist", "css", base + ".css"),
    path.join(rootDir, "dist", base + ".css"),
    path.join(rootDir, "build", "css", base + ".css"),
  ];
}

function collectAllFiles(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", "vendor", ".git"].includes(entry.name))
        collectAllFiles(full, results);
    } else {
      results.push(full);
    }
  }
  return results;
}

// ─── Recommendations ───────────────────────────────────────────────────────────

function buildRecommendations(result) {
  const r = result.recommendations;
  const w = result.warnings;
  const t = result.totals;

  if (result.projectType === "scss" || result.projectType === "mixed") {
    r.push({
      priority: "HIGH",
      action: "Fix SCSS source files, not compiled CSS",
      detail: `Found ${t.scssFiles} SCSS file(s) with ${t.scssImportant} !important(s). ` +
              `Editing compiled CSS will be overwritten on next build.`,
    });

    if (result.buildCommand) {
      r.push({
        priority: "HIGH",
        action: `Run \`${result.buildCommand}\` after fixing SCSS to recompile`,
        detail: "cssfix can run this automatically with --build-after",
      });
    }

    const mixinIssues = result.issues.scss.filter(f => f.inMixin.length > 0);
    if (mixinIssues.length > 0) {
      r.push({
        priority: "MEDIUM",
        action: "Review !important inside mixins manually",
        detail: `${mixinIssues.length} file(s) have !important inside @mixin blocks. ` +
                `Removing it may affect all places the mixin is used — review each call site.`,
      });
    }

    const loopIssues = result.issues.scss.filter(f => f.inLoop.length > 0);
    if (loopIssues.length > 0) {
      w.push(`!important inside @each/@for loops — removing it will affect all generated selectors`);
    }
  }

  if (result.projectType === "css-only") {
    r.push({
      priority: "HIGH",
      action: "Safe to fix CSS files directly",
      detail: `${t.cssFiles} plain CSS file(s) found. No build step needed.`,
    });
  }

  if (result.projectType === "mixed") {
    w.push("Mixed project: some CSS files may be compiled output from SCSS — check before editing");
    if (t.compiledCSSFiles > 0)
      w.push(`${t.compiledCSSFiles} CSS file(s) detected as compiled output — these will be skipped`);
  }

  if (t.scssImportant > 50 || t.cssImportant > 50) {
    w.push(`Large number of !important (${t.scssImportant + t.cssImportant} total) — ` +
           `run preview first and check a few files manually before committing`);
  }
}

// ─── Report Formatter ──────────────────────────────────────────────────────────

function formatScanReport(result) {
  const lines = [];
  const t     = result.totals;

  lines.push(`\n${"═".repeat(58)}`);
  lines.push(`  cssfix scan — ${path.basename(result.dir)}`);
  lines.push(`${"═".repeat(58)}`);

  // Project type
  const typeLabel = {
    "css-only": "Plain CSS (no preprocessor)",
    "scss":     "SCSS → compiled CSS",
    "less":     "LESS → compiled CSS",
    "mixed":    "Mixed (SCSS + plain CSS)",
    "unknown":  "Unknown",
  }[result.projectType] || result.projectType;

  lines.push(`\n📁 Project type : ${typeLabel}`);

  if (result.buildSystem) {
    lines.push(`🔧 Build system  : ${result.buildSystem}`);
    if (result.buildCommand)
      lines.push(`   Build command : ${result.buildCommand}`);
    if (result.buildOutputDirs.length > 0)
      lines.push(`   Output dirs   : ${result.buildOutputDirs.join(", ")}`);
  } else if (result.projectType !== "css-only") {
    lines.push(`🔧 Build system  : ⚠️  Not detected — check manually`);
  }

  // File counts
  lines.push(`\n📊 Files found:`);
  if (t.scssFiles > 0)      lines.push(`   SCSS files          : ${t.scssFiles}`);
  if (t.cssFiles > 0)       lines.push(`   CSS files           : ${t.cssFiles}`);
  if (t.compiledCSSFiles > 0) lines.push(`   └─ compiled output  : ${t.compiledCSSFiles} (will be skipped)`);

  // Issue counts
  lines.push(`\n🚫 Issues found:`);
  const totalImportant = t.scssImportant + t.cssImportant;
  const totalIDs       = t.scssIDs       + t.cssIDs;

  if (totalImportant === 0 && totalIDs === 0) {
    lines.push(`   ✅ None — files are already clean!`);
  } else {
    if (t.scssImportant > 0) lines.push(`   !important in SCSS  : ${t.scssImportant}`);
    if (t.cssImportant  > 0) lines.push(`   !important in CSS   : ${t.cssImportant}`);
    if (t.scssIDs       > 0) lines.push(`   ID selectors in SCSS: ${t.scssIDs}`);
    if (t.cssIDs        > 0) lines.push(`   ID selectors in CSS : ${t.cssIDs}`);
  }

  // SCSS breakdown — where is !important hiding
  const scssWithIssues = result.issues.scss.filter(f => f.importantCount > 0);
  if (scssWithIssues.length > 0) {
    lines.push(`\n📄 SCSS issue breakdown:`);
    for (const f of scssWithIssues) {
      const short = f.file.split("/").slice(-3).join("/");
      lines.push(`\n   ${short}`);
      lines.push(`   !important : ${f.importantCount}`);
      if (f.inMixin.length > 0) {
        lines.push(`   ⚠️  Inside @mixin (${f.inMixin.length}) — affects all call sites:`);
        f.inMixin.slice(0, 3).forEach(e => lines.push(`      L${e.line}: ${e.code}`));
      }
      if (f.inLoop.length > 0) {
        lines.push(`   ⚠️  Inside @each/@for (${f.inLoop.length}) — affects all generated selectors:`);
        f.inLoop.slice(0, 3).forEach(e => lines.push(`      L${e.line}: ${e.code}`));
      }
      if (f.inNested.length > 0) {
        lines.push(`   ℹ️  Inside nested & rules (${f.inNested.length}):`);
        f.inNested.slice(0, 3).forEach(e => lines.push(`      L${e.line}: ${e.code}`));
      }
      if (f.inline.length > 0) {
        lines.push(`   ✅ Inline rules (${f.inline.length}) — safe to auto-fix:`);
        f.inline.slice(0, 3).forEach(e => lines.push(`      L${e.line}: ${e.code}`));
      }
    }
  }

  // Warnings
  if (result.warnings.length > 0) {
    lines.push(`\n⚠️  Warnings:`);
    result.warnings.forEach(w => lines.push(`   • ${w}`));
  }

  // Recommendations
  if (result.recommendations.length > 0) {
    lines.push(`\n💡 Recommendations:`);
    for (const rec of result.recommendations) {
      const icon = rec.priority === "HIGH" ? "🔴" : rec.priority === "MEDIUM" ? "🟡" : "🟢";
      lines.push(`\n   ${icon} ${rec.action}`);
      if (rec.detail) lines.push(`      ${rec.detail}`);
    }
  }

  // Next steps
  lines.push(`\n${"─".repeat(58)}`);
  lines.push(`Next steps:`);

  if (result.projectType === "css-only") {
    lines.push(`  cssfix . crawl --site http://localhost --twig ./templates`);
    lines.push(`  cssfix ./css report`);
    lines.push(`  cssfix ./css fix`);
  } else if (result.projectType === "scss" || result.projectType === "mixed") {
    lines.push(`  cssfix . crawl --site http://localhost --twig ./templates`);
    lines.push(`  cssfix ./scss report`);
    lines.push(`  cssfix ./scss fix --scss`);
    if (result.buildCommand)
      lines.push(`  ${result.buildCommand}   ← recompile after fixing SCSS`);
    lines.push(`\n  ⚠️  Review mixin !important manually before running fix`);
  }
  lines.push(`${"═".repeat(58)}\n`);

  return lines.join("\n");
}

module.exports = { scanProject, formatScanReport };
