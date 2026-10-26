export type AppSource = "start-menu" | "desktop" | "registry" | "store" | "custom" | "demo";
export type AppClassification = "normal-app" | "runtime" | "system-component" | "uninstaller" | "installer" | "updater" | "helper" | "developer-tool" | "unknown";
export type BuiltInAppCategory = "ai" | "development" | "game" | "office" | "browser" | "media" | "social" | "system-tool" | "other";
export type AppCategory = BuiltInAppCategory | (string & {});

export interface NexusApp {
  id: string;
  name: string;
  launchTarget: string;
  source: AppSource;
  icon?: string;
  isPinned: boolean;
  aliases?: string[];
  classification?: AppClassification;
  category?: AppCategory;
  note?: string;
  displayName?: string;
  publisher?: string;
  productName?: string;
  fileDescription?: string;
  shortcutPath?: string;
}

export interface NexusSettings {
  visualTheme: "dkn" | "glass";
  launchAtStartup: boolean;
  globalShortcut: string;
  radialShortcut: string;
  radialEnabled: boolean;
  radialVoiceEnabled: boolean;
  aiClassificationEnabled: boolean;
  gameFriendlyMode: boolean;
  categoryIconSize: number;
  filterUnconventionalApps: boolean;
  clipboardHistoryLimit: number;
  notesDirectory: string;
  agentModels: Record<string, string>;
  agentRoleProviders: Record<string, string>;
  agentImageProviders: AgentImageProvider[];
  agentTextProviders: AgentTextProvider[];
  agentWindowMode: "single" | "split";
  textSize: "small" | "standard" | "large";
  uiScale: number;
  reducedMotion: boolean;
  uiSoundsEnabled: boolean;
  uiSoundVolume: number;
  mainWindowWidth: number;
  mainWindowHeight: number;
  agentWindowWidth: number;
  agentWindowHeight: number;
  deepSeekModel: string;
  deepSeekBaseUrl: string;
  searchProvider: "bocha";
}

export interface AgentImageProvider {
  id: string;
  name: string;
  endpointUrl: string;
  model: string;
  size: string;
}

export interface AgentTextProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
}

export interface ClipboardEntry {
  id: string;
  text: string;
  capturedAt: number;
}

export interface ClipboardFavorite {
  id: string;
  text: string;
  label: string;
  category: string;
  order: number;
  updatedAt: number;
}

export interface NoteRecord {
  id: string;
  title: string;
  content: string;
  updatedAt: number;
  filePath?: string;
}

export interface WebShortcut {
  id: string;
  name: string;
  url: string;
  icon?: string;
  updatedAt: number;
}

export interface AiUsage {
  day: string;
  month: string;
  requestsToday: number;
  requestsThisMonth: number;
  inputTokens: number;
  outputTokens: number;
  searchCount: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface NexusMode {
  id: string;
  name: string;
  closeAppIds: string[];
  launchAppIds: string[];
  closeAllNonSystem: boolean;
}

export interface AppAnnotation {
  note: string;
  displayLabelMode: "original" | "note";
  updatedAt: number;
}

export interface AiClassificationCacheEntry {
  appId: string;
  launchTarget: string;
  fingerprint?: string;
  category: AppCategory;
  type: AppClassification;
  show: boolean;
  confidence: number;
  source: "ai" | "local";
  analyzedAt: number;
}

export interface UserAppCategory {
  id: string;
  label: string;
  createdAt: number;
}

export const DEFAULT_SETTINGS: NexusSettings = {
  visualTheme: "dkn",
  launchAtStartup: false,
  globalShortcut: "Alt + Space",
  radialShortcut: "Alt + Shift + Space",
  radialEnabled: true,
  radialVoiceEnabled: false,
  aiClassificationEnabled: false,
  gameFriendlyMode: false,
  categoryIconSize: 56,
  filterUnconventionalApps: true,
  clipboardHistoryLimit: 10,
  notesDirectory: "",
  agentModels: { codex: "", workbuddy: "" },
  agentRoleProviders: { coding: "workbuddy", analysis: "codex", review: "codex", image: "manual", audio: "manual", music: "manual" },
  agentImageProviders: [],
  agentTextProviders: [],
  agentWindowMode: "single",
  textSize: "standard",
  uiScale: 100,
  reducedMotion: false,
  uiSoundsEnabled: false,
  uiSoundVolume: 0.14,
  mainWindowWidth: 980,
  mainWindowHeight: 680,
  agentWindowWidth: 1600,
  agentWindowHeight: 900,
  deepSeekModel: "deepseek-chat",
  deepSeekBaseUrl: "https://api.deepseek.com",
  searchProvider: "bocha"
};
