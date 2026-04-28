/**
 * lib/ancestry-builder.js
 *
 * Orchestrates all sources of class ancestry data, in priority order:
 *
 *   1. Live DOM crawl   (most accurate — catches everything)
 *   2. Twig parsing     (catches static + some dynamic patterns)
 *   3. Cached snapshot  (.cssfix-cache.json from a previous crawl)
 *
 * Sources are merged — live DOM wins on conflicts.
 *
 * Also handles the "unmatched classes" report: CSS classes that
 * appear in stylesheets but have no ancestry data from any source.
 */

const fs = require("fs");
const path = require("path");
const { crawlURLs, mapToJSON, mapFromJSON, mergeInto } = require("./dom-crawler");
const { buildClassAncestryMap } = require("./twig-parser");

const CACHE_FILENAME = ".cssfix-cache.json";

/**
 * Build the full ancestry map from available sources.
 *
 * @param {object} opts
 * @param {string[]} [opts.urls]          URLs to crawl
 * @param {string}   [opts.twigDir]       Path to templates directory
 * @param {string}   [opts.cacheFile]     Path to load/save cache (default: .cssfix-cache.json)
 * @param {string}   [opts.basicAuth]     "user:pass" for auth-protected sites
 * @param {boolean}  [opts.ignoreTLS]     Skip TLS cert check (local dev)
 * @param {boolean}  [opts.saveCache]     Write cache after crawl (default: true)
 * @param {boolean}  [opts.useCache]      Load cache if crawl not possible (default: true)
 * @param {(s:string)=>void} [opts.log]
 *
 * @returns {Promise<{ ancestryMap: Map, stats: object }>}
 */
async function buildAncestryMap(opts = {}) {
  const {
    urls = [],
    twigDir = null,
    cacheFile = CACHE_FILENAME,
    basicAuth = null,
    ignoreTLS = false,
    saveCache = true,
    useCache = true,
    log = console.log,
  } = opts;

  const merged = new Map();
  const stats = { domClasses: 0, twigClasses: 0, cacheClasses: 0, totalUnique: 0 };

  // ── 1. Live DOM crawl ──────────────────────────────────────────────────────
  if (urls.length > 0) {
    log(`\n🌐 Crawling ${urls.length} page(s) for real DOM class ancestry...`);
    const domMap = await crawlURLs(urls, { basicAuth, ignoreTLS, log });
    stats.domClasses = domMap.size;
    log(`   ✅ DOM crawl complete: ${domMap.size} unique classes found`);
    mergeInto(merged, domMap);

    if (saveCache && domMap.size > 0) {
      try {
        fs.writeFileSync(cacheFile, mapToJSON(merged), "utf8");
        log(`   💾 Cache saved: ${cacheFile}`);
      } catch (e) {
        log(`   ⚠️  Could not save cache: ${e.message}`);
      }
    }
  }

  // ── 2. Twig static parse ───────────────────────────────────────────────────
  if (twigDir && fs.existsSync(twigDir)) {
    log(`\n🌿 Parsing Twig templates in: ${twigDir}`);
    const twigMap = buildClassAncestryMap(twigDir);
    stats.twigClasses = twigMap.size;
    log(`   ✅ Twig parse complete: ${twigMap.size} classes found`);

    // Twig fills gaps — DOM data takes priority (DOM chains are longer/richer)
    for (const [cls, chain] of twigMap.entries()) {
      if (!merged.has(cls)) {
        merged.set(cls, chain);
      }
    }
  }

  // ── 3. Load cache as final fallback ───────────────────────────────────────
  if (useCache && merged.size === 0 && fs.existsSync(cacheFile)) {
    log(`\n📦 No live sources — loading cache: ${cacheFile}`);
    try {
      const cached = mapFromJSON(fs.readFileSync(cacheFile, "utf8"));
      stats.cacheClasses = cached.size;
      mergeInto(merged, cached);
      log(`   ✅ Loaded ${cached.size} classes from cache`);
    } catch (e) {
      log(`   ⚠️  Cache load failed: ${e.message}`);
    }
  } else if (useCache && merged.size > 0 && fs.existsSync(cacheFile)) {
    // Supplement with cache for any gaps not covered by live sources
    try {
      const cached = mapFromJSON(fs.readFileSync(cacheFile, "utf8"));
      stats.cacheClasses = cached.size;
      for (const [cls, chain] of cached.entries()) {
        if (!merged.has(cls)) merged.set(cls, chain);
      }
    } catch (_) {}
  }

  stats.totalUnique = merged.size;

  if (merged.size === 0) {
    log(`\n⚠️  No ancestry data from any source. Will use fallback wrapper for all selectors.`);
    log(`   Run with --url to crawl your live site for accurate results.`);
  }

  return { ancestryMap: merged, stats };
}

/**
 * Given a CSS file's content and the ancestry map, find which CSS classes
 * have NO match in the map — these will get the fallback wrapper.
 */
function findUnmatchedClasses(cssSource, ancestryMap) {
  const unmatched = new Set();
  const classRe = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g;
  const stripped = cssSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{[^}]*\}/g, "");
  for (const m of stripped.matchAll(classRe)) {
    if (!ancestryMap.has(m[1])) unmatched.add(m[1]);
  }
  return [...unmatched];
}

module.exports = { buildAncestryMap, findUnmatchedClasses, CACHE_FILENAME };
