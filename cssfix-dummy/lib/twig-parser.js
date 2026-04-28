/**
 * lib/twig-parser.js
 *
 * Parses Drupal .html.twig templates and builds a class ancestry map.
 *
 * Output shape:
 * {
 *   "block": ["layout-container", "region", "block"],   // ordered outermost→innermost
 *   "nav-item": ["menu", "nav", "nav-item"],
 *   ...
 * }
 *
 * The map key is each class name, the value is the full ancestor chain
 * from the root of the template down to (and including) that element.
 */

const fs = require("fs");
const path = require("path");

/**
 * Scan a directory recursively for .html.twig files and build the class map.
 * @param {string} dir - Root directory of the Drupal theme
 * @returns {Map<string, string[]>} className → ancestor chain (outermost first)
 */
function buildClassAncestryMap(dir) {
  const twigFiles = collectTwigFiles(dir);
  const globalMap = new Map(); // className → best ancestor chain found

  for (const filePath of twigFiles) {
    const source = fs.readFileSync(filePath, "utf8");
    const fileMap = parseTwigFile(source);
    // Merge: longer/more specific chains win
    for (const [className, chain] of fileMap.entries()) {
      const existing = globalMap.get(className);
      if (!existing || chain.length > existing.length) {
        globalMap.set(className, chain);
      }
    }
  }

  return globalMap;
}

/**
 * Parse a single Twig file and return class→ancestry chains.
 */
function parseTwigFile(source) {
  const map = new Map();

  // Strip Twig comments {# ... #} and Twig tags {% ... %} and {{ ... }}
  // We want pure HTML structure
  const html = stripTwig(source);

  // Parse HTML tags into a flat list with depth tracking
  const elements = extractElements(html);

  // Build ancestry chains using a stack
  const stack = []; // stack of { classes: string[], selfClosing: boolean }

  for (const el of elements) {
    if (el.type === "close") {
      if (stack.length > 0) stack.pop();
      continue;
    }

    const classes = el.classes;

    // Build ancestor chain for each class on this element
    const ancestorClasses = stack.flatMap((frame) => frame.classes);
    const fullChain = [...ancestorClasses, ...classes];

    for (const cls of classes) {
      if (!map.has(cls) || fullChain.length > map.get(cls).length) {
        map.set(cls, fullChain);
      }
    }

    if (!el.selfClosing) {
      stack.push({ classes, tag: el.tag });
    }
  }

  return map;
}

/**
 * Strip Twig syntax, leaving clean-ish HTML.
 */
function stripTwig(source) {
  return source
    .replace(/\{#[\s\S]*?#\}/g, "") // {# comments #}
    .replace(/\{%[\s\S]*?%\}/g, "") // {% tags %}
    .replace(/\{\{[\s\S]*?\}\}/g, "TWIG_VAR") // {{ vars }} → placeholder
    .replace(/<!--[\s\S]*?-->/g, ""); // HTML comments
}

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Extract opening and closing tags from HTML source.
 * Returns array of { type: 'open'|'close'|'selfclose', tag, classes, selfClosing }
 */
function extractElements(html) {
  const elements = [];
  // Match opening tags <tag ...> or self-closing <tag ... />
  // and closing tags </tag>
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  let match;

  while ((match = tagRe.exec(html)) !== null) {
    const fullTag = match[0];
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const selfCloseSlash = match[3];

    if (fullTag.startsWith("</")) {
      elements.push({ type: "close", tag });
      continue;
    }

    const classes = extractClasses(attrs);
    const selfClosing = selfCloseSlash === "/" || VOID_ELEMENTS.has(tag);

    elements.push({ type: "open", tag, classes, selfClosing });
  }

  return elements;
}

/**
 * Extract class names from an HTML attribute string.
 * Handles static classes and Twig variable placeholders.
 */
function extractClasses(attrs) {
  const classes = [];

  // Match class="..." or class='...'
  const classMatch = attrs.match(/class=["']([^"']*)["']/);
  if (classMatch) {
    const raw = classMatch[1];
    // Split on whitespace, filter out Twig placeholders and empty strings
    const parts = raw.split(/\s+/).filter(
      (c) => c && c !== "TWIG_VAR" && /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(c)
    );
    classes.push(...parts);
  }

  // Also match class="{{ ... }}" patterns (dynamic only — skip, TWIG_VAR filtered above)
  // And class="static {{ dynamic }}" — static parts already captured above

  return classes;
}

/**
 * Collect all .html.twig files recursively.
 */
function collectTwigFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTwigFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".html.twig")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Given a CSS selector like ".nav .nav-item" and the class ancestry map,
 * find the best ancestor prefix to prepend for specificity boosting.
 *
 * Strategy:
 * 1. Extract all class names from the selector
 * 2. Look up the most specific (innermost / last) class in the map
 * 3. Build ancestor prefix from the chain, excluding classes already in selector
 * 4. Return the boosted selector
 *
 * @param {string} selector - A single CSS selector (no commas)
 * @param {Map<string, string[]>} ancestryMap
 * @param {string} fallbackWrapper - e.g. "body" used when no Twig match
 * @returns {string} boosted selector
 */
function boostSelectorWithAncestry(selector, ancestryMap, fallbackWrapper = "body") {
  const trimmed = selector.trim();

  // Skip @-rules, :root, *, empty, already-boosted
  if (!trimmed || trimmed.startsWith("@") || trimmed === "*" || trimmed === ":root") {
    return selector;
  }

  // Extract class names from selector (in order)
  const classesInSelector = [...trimmed.matchAll(/\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g)].map(
    (m) => m[1]
  );

  if (classesInSelector.length === 0) {
    // No classes in selector (element or ID only) — use fallback
    return `${fallbackWrapper} ${trimmed}`;
  }

  // Try each class in the selector (prefer the most specific — last one)
  // Walk from last to first class to find a Twig match
  let bestChain = null;
  let bestClass = null;

  for (let i = classesInSelector.length - 1; i >= 0; i--) {
    const cls = classesInSelector[i];
    if (ancestryMap.has(cls)) {
      bestChain = ancestryMap.get(cls);
      bestClass = cls;
      break;
    }
  }

  if (!bestChain) {
    // No Twig match — use fallback wrapper
    return `${fallbackWrapper} ${trimmed}`;
  }

  // Build ancestor prefix: classes in the chain that are NOT already in the selector
  const selectorClassSet = new Set(classesInSelector);
  const ancestors = bestChain
    .slice(0, bestChain.indexOf(bestClass)) // only ancestors, not the class itself
    .filter((c) => !selectorClassSet.has(c))
    .filter((c) => c); // no empty

  if (ancestors.length === 0) {
    // All ancestors already in selector — use fallback
    return `${fallbackWrapper} ${trimmed}`;
  }

  // Use the closest 1-2 ancestors to keep specificity reasonable
  const prefix = ancestors.slice(-2).map((c) => `.${c}`).join(" ");
  return `${prefix} ${trimmed}`;
}

module.exports = { buildClassAncestryMap, boostSelectorWithAncestry, parseTwigFile };
