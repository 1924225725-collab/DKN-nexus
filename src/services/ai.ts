import type { AppCategory, AppClassification, ChatMessage, NexusApp, NexusSettings } from "../domain";
import { DeepSeekProvider } from "../providers/deepSeek";
import { BochaSearchProvider } from "../providers/bocha";
import { loadSecret } from "./secrets";

export function needsWebSearch(prompt: string): boolean { return /(今天|现在|最新|近期|新闻|价格|多少钱|更新|驱动|版本|官网|实时|最近)/i.test(prompt); }

export function classifyApplicationLocally(app: NexusApp): { category: AppCategory; type: AppClassification; show: boolean; confidence: number } {
  const value = `${app.name} ${app.launchTarget} ${app.shortcutPath ?? ""} ${app.publisher ?? ""} ${app.productName ?? ""} ${app.fileDescription ?? ""}`.toLowerCase();
  const has = (terms: string[]) => terms.some((term) => value.includes(term));
  if (has(["uninstall", "uninstaller", "unins", "remove", "repair", "maintenance"])) return { category: "system-tool", type: "uninstaller", show: false, confidence: .98 };
  if (has(["setup", "installer", "installshield", "install.exe", "setup.exe"])) return { category: "system-tool", type: "installer", show: false, confidence: .96 };
  if (has(["runtime", "redistributable", "vcredist", "java runtime", "jre", "dotnet", "framework", "sdk"])) return { category: "system-tool", type: "runtime", show: false, confidence: .94 };
  if (has(["updater", "update service", "crash reporter", "error reporter", "helper", "background task", "readme", "documentation", "tutorials", "help", "license"]) || /\.(chm|html?|url|pdf|txt)$/i.test(app.launchTarget)) return { category: "system-tool", type: has(["updater", "update service"]) ? "updater" : "helper", show: false, confidence: .9 };
  if (has(["chatgpt", "deepseek", "claude", "copilot", "cursor", "perplexity", "openai"])) return { category: "ai", type: "normal-app", show: true, confidence: .88 };
  if (has(["visual studio", "vs code", "jetbrains", "terminal", "git", "node", "python", "android studio", "developer"])) return { category: "development", type: "developer-tool", show: true, confidence: .9 };
  if (has(["chrome", "firefox", "edge", "brave", "opera", "vivaldi", "browser"])) return { category: "browser", type: "normal-app", show: true, confidence: .9 };
  if (has(["obs studio", "obs64.exe", "studio one", "afterfx", "premiere", "photoshop", "jianying", "剪映", "直播伴侣"])) return { category: "media", type: "normal-app", show: true, confidence: .9 };
  if (has(["steam", "steamapps", "epic games", "riot games", "battle.net", "ubisoft", "ea games", "origin games", "rockstar games", "xboxgames", "minecraft", "gog galaxy", "playnite", "heroic", "game launcher", "\\games\\", "\\game\\", "wegame", "wegameapps", "gamepp", "5eclient", "5e对战", "三角洲行动", "delta force", "完美世界竞技", "无畏契约", "英雄联盟", "aimlab", "aim lab", "playgtav", "grand theft auto", "cyberpunk", "redprelauncher", "ghostrunner", "puzzlegame", "plain craft launcher", "leigod", "游戏加加", "无极画质", "valve", "electronic arts", "bethesda", "cd projekt", "blizzard", "activision", "bandai namco", "square enix", "capcom", "mihoyo", "hoyoverse"])) return { category: "game", type: "normal-app", show: true, confidence: .93 };
  if (has(["word", "excel", "powerpoint", "office", "notion", "obsidian", "libreoffice", "wps"])) return { category: "office", type: "normal-app", show: true, confidence: .84 };
  if (has(["spotify", "vlc", "itunes", "premiere", "photoshop", "music", "video"])) return { category: "media", type: "normal-app", show: true, confidence: .82 };
  if (has(["discord", "slack", "telegram", "wechat", "weixin", "qq", "teams", "zoom", "skype"])) return { category: "social", type: "normal-app", show: true, confidence: .84 };
  return { category: "other", type: app.classification ?? "unknown", show: true, confidence: .35 };
}

export async function testDeepSeekConnection(settings: NexusSettings): Promise<void> {
  const key = await loadSecret("deepseek-api-key");
  if (!key) throw new Error("请先保存 DeepSeek API Key。");
  await new DeepSeekProvider(settings.deepSeekBaseUrl, key, settings.deepSeekModel).complete("请仅回复 OK");
}

export async function classifyApplicationWithAI(app: NexusApp, settings: NexusSettings): Promise<{ category: AppCategory; type: AppClassification; show: boolean; confidence: number; usage?: { promptTokens?: number; completionTokens?: number } }> {
  const key = await loadSecret("deepseek-api-key");
  if (!key) throw new Error("请先保存 DeepSeek API Key。");
  const provider = new DeepSeekProvider(settings.deepSeekBaseUrl, key, settings.deepSeekModel);
  const result = await provider.chat([{ role: "system", content: "你是 Windows 应用分类器。综合快捷方式名称、EXE 路径、产品名、文件描述、发行商判断。游戏本体和游戏平台必须归入 game；卸载器、安装器、更新器、运行库和辅助进程应设为 show=false。只输出 JSON，不要 Markdown。category 只能是 ai/development/game/office/browser/media/social/system-tool/other；type 只能是 normal-app/runtime/system-component/uninstaller/installer/updater/helper/developer-tool/unknown；show 必须是 boolean；confidence 是 0 到 1 的数字。" }, { role: "user", content: JSON.stringify({ name: app.name, target: app.launchTarget, shortcutPath: app.shortcutPath, publisher: app.publisher, productName: app.productName, fileDescription: app.fileDescription, currentType: app.classification, currentCategory: app.category }) }]);
  const match = result.content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI 分类返回格式无法解析。");
  const parsed = JSON.parse(match[0]) as Partial<{ category: AppCategory; type: AppClassification; show: boolean; confidence: number }>;
  const categories: AppCategory[] = ["ai", "development", "game", "office", "browser", "media", "social", "system-tool", "other"];
  const types: AppClassification[] = ["normal-app", "runtime", "system-component", "uninstaller", "installer", "updater", "helper", "developer-tool", "unknown"];
  return { category: categories.includes(parsed.category as AppCategory) ? parsed.category as AppCategory : "other", type: types.includes(parsed.type as AppClassification) ? parsed.type as AppClassification : "unknown", show: parsed.show !== false, confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0, usage: result.usage };
}

export async function askNexus(messages: ChatMessage[], settings: NexusSettings, forceSearch: boolean, signal?: AbortSignal) {
  const deepSeekKey = await loadSecret("deepseek-api-key");
  if (!deepSeekKey) throw new Error("请先在设置中保存 DeepSeek API Key。");
  let searchResults: ReadonlyArray<{ title: string; url: string; content?: string }> = [];
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const shouldSearch = forceSearch || needsWebSearch(latestUserMessage);
  if (shouldSearch) {
    const searchKey = await loadSecret("bocha-api-key");
    if (!searchKey) throw new Error("当前问题需要联网搜索，请先在设置中保存博查 Search API Key。");
    searchResults = await new BochaSearchProvider(searchKey).search(latestUserMessage, signal);
  }
  const context = searchResults.length ? `\n\n联网搜索结果（仅使用必要信息，并在回答中保留来源 URL）：\n${searchResults.map((item, index) => `${index + 1}. ${item.title}\nURL: ${item.url}\n摘要: ${item.content ?? ""}`).join("\n")}` : "";
  const provider = new DeepSeekProvider(settings.deepSeekBaseUrl, deepSeekKey, settings.deepSeekModel);
  const result = await provider.chat([{ role: "system", content: `你是 DKN Nexus 的中文助手。回答要简洁、准确；不要声称自己访问了不存在的来源。${context}` }, ...messages], signal);
  return { ...result, searched: searchResults.length > 0, sources: searchResults };
}
