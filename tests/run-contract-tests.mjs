/**
 * Sequential runner for the DKN Nexus frontend contract tests.
 *
 * Why not `node --test <file>`: that runner spawns a child process per test file
 * through piped stdio, which the Windows sandbox used for this project rejects
 * with `spawn EPERM`. Importing the test modules into this single process
 * sidesteps the restriction while keeping `node:test`'s assertions, TAP output
 * and non-zero exit code on failure intact.
 *
 * Requires Node's type stripping (Node 22.6+/24) because the modules under test
 * are TypeScript. Adding a suite: append its relative path to `SUITES`.
 */
const SUITES = [
  "./mediaPolling.test.mjs",
  "./musicVisibilityLatch.test.mjs",
  "./mainWindowHide.test.mjs",
  "./productionWiring.test.mjs",
];

for (const suite of SUITES) {
  // `new URL(...)` keeps the spaces and non-ASCII characters in this project
  // path correctly percent-encoded, so import the resolved file URL directly.
  await import(new URL(suite, import.meta.url).href);
}
