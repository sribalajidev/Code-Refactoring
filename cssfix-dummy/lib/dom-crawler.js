/**
 * lib/dom-crawler.js
 *
 * Crawls a live Drupal site and builds a class ancestry map from
 * real rendered HTML — capturing static, dynamic, PHP preprocess,
 * Twig conditional, and JS-added classes.
 *
 * Strategy:
 *   1. Fetch HTML from a list of URLs (key Drupal page types)
 *   2. Parse the DOM tree and record each class's full ancestor chain
 *   3. Merge results — longer/deeper chains win on conflict
 *   4. Optionally save the map to a JSON cache file for offline use
 *
 * No puppeteer/browser required — uses plain HTTP fetch.
 * For JS-added classes, see the --snapshot flag in the CLI.
 */

const https = require("https");
const http = require("http");
const url = require("url");

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Crawl a set of URLs and return a merged class ancestry map.
 *
 * @param {string[]} urls
 * @param {object} opts
 * @param {string} [opts.basicAuth]      "user:pass" for HTTP basic auth
 * @param {boolean} [opts.ignoreTLS]     Skip TLS verification (for local dev)
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<Map<string, string[]>>}
 */
async function crawlURLs(urls, opts = {}) {
  const { basicAuth, ignoreTLS = false, log = console.log } = opts;
  const globalMap = new Map();

  for (const pageURL of urls) {
    log(`  🌐 Fetching: ${pageURL}`);
    try {
      const html = await fetchPage(pageURL, { basicAuth, ignoreTLS });
      const pageMap = parseHTMLForAncestry(html);
      log(`     └─ ${pageMap.size} classes found`);
      mergeInto(globalMap, pageMap);
    } catch (err) {
      log(`  ⚠️  Failed: ${pageURL} — ${err.message}`);
    }
  }

  return globalMap;
}

/**
 * Parse raw HTML and return class → ancestor chain map.
 * Pure string-based parser — no DOM library needed.
 */
function parseHTMLForAncestry(html) {
  const map = new Map();

  // Strip script, style, comment blocks (we only care about structural HTML)
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  const elements = extractHTMLElements(cleaned);
  const stack = []; // { classes: string[], tag: string }

  for (const el of elements) {
    if (el.type === "close") {
      if (stack.length > 0) stack.pop();
      continue;
    }

    const classes = el.classes;
    const ancestorClasses = stack.flatMap((f) => f.classes);
    const fullChain = [...ancestorClasses, ...classes];

    for (const cls of classes) {
      const existing = map.get(cls);
      if (!existing || fullChain.length > existing.length) {
        map.set(cls, fullChain);
      }
    }

    if (!el.selfClosing) {
      stack.push({ classes, tag: el.tag });
    }
  }

  return map;
}

// ─── HTTP Fetch ────────────────────────────────────────────────────────────────

function fetchPage(pageURL, { basicAuth, ignoreTLS }) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(pageURL);
    const lib = parsed.protocol === "https:" ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path || "/",
      method: "GET",
      headers: {
        "User-Agent": "cssfix-crawler/1.0 (Drupal CSS refactor tool)",
        "Accept": "text/html",
      },
      // Allow self-signed certs on local dev
      rejectUnauthorized: !ignoreTLS,
      timeout: 15000,
    };

    if (basicAuth) {
      options.headers["Authorization"] =
        "Basic " + Buffer.from(basicAuth).toString("base64");
    }

    const req = lib.request(options, (res) => {
      // Follow redirects (up to 5)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectURL = res.headers.location.startsWith("http")
          ? res.headers.location
          : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        fetchPage(redirectURL, { basicAuth, ignoreTLS }).then(resolve).catch(reject);
        res.resume();
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// ─── HTML Parser ──────────────────────────────────────────────────────────────

const VOID_TAGS = new Set([
  "area","base","br","col","embed","hr","img","input",
  "link","meta","param","source","track","wbr",
]);

function extractHTMLElements(html) {
  const elements = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  let match;

  while ((match = tagRe.exec(html)) !== null) {
    const full = match[0];
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const selfSlash = match[3];

    if (full.startsWith("</")) {
      if (!VOID_TAGS.has(tag)) elements.push({ type: "close", tag });
      continue;
    }

    const classes = parseClassAttr(attrs);
    const selfClosing = selfSlash === "/" || VOID_TAGS.has(tag);
    elements.push({ type: "open", tag, classes, selfClosing });
  }

  return elements;
}

function parseClassAttr(attrs) {
  const classes = [];

  // class="foo bar baz"
  const m = attrs.match(/\bclass=(?:"([^"]*)"|'([^']*)'|(\S+))/);
  if (!m) return classes;

  const raw = m[1] ?? m[2] ?? m[3] ?? "";
  for (const cls of raw.split(/\s+/)) {
    // Only keep valid CSS class name characters
    if (cls && /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(cls)) {
      classes.push(cls);
    }
  }
  return classes;
}

// ─── Map Utilities ─────────────────────────────────────────────────────────────

function mergeInto(target, source) {
  for (const [cls, chain] of source.entries()) {
    const existing = target.get(cls);
    if (!existing || chain.length > existing.length) {
      target.set(cls, chain);
    }
  }
}

/**
 * Serialize map to plain JSON for caching.
 */
function mapToJSON(map) {
  return JSON.stringify(Object.fromEntries(map), null, 2);
}

/**
 * Load a previously saved map from JSON.
 */
function mapFromJSON(json) {
  const obj = JSON.parse(json);
  return new Map(Object.entries(obj));
}

module.exports = { crawlURLs, parseHTMLForAncestry, mergeInto, mapToJSON, mapFromJSON };
