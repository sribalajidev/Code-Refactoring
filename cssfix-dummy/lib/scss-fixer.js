/**
 * lib/scss-fixer.js
 *
 * Fixes !important and ID selectors in SCSS source files.
 *
 * Key insight for correct nesting:
 * When a deeply nested rule needs an ancestor wrapper, that wrapper
 * must go OUTSIDE the outermost existing rule, not inside at the leaf.
 *
 * Example:
 *   .site-header { .nav-menu { .nav-link { color: blue !important; } } }
 *   DOM: layout-container > site-header > nav-menu > nav-link
 *   site-header and nav-menu are already covered.
 *   layout-container must wrap OUTSIDE .site-header, not inside .nav-menu.
 *
 * Solution: two-phase process.
 *   Phase 1: For each top-level rule, collect ALL missing ancestors needed
 *            by ANY descendant. If ancestors are needed, wrap the entire
 *            top-level rule (and all its children) with them.
 *   Phase 2: Within the (now correctly wrapped) subtree, just remove
 *            !important — no more wrapping needed for descendants.
 */

function fixSCSS(source, filePath, options) {
  options = options || {};
  var ancestryMap     = options.ancestryMap     || new Map();
  var fallbackWrapper = options.fallbackWrapper || "body";
  var log     = [];
  var skipped = [];

  var tree   = parseSCSSTree(source);
  var fixed  = fixRoot(tree, ancestryMap, fallbackWrapper, log, skipped);
  var output = fixed.children.map(function(c) { return serializeNode(c, 0); }).join("");

  return { output: output, log: log, skipped: skipped };
}

function reportSCSSIssues(source) {
  var lines = source.split("\n");
  var importantCount = 0, idCount = 0, inMixinCount = 0, inLoopCount = 0;
  var stack = [];
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (/^@mixin\s/.test(t))                 stack.push("mixin");
    else if (/^@each|^@for|^@while/.test(t)) stack.push("loop");
    else if (t.endsWith("{"))                stack.push("rule");
    if (t === "}") stack.pop();
    var ctx = stack[stack.length - 1];
    if (/!important/i.test(lines[i]) && !t.startsWith("//")) {
      importantCount++;
      if (ctx === "mixin") inMixinCount++;
      if (ctx === "loop")  inLoopCount++;
    }
    if (!t.startsWith("//") && !t.startsWith("*") && !/^\s*[\w-]+\s*:/.test(t))
      idCount += (lines[i].match(/(?<![a-zA-Z0-9_-])#([a-zA-Z_][a-zA-Z0-9_-]*)/g) || []).length;
  }
  return { importantCount: importantCount, idCount: idCount, inMixinCount: inMixinCount, inLoopCount: inLoopCount };
}

// ─── Parser ────────────────────────────────────────────────────────────────────

function parseSCSSTree(source) {
  var lines = source.split("\n");
  var root  = { type: "root", children: [] };
  var stack = [root];
  var i = 0;
  function top() { return stack[stack.length - 1]; }

  while (i < lines.length) {
    var line    = lines[i];
    var trimmed = line.trim();
    var indent  = (line.match(/^(\s*)/) || ["", ""])[1];

    if (!trimmed) { top().children.push({ type: "raw", raw: line + "\n" }); i++; continue; }

    if (trimmed.startsWith("//")) { top().children.push({ type: "comment", raw: line + "\n" }); i++; continue; }

    if (trimmed.startsWith("/*")) {
      var cmnt = line + "\n";
      if (!trimmed.includes("*/")) {
        while (++i < lines.length) { cmnt += lines[i] + "\n"; if (lines[i].includes("*/")) break; }
      }
      top().children.push({ type: "comment", raw: cmnt }); i++; continue;
    }

    if (trimmed === "}") {
      if (stack.length > 1) stack.pop();
      else top().children.push({ type: "raw", raw: line + "\n" });
      i++; continue;
    }

    // Single-line block: selector { body }
    var slm = trimmed.match(/^([^{]+)\{([^{}]*)\}\s*$/);
    if (slm) {
      var slSel = slm[1].trim(), slBody = slm[2].trim();
      if (slSel.startsWith("@")) {
        var atDecls = parseInlineDecls(slBody);
        var atm = slSel.match(/^(@[\w-]+)\s*(.*)/);
        top().children.push({ type: "atrule", name: atm ? atm[1] : slSel, params: atm ? atm[2].trim() : "",
          indent: indent, children: atDecls,
          isMixin: /^@mixin/.test(slSel), isLoop: /^@each|^@for|^@while/.test(slSel),
          verbatim: line + "\n" });
      } else {
        top().children.push({ type: "rule", selector: slSel, indent: indent, children: parseInlineDecls(slBody) });
      }
      i++; continue;
    }

    // Opening block
    if (trimmed.endsWith("{")) {
      var bc = trimmed.slice(0, -1).trim(), bnode;
      if (bc.startsWith("@")) {
        var bm = bc.match(/^(@[\w-]+)\s*(.*)/);
        bnode = { type: "atrule", name: bm ? bm[1] : bc, params: bm ? bm[2].trim() : "",
          indent: indent, children: [],
          isMixin: /^@mixin/.test(bc), isLoop: /^@each|^@for|^@while/.test(bc) };
      } else {
        bnode = { type: "rule", selector: bc, indent: indent, children: [] };
      }
      top().children.push(bnode); stack.push(bnode); i++; continue;
    }

    // Declaration
    var dm = trimmed.match(/^([\w-]+)\s*:\s*(.*?);?\s*$/);
    if (dm && !trimmed.startsWith("&") && !trimmed.startsWith("@")) {
      var dval = dm[2].trim();
      top().children.push({ type: "declaration", prop: dm[1],
        value: dval.replace(/\s*!important/gi, "").replace(/;$/, "").trim(),
        important: /!important/i.test(dval), indent: indent, raw: line });
      i++; continue;
    }

    top().children.push({ type: "raw", raw: line + "\n" }); i++;
  }
  return root;
}

function parseInlineDecls(body) {
  var decls = [];
  body.split(";").map(function(p) { return p.trim(); }).filter(Boolean).forEach(function(part) {
    var ci = part.indexOf(":");
    if (ci === -1) return;
    var rawVal = part.slice(ci + 1).trim();
    decls.push({ type: "declaration", prop: part.slice(0, ci).trim(),
      value: rawVal.replace(/\s*!important/gi, "").trim(), important: /!important/i.test(rawVal) });
  });
  return decls;
}

// ─── Phase 1: Fix root children ────────────────────────────────────────────────
//
// For each TOP-LEVEL rule (or at-rule), we:
//   1. Collect all missing ancestors needed anywhere in this subtree
//   2. Wrap the entire top-level rule with those ancestors
//   3. Strip !important from all descendants
//
// For at-rules at the top level (@media etc.), we recurse one level in
// and apply the same logic to their children.

function fixRoot(tree, ancestryMap, fallbackWrapper, log, skipped) {
  var newChildren = [];
  tree.children.forEach(function(child) {
    var result = fixTopLevelNode(child, ancestryMap, fallbackWrapper, log, skipped);
    newChildren = newChildren.concat(result);
  });
  return { type: "root", children: newChildren };
}

function fixTopLevelNode(node, ancestryMap, fallbackWrapper, log, skipped) {
  // Pass-through
  if (node.type === "raw" || node.type === "comment") return [node];

  // Mixin / loop at-rules: preserve, flag issues
  if (node.type === "atrule" && (node.isMixin || node.isLoop)) {
    collectImportantDecls(node).forEach(function(d) {
      skipped.push({
        code:   d.raw ? d.raw.trim() : (d.prop + ": " + d.value + " !important"),
        reason: node.isMixin
          ? "Inside " + node.name + " - removing !important affects every @include call site"
          : "Inside " + node.name + " loop - affects all generated selectors",
      });
    });
    return [node];
  }

  // Other at-rules (@media, @supports, @if) — recurse into children as top-level
  if (node.type === "atrule") {
    var fixedAtChildren = [];
    node.children.forEach(function(c) {
      fixedAtChildren = fixedAtChildren.concat(fixTopLevelNode(c, ancestryMap, fallbackWrapper, log, skipped));
    });
    return [Object.assign({}, node, { children: fixedAtChildren })];
  }

  // Rule node — find ALL missing ancestors needed anywhere in this subtree
  if (node.type === "rule") {
    var selector = convertIDsInSelector(node.selector);
    if (selector !== node.selector) log.push("  ID: \"" + node.selector + "\" -> \"" + selector + "\"");

    // Collect all ancestor classes needed by any !important rule in this subtree
    // starting from this rule's current chain (just itself at the top level)
    var neededAncestors = collectNeededAncestors(node, [selector], ancestryMap, fallbackWrapper);

    if (neededAncestors.length > 0) {
      log.push("  Wrapping subtree of \"" + selector + "\" with: " +
        neededAncestors.map(function(a) { return "." + a; }).join(" > "));
    }

    // Strip !important from entire subtree
    var stripped = stripImportantFromTree(node, selector, log);

    // Wrap the whole rule with needed ancestors
    if (neededAncestors.length > 0) {
      return [wrapWithAncestors(stripped, neededAncestors, node.indent)];
    }
    return [stripped];
  }

  return [node];
}

/**
 * Recursively collect all ancestor classes needed by any !important rule
 * in this subtree. Returns deduplicated list of ancestor class names.
 *
 * nestingChain: selectors from root down to (including) this node
 */
function collectNeededAncestors(node, nestingChain, ancestryMap, fallbackWrapper) {
  var needed = [];

  if (node.type === "rule") {
    var hasImportant = node.children.some(function(c) { return c.type === "declaration" && c.important; });
    if (hasImportant) {
      var missing = findMissingAncestors(node.selector, nestingChain.slice(0, -1), ancestryMap, fallbackWrapper);
      missing.forEach(function(a) { if (!needed.includes(a)) needed.push(a); });
    }
    // Recurse into nested rules
    node.children.forEach(function(c) {
      if (c.type === "rule" || c.type === "atrule") {
        var childChain = nestingChain.concat([c.selector || c.name]);
        var childNeeded = collectNeededAncestors(c, childChain, ancestryMap, fallbackWrapper);
        childNeeded.forEach(function(a) { if (!needed.includes(a)) needed.push(a); });
      }
    });
  }

  if (node.type === "atrule" && !node.isMixin && !node.isLoop) {
    node.children.forEach(function(c) {
      var childNeeded = collectNeededAncestors(c, nestingChain, ancestryMap, fallbackWrapper);
      childNeeded.forEach(function(a) { if (!needed.includes(a)) needed.push(a); });
    });
  }

  return needed;
}

/**
 * Strip !important from all declarations in the tree.
 * Converts ID selectors. Does NOT add any wrappers.
 */
function stripImportantFromTree(node, selector, log) {
  if (node.type === "declaration") {
    if (node.important) log.push("  Removed !important: " + node.prop + " in \"" + selector + "\"");
    return Object.assign({}, node, { important: false });
  }

  if (node.type === "rule") {
    var newSel = convertIDsInSelector(node.selector);
    var newChildren = node.children.map(function(c) { return stripImportantFromTree(c, newSel, log); });
    return Object.assign({}, node, { selector: newSel, children: newChildren });
  }

  if (node.type === "atrule") {
    if (node.isMixin || node.isLoop) return node; // don't touch
    var newChildren2 = node.children.map(function(c) { return stripImportantFromTree(c, selector, log); });
    return Object.assign({}, node, { children: newChildren2 });
  }

  return node;
}

// ─── Ancestor Resolution ───────────────────────────────────────────────────────

function findMissingAncestors(selector, nestingChain, ancestryMap, fallback) {
  var selectorClasses = classesFrom(selector);
  if (!selectorClasses.length) return [];

  var domChain = null;
  for (var i = selectorClasses.length - 1; i >= 0; i--) {
    if (ancestryMap.has(selectorClasses[i])) { domChain = ancestryMap.get(selectorClasses[i]); break; }
  }

  if (!domChain) {
    // Class not a direct key in the map.
    // Try to infer its ancestors from other chains where it appears as an ancestor.
    // e.g. nav-menu not in map, but appears in nav-link's chain at index 2
    //      so nav-menu's ancestors = nav-link's chain up to index 2
    var inferred = null;
    ancestryMap.forEach(function(chain) {
      if (inferred) return;
      for (var k = 0; k < chain.length; k++) {
        if (chain[k] === selectorClasses[0]) {
          // Found our class in this chain at index k — ancestors are chain[0..k-1]
          inferred = chain.slice(0, k);
          break;
        }
      }
    });
    if (inferred) {
      domChain = inferred.concat(selectorClasses);
    } else {
      // No inference possible — use fallback only at root level
      if (!nestingChain.length) { var fb = fallback.replace(/^\./, ""); return fb ? [fb] : []; }
      return [];
    }
  }

  var chainTokens = [];
  nestingChain.forEach(function(s) { classesFrom(s).forEach(function(t) { chainTokens.push(t); }); });
  selectorClasses.forEach(function(c) { chainTokens.push(c); });

  var highestCoveredIdx = -1;
  for (var j = 0; j < domChain.length; j++) {
    if (isCoveredBy(domChain[j], chainTokens)) { highestCoveredIdx = j; break; }
  }

  if (highestCoveredIdx === -1) return domChain.filter(function(c) { return !isCoveredBy(c, chainTokens); }).slice(0, 2);
  if (highestCoveredIdx === 0)  return [];
  return domChain.slice(0, highestCoveredIdx).filter(function(c) { return !isCoveredBy(c, chainTokens); }).slice(-2);
}

function classesFrom(selector) {
  var tokens = [], m;
  var re1 = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g;
  while ((m = re1.exec(selector)) !== null) tokens.push(m[1]);
  var skip = ["not","is","has","where","nth","first","last","only","hover","focus",
              "active","visited","checked","disabled","before","after","root","host",
              "important","and","or","even","odd"];
  var re2 = /(?<![.#&:([\w])([a-zA-Z][a-zA-Z0-9-]*)(?![\w-]*[({])/g;
  while ((m = re2.exec(selector)) !== null) { if (!skip.includes(m[1])) tokens.push(m[1]); }
  return tokens;
}

function isCoveredBy(domClass, chainTokens) {
  if (chainTokens.includes(domClass)) return true;
  for (var i = 0; i < chainTokens.length; i++) {
    var t = chainTokens[i];
    // Element approximation: "header" in chain covers DOM class "site-header"
    if (/^[a-z][a-z0-9]*$/.test(t) && t.length > 1 && domClass.includes(t)) return true;
  }
  return false;
}

function convertIDsInSelector(sel) {
  return sel.replace(/(?<![a-zA-Z0-9_-])#([a-zA-Z_][a-zA-Z0-9_-]*)/g, function(_, id) { return ".id-" + id; });
}

// ─── Wrapping ─────────────────────────────────────────────────────────────────

function wrapWithAncestors(node, ancestors, baseIndent) {
  var current = node;
  for (var i = ancestors.length - 1; i >= 0; i--) {
    var a = ancestors[i], sel = /^[.&#@]/.test(a) ? a : "." + a;
    current = { type: "rule", selector: sel, indent: baseIndent, children: [current] };
  }
  return current;
}

// ─── Serializer ───────────────────────────────────────────────────────────────

function serializeNode(node, depth) {
  var pad = "  ".repeat(depth);
  if (!node) return "";
  if (node.type === "raw" || node.type === "comment") return node.raw || "";
  if (node.type === "declaration") return pad + node.prop + ": " + node.value + ";\n";
  if (node.type === "atrule" && (node.isMixin || node.isLoop) && node.verbatim) return node.verbatim;
  if (node.type === "rule" || node.type === "atrule") {
    var hdr = node.type === "rule"
      ? pad + node.selector
      : pad + node.name + (node.params ? " " + node.params : "");
    if (!node.children || !node.children.length) return hdr + " {}\n";
    var body = node.children.map(function(c) { return serializeNode(c, depth + 1); }).join("");
    return hdr + " {\n" + body + pad + "}\n";
  }
  return "";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function collectImportantDecls(node) {
  var out = [];
  if (!node.children) return out;
  node.children.forEach(function(c) {
    if (c.type === "declaration" && c.important) out.push(c);
    else out = out.concat(collectImportantDecls(c));
  });
  return out;
}

module.exports = { fixSCSS: fixSCSS, reportSCSSIssues: reportSCSSIssues };
