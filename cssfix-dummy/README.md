# cssfix

Drupal CSS refactor tool. Removes `!important` and ID selectors from CSS files,
and replaces them with proper class specificity built from your **real rendered DOM** —
including PHP preprocess classes, Twig conditional classes, and everything else.

Zero dependencies. Pure Node.js. Requires Node >= 14.

---

## Install

### Option 1 — Global CLI (use `cssfix` anywhere)
```bash
npm install -g .
cssfix ./css fix --site http://localhost --twig ./templates
```

### Option 2 — Project scripts (add to your theme's package.json)
Copy this tool into your Drupal theme folder, then add to your theme's `package.json`:
```json
{
  "scripts": {
    "cssfix":   "node path/to/cssfix/cssfix.js",
    "crawl":    "node path/to/cssfix/cssfix.js . crawl --site http://localhost --twig ./templates",
    "report":   "node path/to/cssfix/cssfix.js ./css report",
    "preview":  "node path/to/cssfix/cssfix.js ./css preview",
    "fix":      "node path/to/cssfix/cssfix.js ./css fix"
  }
}
```
Then run:
```bash
npm run crawl
npm run report
npm run fix
```

### Option 3 — No install, run directly
```bash
node cssfix.js ./css fix --site http://localhost --twig ./templates
```

---

## Workflow

### Step 1 — Crawl your live site
```bash
# Local (plain HTTP)
npm run crawl
# or with custom site URL:
node cssfix.js . crawl --site http://localhost --twig ./templates

# ddev
node cssfix.js . crawl --site https://mysite.ddev.site --ignore-tls --twig ./templates

# Lando
node cssfix.js . crawl --site https://mysite.lndo.site --ignore-tls --twig ./templates

# Staging with auth
node cssfix.js . crawl --site https://staging.mysite.com --auth user:pass --twig ./templates
```

The crawler:
1. Checks `sitemap.xml` first — gets all URLs instantly if your site has one (Simple XML Sitemap module)
2. Falls back to spidering from `/` if no sitemap, following internal links up to `--max-depth` levels
3. Fetches all pages concurrently and builds a class ancestry map from the **real rendered HTML**
4. Supplements with Twig template parsing to fill any gaps
5. Saves everything to `.cssfix-cache.json`

This captures **all** classes regardless of how they were added:
- PHP `hook_preprocess_*` classes (`node--type-article`, `field--name-body`, etc.)
- Twig `{% set classes %}` and conditionals (`is-active`, `menu-item--expanded`, etc.)
- Drupal core/module injected classes
- Static template classes

> JS-only classes added after page load (e.g. `.modal-open` toggled by jQuery) can't be
> captured without a headless browser. These fall back to the `--wrapper` selector (default: `body`).

### Step 2 — Check coverage before fixing
```bash
npm run report
# or:
node cssfix.js ./css report
```

Output:
```
📊 Coverage: 91% matched  [████████████████████████████··]
   141 of 155 CSS classes found in crawled DOM

⚠️  Unmatched classes (fallback to "body"):
   📄 css/components.css (8 unmatched):
      .modal-open  .js-processed  .ajax-progress ...

   💡 To improve coverage:
      • Add more --url pages that use these classes
      • Check if these classes are JS-only (added after page load)
```

If coverage is low, crawl more pages:
```bash
node cssfix.js . crawl \
  --site http://localhost \
  --url http://localhost/node/1 \
  --url http://localhost/node/2 \
  --url http://localhost/user/login \
  --max-pages 200
```

### Step 3 — Preview changes
```bash
npm run preview
# or:
node cssfix.js ./css preview
```

### Step 4 — Apply fixes
```bash
npm run fix
# or:
node cssfix.js ./css fix
```

- Fixes all `.css` files in the directory
- Creates `.bak` backup of every file before modifying
- Removes all `!important` declarations
- Prepends real ancestor classes for equivalent specificity
- Converts `#id` selectors to `.id-name` class equivalents

---

## What it changes

### `!important` removal + specificity boost

**Before:**
```css
.nav-link { color: blue !important; }
.block-title { font-size: 1.2rem !important; }
```

**After** (ancestors sourced from your real DOM):
```css
.site-header .nav-menu .nav-link { color: blue; }
.block-system .block-inner .block-title { font-size: 1.2rem; }
```

For classes not found in DOM/Twig, falls back to:
```css
body .modal-open { overflow: hidden; }
```

### ID selector conversion

**Before:**
```css
#page-wrapper { max-width: 1200px; }
[id="sidebar-first"] { width: 300px; }
```

**After:**
```css
.id-page-wrapper { max-width: 1200px; }
.id-sidebar-first { width: 300px; }
```

> After running fix, add `class="id-page-wrapper"` to the matching HTML elements.
> The `report` command lists every ID that needs updating in your Twig templates.

---

## All options

```
cssfix <file|dir> <command> [options]

Commands:
  crawl      Discover pages + cache DOM ancestry (run this first)
  fix        Apply fixes in-place (creates .bak backup)
  preview    Dry-run — show what would change
  report     Coverage: matched vs unmatched classes

Crawl options:
  --site <url>        Base URL of your Drupal site (required for crawl)
  --url <url>         Extra URL to include (repeatable)
  --twig <dir>        Templates dir (supplements DOM crawl)
  --max-pages <n>     Crawl limit (default: 80)
  --max-depth <n>     Spider link depth (default: 4)

Fix options:
  --wrapper <sel>     Fallback selector for unmatched classes (default: body)
  --cache <file>      Cache path (default: .cssfix-cache.json)
  --no-cache          Ignore existing cache

Auth:
  --auth <user:pass>  HTTP Basic auth
  --ignore-tls        Skip TLS cert verification (ddev/lando/local certs)
```

---

## Run tests

```bash
npm test
```
