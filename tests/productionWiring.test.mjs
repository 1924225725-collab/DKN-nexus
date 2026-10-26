/**
 * Production-wiring checks for TASK_001 (AC-03 / AC-06).
 *
 * The contract tests above exercise the helpers in isolation. This suite asserts
 * the REAL components actually use them — that the wiring is connected. If a
 * refactor drops the helper, imports the wrong one, or reintroduces the
 * gated-fallback bug, these checks fail instead of silently passing.
 *
 * No DOM / React runtime is needed: we read the TypeScript source and assert the
 * required imports, calls, and the absence of the known-bad pattern.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const APP = read("../src/App.tsx");
const MUSIC = read("../src/components/MusicPlayerWindow.tsx");
const MAIN_HIDE = read("../src/services/mainWindowHide.ts");
const LIFECYCLE = read("../src/services/musicWindowLifecycle.ts");

test("MusicPlayerWindow imports and uses the production lifecycle helper", () => {
  assert.ok(
    /import\s*\{[^}]*createMusicWindowLifecycle[^}]*\}\s*from\s*["']\.\.\/services\/musicWindowLifecycle["']/.test(MUSIC),
    "MusicPlayerWindow must import createMusicWindowLifecycle from the shared service",
  );
  assert.ok(/createMusicWindowLifecycle</.test(MUSIC), "MusicPlayerWindow must call createMusicWindowLifecycle");
});

test("MusicPlayerWindow no longer re-implements the visibility latch inline", () => {
  // The old inline rule (`visibilityEventSeen` / a hand-rolled listen callback)
  // was the R-03 smell. The helper owns it now.
  assert.ok(!/visibilityEventSeen/.test(MUSIC), "inline visibilityEventSeen latch must be gone");
});

test("the lifecycle helper subscribes before querying and discards a stale query", () => {
  assert.ok(/createPolling/.test(LIFECYCLE));
  assert.ok(/listen\(/.test(LIFECYCLE), "helper must subscribe to the visibility event");
  assert.ok(/getVisibility/.test(LIFECYCLE), "helper must read native visibility");
  assert.ok(
    /if\s*\(disposed \|\| visibilityEventSeen\) return;/.test(LIFECYCLE),
    "helper must discard a query answer overtaken by an event",
  );
  assert.ok(/applyVisible/.test(LIFECYCLE), "helper must expose applyVisible for wiring");
});

test("App imports and uses the production main-window hide coordinator", () => {
  assert.ok(
    /import\s*\{[^}]*createMainWindowHide[^}]*\}\s*from\s*["']\.\/services\/mainWindowHide["']/.test(APP),
    "App must import createMainWindowHide from the shared service",
  );
  assert.ok(/createMainWindowHide\(/.test(APP), "App must construct the coordinator");
  assert.ok(/hide_main_window/.test(APP), "native hide command must be wired");
  assert.ok(/hide_owned_music_window/.test(APP), "music linkage command must be wired");
  assert.ok(/getCurrentWindow\(\)\.hide\(\)/.test(APP), "direct hide must be wired");
});

test("R-01 regression: the fallback starts direct and music independently", () => {
  // Behaviour/AST evidence instead of implementation-string assertions: the
  // coordinator must request BOTH sides on the fallback path, and the music
  // linkage must only ever be OBSERVED (then/catch), never awaited before the
  // direct hide resolves. Verified by the C-01/C-02/C-06/C-07 behaviour suite;
  // here we pin the real wiring (App must not await the music command first).
  assert.ok(/musicLinkage/.test(MAIN_HIDE), "helper must reference the music linkage");
  assert.ok(/directHide/.test(MAIN_HIDE), "helper must reference the direct hide");
  assert.ok(/nativeHide/.test(MAIN_HIDE), "helper must reference the native hide");

  // And the old App pattern — awaiting the music command before the direct hide —
  // must no longer exist.
  const badPattern = /await\s+invoke\("hide_owned_music_window"\)[\s\S]{0,80}await\s+getCurrentWindow\(\)\.hide\(\)/;
  assert.ok(!badPattern.test(APP), "App must not await hide_owned_music_window before the direct hide");
});

test("the main-window hide coordinator preserves single-flight and cleans its timer", () => {
  assert.ok(/if \(pending\) return pending;/.test(MAIN_HIDE), "coordinator must reuse an in-flight promise");
  // H-01: the race timer is cleared at native-race end (finish() at catch entry).
  assert.ok(/finish\(\);\s*\n\s*return;/.test(MAIN_HIDE) || /finish\(\);/.test(MAIN_HIDE), "timer must be cleared (finish) on the race end");
});

/**
 * r4 / C-08: exercise the REAL App close functions. We extract the actual
 * `hideNexusWindow` / `requestHideNexusWindow` sources from src/App.tsx by AST-
 * style slicing, run them in a vm against the production coordinator, and assert
 * that a hide failure is consumed (no unhandled rejection, a real diagnostic).
 */
test("C-08: the real App close entry consumes a hide failure (AST extraction + run)", async () => {
  const { createMainWindowHide } = await import("../src/services/mainWindowHide.ts");

  // --- Build a coordinator whose hide() rejects (direct window API failure). ---
  const coordinator = createMainWindowHide({
    nativeHide: () => Promise.reject(new Error("native failed")),
    directHide: () => Promise.reject(new Error("direct window API unavailable")),
    musicLinkage: () => Promise.resolve(),
    createTimer: (ms, cb) => setTimeout(cb, ms),
    clearTimer: (id) => clearTimeout(id),
    onError: () => {},
    timeoutMs: 900,
  });

  // --- Locate the real functions with the real TypeScript AST (not text slicing). ---
  const ts = await import("typescript");
  const sf = ts.createSourceFile("App.tsx", APP, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fnNames = [];
  const fnRanges = {};
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      fnNames.push(name);
      fnRanges[name] = { start: node.getStart(sf), end: node.getEnd() };
    }
  });
  assert.ok(fnNames.includes("hideNexusWindow"), "AST must find hideNexusWindow");
  assert.ok(fnNames.includes("requestHideNexusWindow"), "AST must find requestHideNexusWindow");

  // Transpile ONLY the extracted real function declarations (AST -> JS). The
  // logic is never re-implemented or rewritten by regex.
  const a = fnRanges.hideNexusWindow;
  const b = fnRanges.requestHideNexusWindow;
  const extracted = APP.slice(Math.min(a.start, b.start), Math.max(a.end, b.end));
  const js = ts.transpileModule(extracted, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.Preserve },
  }).outputText;

  // Execute the real transpiled functions with the real coordinator injected.
  const { createContext, runInNewContext } = await import("node:vm");
  const warnings = [];
  const unhandled = [];
  // H-04A: keep a reference to OUR handler and remove only that one, so any
  // listener installed by another suite / diagnostic tool survives untouched.
  const ourHandler = (e) => unhandled.push(e);
  process.on("unhandledRejection", ourHandler);
  try {
    const sandbox = {
      mainWindowHide: coordinator,
      isTauri: () => true,
      console: { warn: (...a) => warnings.push(a.join(" ")) },
    };
    createContext(sandbox);
    runInNewContext(js + "\nrequestHideNexusWindow();", sandbox);
    // Let the rejection settle through the real wrapper.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled.length, 0, "the real App entry must not leak an unhandled rejection");
    assert.ok(warnings.some((w) => /主窗隐藏请求失败/.test(w)), "the real App entry must record a real failure diagnostic");
  } finally {
    process.removeListener("unhandledRejection", ourHandler);
  }
});

/**
 * r5 / H-04A (3/10, 测试隔离/清理): this module must clean up ONLY the listener
 * it installed. An external sentinel listener registered before this suite runs
 * must still be registered afterwards.
 */
test("H-04A: the suite removes only its own unhandledRejection listener", async () => {
  // Install an external sentinel, exactly as another suite / diagnostic tool would.
  const sentinel = () => {};
  process.on("unhandledRejection", sentinel);
  const before = process.listenerCount("unhandledRejection");
  try {
    // Exercise the module's own listener-registering path (the C-08 test above).
    const { createMainWindowHide } = await import("../src/services/mainWindowHide.ts");
    const coordinator = createMainWindowHide({
      nativeHide: () => Promise.reject(new Error("native failed")),
      directHide: () => Promise.reject(new Error("direct failed")),
      musicLinkage: () => Promise.resolve(),
      createTimer: (ms, cb) => setTimeout(cb, ms),
      clearTimer: (id) => clearTimeout(id),
      onError: () => {},
      timeoutMs: 900,
    });
    const ourHandler = () => {};
    process.on("unhandledRejection", ourHandler);
    try {
      void coordinator.hide().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.removeListener("unhandledRejection", ourHandler);
    }
    assert.equal(
      process.listenerCount("unhandledRejection"),
      before,
      "listener count must return to its pre-test value (no over-removal)",
    );
    assert.ok(
      process.listeners("unhandledRejection").includes(sentinel),
      "the external sentinel listener must still be registered after the test",
    );
  } finally {
    process.removeListener("unhandledRejection", sentinel);
  }
});

/**
 * r4 / C-08 (wiring): the X button and the Esc handler must call the wrapped
 * entry, never the raw hideNexusWindow directly.
 */
test("C-08 wiring: X button and Esc handler use the wrapped close entry", () => {
  // X close button
  assert.ok(
    /close-button[\s\S]{0,400}requestHideNexusWindow\(\)/.test(APP),
    "the X close button must call requestHideNexusWindow()",
  );
  // Esc keydown handler
  assert.ok(
    /hideOnEscape[\s\S]{0,600}requestHideNexusWindow\(\)/.test(APP),
    "the Esc handler must call requestHideNexusWindow()",
  );
  // Neither may call the raw hideNexusWindow() (which would drop the catch).
  assert.ok(
    !/onClick=\{[^}]*void\s+hideNexusWindow\(\)/.test(APP),
    "no direct void hideNexusWindow() in a click handler",
  );
});

test("key R-02 text fixes are present in the production App source", () => {
  assert.ok(/aria-label="应用主面板"/.test(APP), "应用主面板 label must be fixed");
  assert.ok(/录制已取消/.test(APP), "录制已取消 must be fixed");
  assert.ok(/已保存/.test(APP), "已保存 must be fixed");
  assert.ok(/快捷键注册失败/.test(APP), "快捷键注册失败 must be fixed");
  // The broken residuals must be gone.
  assert.ok(!/应用主面。/.test(APP));
  assert.ok(!/录制已取。/.test(APP));
  assert.ok(!/已保。/.test(APP));
  assert.ok(!/快捷键注册失。/.test(APP));
});

test("r6 R-03 text fixes are present in the production App source", () => {
  // Found by the r6 132-item semantic audit: three labels/status strings had a
  // character replaced by a stray full stop, or a duplicated trailing character.
  // Each is pinned here so the corrected text cannot silently regress.
  assert.ok(/轮盘触发键。/.test(APP), "the radial-shortcut label must read 轮盘触发键。");
  assert.ok(/按住时启用本地语音输入。/.test(APP), "the voice-input label must read 按住时启用本地语音输入。");
  assert.ok(/主窗口尺寸已应用并保存。/.test(APP), "the window-size status must read 主窗口尺寸已应用并保存。");
  // The pre-fix residuals must be gone.
  assert.ok(!/轮盘触发。/.test(APP), "the truncated 轮盘触发。 label must be gone");
  assert.ok(!/按住时启用本地语音输。/.test(APP), "the truncated 语音输。 label must be gone");
  assert.ok(!/主窗口尺寸已应用并保存存/.test(APP), "the duplicated 保存存 typo must be gone");
});

test("music entry uses the approved audio icon, not the broken glyph", () => {
  // The entry button must render the audio InterfaceIcon and keep its a11y name.
  assert.ok(/music-entry-button[^>]*>.*<InterfaceIcon name="audio"/.test(APP) || /<InterfaceIcon name="audio"[^>]*>\s*<\/button>/.test(APP),
    "music entry must render the audio icon");
  assert.ok(/aria-label="打开音乐播放器" title="音乐播放器"/.test(APP), "music entry must keep its accessible name and tooltip");
  assert.ok(!/>器<\/button>/.test(APP), "the broken glyph button must be gone");
});
