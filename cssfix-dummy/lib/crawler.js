/**
 * lib/crawler.js
 *
 * Two-phase URL discovery for a Drupal site:
 *   Phase 1 — Parse sitemap.xml (handles sitemap index + nested sitemaps)
 *   Phase 2 — Spider from start URL following internal <a href> links
 *
 * Then fetches all discovered pages and builds the class ancestry map.
 */

const https = require("https");
const http  = require("http");
const url   = require("url");
const { parseHTMLForAncestry, mergeInto } = require("./dom-crawler");

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Full crawl pipeline:
 *   1. Try sitemap.xml
 *   2. Spider from baseURL if sitemap missing or too small
 *   3. Fetch all discovered URLs and build ancestry map
 *
 * @param {string}   baseURL          e.g. "http://localhost"
 * @param {object}   opts
 * @param {number}   [opts.maxPages=80]       Max pages to fetch
 * @param {number}   [opts.maxDepth=4]        Spider link depth
 * @param {number}   [opts.concurrency=5]     Parallel fetches
 * @param {string}   [opts.basicAuth]         "user:pass"
 * @param {boolean}  [opts.ignoreTLS=false]
 * @param {string[]} [opts.extraURLs=[]]      Manually added URLs
 * @param {(s)=>void}[opts.log=console.log]
 *
 * @returns {Promise<{ ancestryMap: Map, stats: CrawlStats }>}
 */
async function crawlSite(baseURL, opts = {}) {
  const {
    maxPages    = 80,
    maxDepth    = 4,
    concurrency = 5,
    basicAuth   = null,
    ignoreTLS   = false,
    extraURLs   = [],
    log         = console.log,
  } = opts;

  const fetchOpts = { basicAuth, ignoreTLS };
  const base      = normalizeBase(baseURL);
  const stats     = { sitemapURLs: 0, spiderURLs: 0, fetchedPages: 0, failedPages: 0, totalClasses: 0 };

  // ── Phase 1: Sitemap ────────────────────────────────────────────────────────
  let discoveredURLs = [];

  log(`\n🗺️  Checking sitemap at ${base}/sitemap.xml ...`);
  const sitemapURLs = await parseSitemap(`${base}/sitemap.xml`, fetchOpts);

  if (sitemapURLs.length > 0) {
    log(`   ✅ Sitemap found — ${sitemapURLs.length} URL(s) discovered`);
    stats.sitemapURLs = sitemapURLs.length;
    discoveredURLs = sitemapURLs;
  } else {
    log(`   ⚠️  No sitemap found (or empty) — falling back to spider`);
  }

  // ── Phase 2: Spider (fallback or supplement) ────────────────────────────────
  if (discoveredURLs.length < 10) {
    log(`\n🕷️  Spidering from ${base} (max depth: ${maxDepth}) ...`);
    const spiderURLs = await spider(base, { maxPages, maxDepth, fetchOpts, log });
    log(`   🕷️  Spider found ${spiderURLs.length} URL(s)`);
    stats.spiderURLs = spiderURLs.length;

    // Merge — deduplicate
    const seen = new Set(discoveredURLs.map(normalizeURL));
    for (const u of spiderURLs) {
      const n = normalizeURL(u);
      if (!seen.has(n)) { seen.add(n); discoveredURLs.push(u); }
    }
  }

  // Add any manually specified extra URLs
  for (const u of extraURLs) {
    const n = normalizeURL(u);
    if (!discoveredURLs.map(normalizeURL).includes(n)) discoveredURLs.push(u);
  }

  // Cap at maxPages
  const toFetch = discoveredURLs.slice(0, maxPages);
  log(`\n📄 Fetching ${toFetch.length} page(s) (capped at ${maxPages}) ...`);

  // ── Phase 3: Fetch + parse ──────────────────────────────────────────────────
  const ancestryMap = new Map();
  // Track which page each class was first seen on
  const classPageMap = new Map(); // className → URL

  const results = await fetchConcurrent(toFetch, concurrency, fetchOpts, log);

  for (const { pageURL, html, error } of results) {
    if (error) { stats.failedPages++; continue; }
    stats.fetchedPages++;
    const pageMap = parseHTMLForAncestry(html);
    for (const cls of pageMap.keys()) {
      if (!classPageMap.has(cls)) classPageMap.set(cls, pageURL);
    }
    mergeInto(ancestryMap, pageMap);
  }

  stats.totalClasses = ancestryMap.size;
  log(`\n✅ Crawl complete: ${stats.fetchedPages} pages, ${stats.totalClasses} unique classes`);
  if (stats.failedPages > 0) log(`   ⚠️  ${stats.failedPages} page(s) failed`);

  return { ancestryMap, classPageMap, stats, crawledURLs: toFetch };
}

// ─── Sitemap Parser ────────────────────────────────────────────────────────────

async function parseSitemap(sitemapURL, fetchOpts, depth = 0) {
  if (depth > 3) return []; // prevent infinite recursion on malformed sitemaps
  let xml;
  try { xml = await fetchRaw(sitemapURL, fetchOpts); }
  catch (_) { return []; }

  if (!xml || !xml.includes("<url") && !xml.includes("<sitemap")) return [];

  const urls = [];

  // Sitemap index — contains <sitemap><loc>...</loc></sitemap>
  if (xml.includes("<sitemapindex")) {
    const nestedURLs = [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)]
      .map(m => m[1].trim())
      .filter(u => u.endsWith(".xml") || u.includes("sitemap"));

    for (const nested of nestedURLs) {
      const found = await parseSitemap(nested, fetchOpts, depth + 1);
      urls.push(...found);
    }
    return urls;
  }

  // Regular sitemap — contains <url><loc>...</loc></url>
  const locs = [...xml.matchAll(/<url>[\s\S]*?<loc>\s*([^<]+)\s*<\/loc>[\s\S]*?<\/url>/g)]
    .map(m => m[1].trim())
    .filter(u => /^https?:\/\//.test(u));

  return locs;
}

// ─── Spider ────────────────────────────────────────────────────────────────────

async function spider(baseURL, { maxPages, maxDepth, fetchOpts, log }) {
  const base    = normalizeBase(baseURL);
  const visited = new Set();
  const queue   = [{ url: base, depth: 0 }];
  const found   = [];

  while (queue.length > 0 && found.length < maxPages) {
    const { url: current, depth } = queue.shift();
    const normalized = normalizeURL(current);

    if (visited.has(normalized)) continue;
    visited.add(normalized);
    found.push(current);

    if (depth >= maxDepth) continue;

    let html;
    try { html = await fetchRaw(current, fetchOpts); }
    catch (_) { continue; }

    // Extract internal links
    const links = extractInternalLinks(html, base, current);
    for (const link of links) {
      const n = normalizeURL(link);
      if (!visited.has(n) && !queue.find(q => normalizeURL(q.url) === n)) {
        queue.push({ url: link, depth: depth + 1 });
      }
    }
  }

  return found;
}

function extractInternalLinks(html, base, currentURL) {
  const links = [];
  const hrefRe = /href=["']([^"'#?][^"']*?)["']/g;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const href = m[1].trim();
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:")) continue;

    let absolute;
    try {
      absolute = new URL(href, currentURL).href;
    } catch (_) { continue; }

    // Only follow same-origin links, skip files/admin/feeds
    if (!absolute.startsWith(base)) continue;
    if (/\.(css|js|png|jpg|jpeg|gif|svg|pdf|xml|json|ico|woff|woff2|ttf)(\?|$)/i.test(absolute)) continue;
    if (/\/(admin|batch|devel|update\.php)/.test(absolute)) continue;

    links.push(absolute.split("?")[0].split("#")[0]); // strip query + hash
  }
  return [...new Set(links)];
}

// ─── Concurrent fetcher ────────────────────────────────────────────────────────

async function fetchConcurrent(urls, concurrency, fetchOpts, log) {
  const results = [];
  let i = 0;

  async function worker() {
    while (i < urls.length) {
      const idx  = i++;
      const pageURL = urls[idx];
      try {
        const html = await fetchRaw(pageURL, fetchOpts);
        log(`  [${idx + 1}/${urls.length}] ✓ ${pageURL}`);
        results[idx] = { pageURL, html };
      } catch (err) {
        log(`  [${idx + 1}/${urls.length}] ✗ ${pageURL} — ${err.message}`);
        results[idx] = { pageURL, error: err.message };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── HTTP Fetch ────────────────────────────────────────────────────────────────

function fetchRaw(pageURL, { basicAuth, ignoreTLS } = {}, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error("Too many redirects"));

  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(pageURL); }
    catch (e) { return reject(new Error(`Invalid URL: ${pageURL}`)); }

    const lib = parsed.protocol === "https:" ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || undefined,
      path:     parsed.pathname + parsed.search,
      method:   "GET",
      headers:  {
        "User-Agent": "cssfix-crawler/2.0 (Drupal CSS refactor tool)",
        "Accept":     "text/html,application/xhtml+xml,application/xml;q=0.9",
      },
      rejectUnauthorized: !ignoreTLS,
      timeout: 15000,
    };

    if (basicAuth) {
      options.headers["Authorization"] = "Basic " + Buffer.from(basicAuth).toString("base64");
    }

    const req = lib.request(options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let loc = res.headers.location;
        if (!loc.startsWith("http")) loc = `${parsed.protocol}//${parsed.host}${loc}`;
        res.resume();
        return fetchRaw(loc, { basicAuth, ignoreTLS }, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });

    req.on("error",   reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function normalizeBase(u) {
  return u.replace(/\/+$/, "");
}

function normalizeURL(u) {
  try {
    const parsed = new URL(u);
    return parsed.hostname + parsed.pathname.replace(/\/+$/, "");
  } catch (_) { return u; }
}

module.exports = { crawlSite };
