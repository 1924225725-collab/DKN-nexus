import type { NexusApp } from "../domain";

const demoApps: NexusApp[] = [
  { id: "chatgpt", name: "ChatGPT", launchTarget: "chatgpt://", source: "demo", isPinned: true, aliases: ["gpt", "openai"] },
  { id: "vscode", name: "Visual Studio Code", launchTarget: "code", source: "demo", isPinned: true, aliases: ["code", "vs code", "visual studio"] },
  { id: "workbuddy", name: "WorkBuddy", launchTarget: "workbuddy", source: "demo", isPinned: true, aliases: ["buddy"] },
  { id: "discord", name: "Discord", launchTarget: "discord", source: "demo", isPinned: false },
  { id: "steam", name: "Steam", launchTarget: "steam", source: "demo", isPinned: false },
  { id: "studio-one", name: "Studio One", launchTarget: "studio-one", source: "demo", isPinned: false, aliases: ["studio"] },
  { id: "terminal", name: "Windows Terminal", launchTarget: "wt.exe", source: "demo", isPinned: false, aliases: ["terminal", "wt"] },
  { id: "spotify", name: "Spotify", launchTarget: "spotify", source: "demo", isPinned: false },
  { id: "notion", name: "Notion", launchTarget: "notion", source: "demo", isPinned: false },
  { id: "figma", name: "Figma", launchTarget: "figma", source: "demo", isPinned: false }
];
const APP_CACHE_KEY = "dkn-nexus:app-cache";

const normalise = (value: string) => value.toLocaleLowerCase().trim();

function generatedAliases(app: NexusApp): string[] {
  const value = `${app.name} ${app.launchTarget} ${app.publisher ?? ""}`.toLocaleLowerCase();
  const aliases: string[] = [];
  const add = (terms: string[], names: string[]) => { if (terms.some((term) => value.includes(term))) aliases.push(...names); };
  add(["intel", "igfx", "graphics command center"], ["英特尔", "英特尔驱动", "显卡驱动"]);
  add(["nvidia", "geforce", "nvcontainer"], ["英伟达", "nvidia驱动", "显卡驱动"]);
  add(["amd", "radeon"], ["amd驱动", "显卡驱动"]);
  add(["realtek"], ["瑞昱", "声卡驱动", "网卡驱动"]);
  add(["steam"], ["游戏平台", "游戏"]);
  add(["epic games"], ["epic", "游戏平台", "游戏"]);
  add(["chatgpt"], ["聊天机器人", "人工智能", "ai"]);
  add(["visual studio code", "code.exe"], ["代码编辑器", "编程", "开发"]);
  return aliases;
}

export function scoreApp(app: NexusApp, query: string): number {
  const needle = normalise(query);
  if (!needle) return app.isPinned ? 1 : 0;

  const name = normalise(app.name);
  const aliases = [...(app.aliases ?? []), ...generatedAliases(app)].map(normalise);
  const haystacks = [name, normalise(app.displayName ?? ""), normalise(app.note ?? ""), normalise(app.launchTarget), normalise(app.publisher ?? ""), ...aliases];
  let score = 0;

  for (const value of haystacks) {
    if (value === needle) score = Math.max(score, 1000);
    else if (value.startsWith(needle)) score = Math.max(score, 700 - value.length);
    else if (value.includes(needle)) score = Math.max(score, 450 - value.indexOf(needle));
    else {
      let cursor = 0;
      for (const character of needle) {
        const found = value.indexOf(character, cursor);
        if (found === -1) { cursor = -1; break; }
        cursor = found + 1;
      }
      if (cursor !== -1) score = Math.max(score, 180 - (value.length - needle.length));
    }
  }
  return score + (app.isPinned ? 12 : 0);
}

export function searchApps(apps: NexusApp[], query: string): NexusApp[] {
  const needle = normalise(query);
  return apps
    .map((app) => ({ app, score: scoreApp(app, needle) }))
    .filter(({ score }) => !needle || score > 0)
    .sort((a, b) => b.score - a.score || Number(b.app.isPinned) - Number(a.app.isPinned) || a.app.name.localeCompare(b.app.name))
    .map(({ app }) => app);
}

function readCachedApps(): NexusApp[] {
  try { return JSON.parse(localStorage.getItem(APP_CACHE_KEY) ?? "[]") as NexusApp[]; } catch { return []; }
}

export function loadCachedApps(): NexusApp[] { return readCachedApps(); }

export async function scanAppCatalog(): Promise<NexusApp[]> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const scanned = await invoke<NexusApp[]>("list_applications");
    if (scanned?.length) {
      localStorage.setItem(APP_CACHE_KEY, JSON.stringify(scanned));
      return scanned;
    }
  } catch {
    // Browser preview / first-run fallback.
  }
  const cached = readCachedApps();
  return cached.length ? cached : demoApps;
}

export async function loadAppCatalog(): Promise<NexusApp[]> {
  const cached = readCachedApps();
  if (cached.length) return cached;
  const scanned = await scanAppCatalog();
  return scanned.length ? scanned : demoApps;
}

export async function launchApp(app: NexusApp): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("launch_application", { target: app.launchTarget, shortcutPath: app.shortcutPath ?? null });
  } catch {
    // In browser preview, launching is intentionally a no-op.
  }
}

export async function pickApplicationFile(): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string | null>("pick_application_file");
  } catch { return null; }
}
