/**
 * lib/reporter.js
 * Format issue reports for CLI output.
 */

function formatReport(issues) {
  const lines = [];

  if (issues.importantCount === 0 && issues.idSelectorCount === 0) {
    lines.push("  ✅ No issues found — file is clean!");
    return lines.join("\n");
  }

  lines.push(`  Issues found:`);

  if (issues.importantCount > 0) {
    lines.push(`  🚫 !important declarations : ${issues.importantCount}`);
  }

  if (issues.idSelectorCount > 0) {
    lines.push(`  🏷️  ID selectors            : ${issues.idSelectorCount}`);
    if (issues.idSelectors && issues.idSelectors.length > 0) {
      const preview = issues.idSelectors.slice(0, 10);
      lines.push(`     Found: ${preview.join(", ")}${issues.idSelectors.length > 10 ? ` … and ${issues.idSelectors.length - 10} more` : ""}`);
      lines.push(`     These will be renamed: #foo → .id-foo`);
      lines.push(`     ⚠️  Remember to update matching HTML id="foo" → class="id-foo"`);
    }
  }

  return lines.join("\n");
}

module.exports = { formatReport };
// Updated to accept unmatched classes
const originalFormatReport = module.exports.formatReport;
module.exports.formatReport = function formatReport(issues, unmatched = []) {
  const lines = [];

  if (issues.importantCount === 0 && issues.idSelectorCount === 0) {
    lines.push("  ✅ No issues found — file is clean!");
  } else {
    lines.push(`  Issues found:`);
    if (issues.importantCount > 0)
      lines.push(`  🚫 !important declarations : ${issues.importantCount}`);
    if (issues.idSelectorCount > 0) {
      lines.push(`  🏷️  ID selectors            : ${issues.idSelectorCount}`);
      if (issues.idSelectors?.length > 0) {
        const preview = issues.idSelectors.slice(0, 10);
        lines.push(`     Found: ${preview.join(", ")}${issues.idSelectors.length > 10 ? ` …+${issues.idSelectors.length - 10}` : ""}`);
      }
    }
  }

  if (unmatched.length > 0) {
    lines.push(`\n  ⚠️  Unmatched classes (will use fallback wrapper): ${unmatched.length}`);
    lines.push(`     ${unmatched.slice(0, 12).join(", ")}${unmatched.length > 12 ? ` …+${unmatched.length - 12} more` : ""}`);
    lines.push(`     → Add more --url pages to your crawl to improve specificity coverage`);
  } else if (issues.importantCount > 0) {
    lines.push(`\n  ✅ All classes found in DOM/Twig — real ancestor specificity will be used`);
  }

  return lines.join("\n");
};
