/**
 * lib/coverage.js
 *
 * Cross-references CSS classes against the ancestry map and
 * produces a coverage report: matched, unmatched, fallback.
 */

/**
 * Scan CSS files and report class coverage against the ancestry map.
 *
 * @param {string[]}            cssFiles     Paths to CSS files
 * @param {Map<string,string[]>} ancestryMap
 * @param {Map<string,string>}  classPageMap  class → first-seen URL
 * @returns {CoverageReport}
 */
function buildCoverageReport(cssFiles, ancestryMap, classPageMap = new Map()) {
  const allCSSClasses  = new Map(); // className → Set of files it appears in
  const matched        = new Map(); // className → { chain, files }
  const unmatched      = new Map(); // className → { files }

  const fs = require("fs");
  const CLASS_RE = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g;

  for (const filePath of cssFiles) {
    const source = fs.readFileSync(filePath, "utf8");
    // Strip comments and declaration blocks — only look at selectors
    const selectorsOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{[^{}]*\}/g, "");

    for (const m of selectorsOnly.matchAll(CLASS_RE)) {
      const cls = m[1];
      if (!allCSSClasses.has(cls)) allCSSClasses.set(cls, new Set());
      allCSSClasses.get(cls).add(filePath);
    }
  }

  for (const [cls, files] of allCSSClasses.entries()) {
    if (ancestryMap.has(cls)) {
      matched.set(cls, {
        chain:    ancestryMap.get(cls),
        files:    [...files],
        foundOn:  classPageMap.get(cls) || null,
      });
    } else {
      unmatched.set(cls, { files: [...files] });
    }
  }

  return {
    totalCSSClasses:   allCSSClasses.size,
    matchedCount:      matched.size,
    unmatchedCount:    unmatched.size,
    coveragePct:       allCSSClasses.size > 0
      ? Math.round((matched.size / allCSSClasses.size) * 100)
      : 100,
    matched,
    unmatched,
  };
}

/**
 * Format a coverage report for CLI output.
 */
function formatCoverageReport(report, opts = {}) {
  const { showMatched = false, fallbackWrapper = "body" } = opts;
  const lines = [];

  // ── Summary bar ────────────────────────────────────────────────────────────
  const bar = makeBar(report.coveragePct, 30);
  lines.push(`\n📊 Coverage: ${report.coveragePct}% matched  ${bar}`);
  lines.push(`   ${report.matchedCount} of ${report.totalCSSClasses} CSS classes found in crawled DOM`);
  lines.push(`   ${report.unmatchedCount} class(es) will use fallback wrapper: "${fallbackWrapper}"\n`);

  // ── Unmatched classes ──────────────────────────────────────────────────────
  if (report.unmatchedCount > 0) {
    lines.push(`⚠️  Unmatched classes (fallback to "${fallbackWrapper}"):`);

    // Group by file for readability
    const byFile = new Map();
    for (const [cls, { files }] of report.unmatched.entries()) {
      for (const f of files) {
        if (!byFile.has(f)) byFile.set(f, []);
        byFile.get(f).push(cls);
      }
    }

    for (const [file, classes] of byFile.entries()) {
      const short = file.split("/").slice(-2).join("/");
      lines.push(`\n   📄 ${short} (${classes.length} unmatched):`);
      // Chunk into rows of 5
      for (let i = 0; i < Math.min(classes.length, 20); i += 5) {
        lines.push(`      ${classes.slice(i, i + 5).map(c => `.${c}`).join("  ")}`);
      }
      if (classes.length > 20) lines.push(`      … and ${classes.length - 20} more`);
    }

    lines.push(`\n   💡 To improve coverage:`);
    lines.push(`      • Add more --url pages that use these classes`);
    lines.push(`      • Run: cssfix . crawl --url <more-pages>`);
    lines.push(`      • Check if these classes are JS-only (added after page load)`);
  } else {
    lines.push(`✅ All CSS classes matched — real DOM specificity for everything!`);
  }

  // ── Matched classes (optional verbose) ────────────────────────────────────
  if (showMatched && report.matched.size > 0) {
    lines.push(`\n✅ Matched classes (sample):`);
    let count = 0;
    for (const [cls, { chain, foundOn }] of report.matched.entries()) {
      if (count++ >= 15) { lines.push(`   … and ${report.matched.size - 15} more`); break; }
      const ancestry = chain.slice(-3).map(c => `.${c}`).join(" > ");
      const page = foundOn ? `  (${shortURL(foundOn)})` : "";
      lines.push(`   .${cls}  →  ${ancestry}${page}`);
    }
  }

  return lines.join("\n");
}

function makeBar(pct, width) {
  const filled = Math.round((pct / 100) * width);
  const color  = pct >= 90 ? "█" : pct >= 70 ? "▓" : "░";
  return "[" + color.repeat(filled) + "·".repeat(width - filled) + "]";
}

function shortURL(u) {
  try { return new URL(u).pathname || "/"; }
  catch (_) { return u; }
}

module.exports = { buildCoverageReport, formatCoverageReport };
