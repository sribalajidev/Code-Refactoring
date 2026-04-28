/**
 * lib/fixer.js
 * Core CSS transformation logic.
 *
 * Specificity boosting strategy (in priority order):
 *   1. Look up the selector's classes in the Twig ancestry map
 *      → prepend up to 2 real ancestor classes from the DOM tree
 *   2. Fallback: prepend a configurable wrapper selector (e.g. "body")
 */

const { boostSelectorWithAncestry } = require("./twig-parser");

// ─── Public API ────────────────────────────────────────────────────────────────

function fixCSS(source, filePath = "", options = {}) {
  const { ancestryMap = new Map(), fallbackWrapper = "body" } = options;
  const log = [];
  let output = source;
  output = removeImportant(output, log, ancestryMap, fallbackWrapper);
  output = convertIDSelectors(output, log);
  return { output, log };
}

function reportIssues(source) {
  const importantMatches = source.match(/!important/gi) || [];
  const idSelectorMatches = findIDSelectors(source);
  return {
    importantCount: importantMatches.length,
    idSelectorCount: idSelectorMatches.length,
    idSelectors: [...new Set(idSelectorMatches)],
  };
}

// ─── !important Removal ────────────────────────────────────────────────────────

function removeImportant(source, log, ancestryMap, fallbackWrapper) {
  let result = "";
  let i = 0;
  let importantCount = 0;

  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) { result += source.slice(i); break; }
      result += source.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    if (source[i] === "{") {
      const { blockEnd, inner } = extractBlock(source, i);

      // Nested block (@media, @supports etc.) — recurse
      if (/{/.test(inner)) {
        result += "{" + removeImportant(inner, log, ancestryMap, fallbackWrapper) + "}";
        i = blockEnd + 1;
        continue;
      }

      // Plain declaration block with !important
      if (/!important/i.test(inner)) {
        const selectorRaw = extractLastSelector(result);
        let count = 0;
        const fixedInner = inner.replace(/\s*!important/gi, () => { count++; return ""; });
        importantCount += count;

        const boostedBlock = boostSelectorBlock(selectorRaw, ancestryMap, fallbackWrapper, log);
        if (boostedBlock !== selectorRaw) {
          result = result.slice(0, result.length - selectorRaw.length) + boostedBlock;
        }

        result += "{" + fixedInner + "}";
        i = blockEnd + 1;
        continue;
      }

      result += source.slice(i, blockEnd + 1);
      i = blockEnd + 1;
      continue;
    }

    result += source[i];
    i++;
  }

  if (importantCount > 0) {
    log.push(`  🚫 Removed ${importantCount} !important declaration(s)`);
  }
  return result;
}

function boostSelectorBlock(selectorBlock, ancestryMap, fallbackWrapper, log) {
  const selectors = splitSelectors(selectorBlock);
  const boosted = selectors.map((sel) => {
    const trimmed = sel.trim();
    if (!trimmed || trimmed.startsWith("@") || trimmed === "*" || trimmed === ":root") return sel;
    if (/#[a-zA-Z]/.test(trimmed)) return sel; // IDs already high specificity

    const boostedTrimmed = boostSelectorWithAncestry(trimmed, ancestryMap, fallbackWrapper);
    if (boostedTrimmed !== trimmed) {
      log.push(`  ⚡ Specificity: "${trimmed}" → "${boostedTrimmed}"`);
    }
    const leading = sel.match(/^\s*/)[0];
    return leading + boostedTrimmed;
  });
  return reconstructSelectors(selectorBlock, selectors, boosted);
}

// ─── ID Selector Conversion ────────────────────────────────────────────────────

function convertIDSelectors(source, log) {
  const found = new Set();
  const result = walkCSSSelectors(source, (chunk) => transformIDsInSelector(chunk, found));
  if (found.size > 0) {
    log.push(`  🏷️  Converted ${found.size} ID selector(s): ${[...found].map(id => `#${id} → .id-${id}`).join(", ")}`);
    log.push(`  ℹ️  Update HTML: add class="id-<name>" to elements with matching id="<name>"`);
  }
  return result;
}

function transformIDsInSelector(chunk, found) {
  return chunk
    .replace(/(?<![a-zA-Z0-9_-])#([a-zA-Z_][a-zA-Z0-9_-]*)/g, (_, id) => { found.add(id); return `.id-${id}`; })
    .replace(/\[id=["']?([a-zA-Z_][a-zA-Z0-9_-]*)["']?\]/g, (_, id) => { found.add(id); return `.id-${id}`; });
}

function findIDSelectors(source) {
  const found = [];
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of stripped.matchAll(/(?<![a-zA-Z0-9_-])#([a-zA-Z_][a-zA-Z0-9_-]*)/g)) found.push(`#${m[1]}`);
  for (const m of stripped.matchAll(/\[id=["']?([a-zA-Z_][a-zA-Z0-9_-]*)["']?\]/g)) found.push(`#${m[1]}`);
  return found;
}

// ─── CSS Walker ────────────────────────────────────────────────────────────────

function walkCSSSelectors(source, transformSelector) {
  let result = "";
  let i = 0;

  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) { result += source.slice(i); break; }
      result += source.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    if (source[i] !== "{") {
      let chunk = "";
      while (i < source.length && source[i] !== "{") {
        if (source[i] === "/" && source[i + 1] === "*") {
          result += transformSelector(chunk); chunk = "";
          const end = source.indexOf("*/", i + 2);
          if (end === -1) { result += source.slice(i); i = source.length; break; }
          result += source.slice(i, end + 2); i = end + 2;
        } else { chunk += source[i++]; }
      }
      result += transformSelector(chunk);
      continue;
    }

    const { blockEnd, inner } = extractBlock(source, i);
    if (/{/.test(inner)) {
      result += "{" + walkCSSSelectors(inner, transformSelector) + "}";
    } else {
      result += "{" + inner + "}";
    }
    i = blockEnd + 1;
  }
  return result;
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function extractBlock(source, openBrace) {
  let depth = 0, i = openBrace;
  while (i < source.length) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) return { blockEnd: i, inner: source.slice(openBrace + 1, i) }; }
    i++;
  }
  return { blockEnd: source.length - 1, inner: source.slice(openBrace + 1) };
}

function extractLastSelector(result) {
  const lastBrace = result.lastIndexOf("}");
  return lastBrace === -1 ? result : result.slice(lastBrace + 1);
}

function splitSelectors(block) {
  const selectors = []; let depth = 0, current = "";
  for (const ch of block) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) { selectors.push(current); current = ""; continue; }
    current += ch;
  }
  selectors.push(current); return selectors;
}

function reconstructSelectors(original, origParts, newParts) {
  let result = original, offset = 0;
  for (let i = 0; i < origParts.length; i++) {
    if (origParts[i] !== newParts[i]) {
      const idx = result.indexOf(origParts[i], offset);
      if (idx !== -1) { result = result.slice(0, idx) + newParts[i] + result.slice(idx + origParts[i].length); offset = idx + newParts[i].length; }
    } else { offset += origParts[i].length; }
  }
  return result;
}

module.exports = { fixCSS, reportIssues };
