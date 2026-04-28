/**
 * lib/git.js
 *
 * Git-aware helpers for cssfix:
 *   - Detect if we're inside a git repo
 *   - Check for uncommitted changes before fixing
 *   - Run git diff after fixing to show what changed
 *   - Auto-stash before fix, pop after (--git-stash mode)
 */

const { execSync, spawnSync } = require("child_process");
const path = require("path");

// ─── Git detection ─────────────────────────────────────────────────────────────

function isGitRepo(dir = process.cwd()) {
  try {
    execSync("git rev-parse --git-dir", { cwd: dir, stdio: "pipe" });
    return true;
  } catch (_) { return false; }
}

function getGitRoot(dir = process.cwd()) {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd: dir, stdio: "pipe" })
      .toString().trim();
  } catch (_) { return null; }
}

// ─── Status checks ─────────────────────────────────────────────────────────────

/**
 * Returns list of CSS files that have uncommitted changes.
 */
function getDirtyFiles(cssFiles, dir = process.cwd()) {
  try {
    const status = execSync("git status --porcelain", { cwd: dir, stdio: "pipe" }).toString();
    const dirtyPaths = status.split("\n")
      .filter(l => l.trim())
      .map(l => path.resolve(dir, l.slice(3).trim()));
    return cssFiles.filter(f => dirtyPaths.includes(path.resolve(f)));
  } catch (_) { return []; }
}

/**
 * Check if working tree is clean (no unstaged/staged changes at all).
 */
function isWorkingTreeClean(dir = process.cwd()) {
  try {
    const out = execSync("git status --porcelain", { cwd: dir, stdio: "pipe" }).toString().trim();
    return out === "";
  } catch (_) { return false; }
}

// ─── Stash ─────────────────────────────────────────────────────────────────────

const STASH_MESSAGE = "cssfix: auto-stash before fix";

function stash(dir = process.cwd()) {
  try {
    const out = execSync(`git stash push -m "${STASH_MESSAGE}" --include-untracked`, {
      cwd: dir, stdio: "pipe",
    }).toString().trim();
    // "No local changes to save" means nothing was stashed
    if (out.includes("No local changes")) return { stashed: false };
    return { stashed: true };
  } catch (e) {
    throw new Error(`git stash failed: ${e.message}`);
  }
}

function stashPop(dir = process.cwd()) {
  try {
    execSync("git stash pop", { cwd: dir, stdio: "pipe" });
    return true;
  } catch (e) {
    throw new Error(`git stash pop failed: ${e.message}\nRun "git stash pop" manually.`);
  }
}

// ─── Diff ──────────────────────────────────────────────────────────────────────

/**
 * Show git diff for the given CSS files.
 * Uses --color=always so the diff is colored in terminal.
 * Falls back to a manual line-by-line diff if git diff returns nothing
 * (happens when files aren't tracked yet).
 */
function showDiff(cssFiles, dir = process.cwd()) {
  const relative = cssFiles.map(f => path.relative(dir, f));

  // git diff for tracked files (shows changes vs last commit)
  const result = spawnSync(
    "git", ["diff", "--color=always", "--stat", "--", ...relative],
    { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );

  if (result.stdout && result.stdout.trim()) {
    process.stdout.write(result.stdout);
    // Full diff
    const full = spawnSync(
      "git", ["diff", "--color=always", "-U3", "--", ...relative],
      { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    if (full.stdout) process.stdout.write(full.stdout);
    return true;
  }

  // Files may be untracked — fall back to bak comparison
  return false;
}

/**
 * Manual diff between .bak and current file when git diff isn't available.
 * Shows colored line-level diff.
 */
function showBakDiff(cssFiles) {
  const fs = require("fs");
  let anyDiff = false;

  for (const filePath of cssFiles) {
    const bakPath = filePath + ".bak";
    if (!fs.existsSync(bakPath)) continue;

    const before = fs.readFileSync(bakPath, "utf8").split("\n");
    const after  = fs.readFileSync(filePath, "utf8").split("\n");

    const changes = diffLines(before, after);
    if (changes.length === 0) continue;

    anyDiff = true;
    const shortPath = filePath.split("/").slice(-2).join("/");
    console.log(`\n\x1b[1m--- ${shortPath}.bak\x1b[0m`);
    console.log(`\x1b[1m+++ ${shortPath}\x1b[0m`);

    for (const chunk of changes) {
      console.log(`\x1b[36m@@ -${chunk.fromLine} +${chunk.toLine} @@\x1b[0m`);
      for (const line of chunk.lines) {
        if (line.startsWith("-")) console.log(`\x1b[31m${line}\x1b[0m`);
        else if (line.startsWith("+")) console.log(`\x1b[32m${line}\x1b[0m`);
        else console.log(` ${line}`);
      }
    }
  }
  return anyDiff;
}

/**
 * Simple line diff — returns chunks of changes with context (3 lines).
 */
function diffLines(before, after, context = 3) {
  const chunks = [];
  let i = 0, j = 0;

  // Build a simple edit script
  const edits = []; // { type: 'eq'|'del'|'ins', before: string, after: string }

  // LCS-based diff is expensive — use a simpler heuristic for CSS files:
  // walk line by line, treat changed lines as del+ins pairs
  const maxLen = Math.max(before.length, after.length);
  for (let k = 0; k < maxLen; k++) {
    const b = before[k];
    const a = after[k];
    if (b === undefined)      edits.push({ type: "ins", line: a, lineNo: k });
    else if (a === undefined) edits.push({ type: "del", line: b, lineNo: k });
    else if (b === a)         edits.push({ type: "eq",  line: b, lineNo: k });
    else {
      edits.push({ type: "del", line: b, lineNo: k });
      edits.push({ type: "ins", line: a, lineNo: k });
    }
  }

  // Group into chunks with context
  let inChunk = false;
  let chunk = null;
  let lastChangeIdx = -1;

  for (let k = 0; k < edits.length; k++) {
    const edit = edits[k];
    const isChange = edit.type !== "eq";

    if (isChange) {
      if (!inChunk || k - lastChangeIdx > context * 2) {
        if (chunk) chunks.push(chunk);
        // Add context before
        const ctxStart = Math.max(0, k - context);
        chunk = {
          fromLine: ctxStart + 1,
          toLine:   ctxStart + 1,
          lines: edits.slice(ctxStart, k).map(e => ` ${e.line}`),
        };
        inChunk = true;
      }
      lastChangeIdx = k;
      chunk.lines.push((edit.type === "del" ? "-" : "+") + edit.line);
    } else if (inChunk) {
      chunk.lines.push(` ${edit.line}`);
      if (k - lastChangeIdx >= context) {
        chunks.push(chunk);
        chunk = null;
        inChunk = false;
      }
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

// ─── Commit helpers ────────────────────────────────────────────────────────────

/**
 * Stage the fixed CSS files and create a commit.
 */
function commitFixes(cssFiles, dir = process.cwd()) {
  const relative = cssFiles.map(f => path.relative(dir, f));
  try {
    execSync(`git add ${relative.map(f => `"${f}"`).join(" ")}`, { cwd: dir, stdio: "pipe" });
    execSync(`git commit -m "refactor(css): remove !important and ID selectors via cssfix"`, {
      cwd: dir, stdio: "pipe",
    });
    return true;
  } catch (e) {
    throw new Error(`git commit failed: ${e.message}`);
  }
}

module.exports = {
  isGitRepo, getGitRoot, getDirtyFiles, isWorkingTreeClean,
  stash, stashPop, showDiff, showBakDiff, commitFixes,
};
