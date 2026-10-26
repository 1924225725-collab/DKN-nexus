/**
 * Syntax-checks the JavaScript embedded in the Rust CDP module.
 *
 * The probe/control scripts live as Rust raw string literals, so a typo would
 * only surface against a real NetEase client. This extracts each `r#"..."#`
 * constant and parses it with `new Function`, which validates syntax without
 * executing anything (no DOM, no network, no client required).
 *
 * Run with: node --experimental-strip-types tests/check-cdp-scripts.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("../src-tauri/src/netease_cdp.rs", import.meta.url));
const source = readFileSync(sourcePath, "utf8");

const scripts = [];
const pattern = /const\s+([A-Z_]+_SCRIPT)\s*:\s*&str\s*=\s*r#"([\s\S]*?)"#;/g;
for (const match of source.matchAll(pattern)) {
  scripts.push({ name: match[1], body: match[2] });
}

if (scripts.length === 0) {
  console.error("No embedded CDP scripts were found; the extraction pattern needs updating.");
  process.exit(1);
}

let failed = 0;
for (const { name, body } of scripts) {
  // Replacements are applied at runtime; supply inert stand-ins so the
  // placeholder tokens are valid JavaScript during the syntax check.
  const prepared = body.replaceAll("__ACTION__", '"toggle"').replaceAll("__POSITION__", "0");
  try {
    new Function(prepared);
    console.log(`ok   ${name} (${prepared.length} chars)`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

console.log(`\n${scripts.length - failed}/${scripts.length} embedded CDP scripts parse.`);
process.exit(failed === 0 ? 0 : 1);
