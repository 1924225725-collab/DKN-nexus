import { invoke } from "@tauri-apps/api/core";
import type { AgentImageProvider, AgentTextProvider, NexusSettings } from "../domain";
import { DeepSeekProvider } from "../providers/deepSeek";
import { loadSecret } from "./secrets";

const PROJECTS_KEY = "dkn-nexus:agent-projects";
const DISPATCH_KEY = "dkn-nexus:agent-dispatch-chat";

export type AgentStage = "queued" | "planned" | "planning" | "coding" | "reviewing" | "awaiting_user" | "completed" | "failed";
export type AgentCategory = "开发" | "桌面软件" | "网页" | "自动化" | "其他";

export type AgentProviderId = "codex" | "workbuddy";
export type AgentRole = "coding" | "analysis" | "review" | "image" | "audio" | "music" | "user";
export type AgentExecutorId = "codex" | "workbuddy" | "deepseek" | "manual" | `image-api:${string}` | `text-api:${string}`;
export type AgentPlanStepStatus = "queued" | "running" | "awaiting_user" | "completed" | "failed";
export type AgentProjectResourceKind = "link" | "image" | "text" | "directory" | "package";

export interface AgentProjectResource {
  id: string;
  kind: AgentProjectResourceKind;
  title: string;
  value: string;
  createdAt: number;
}

export interface AgentPlanStep {
  id: string;
  title: string;
  description: string;
  role: AgentRole;
  provider: AgentExecutorId;
  status: AgentPlanStepStatus;
  userPrompt?: string;
  imageChoice?: boolean;
  result?: string;
  imagePath?: string;
  imageUrl?: string;
}

export interface AgentPlan {
  summary: string;
  steps: AgentPlanStep[];
}

export interface AgentProviderDescriptor {
  id: AgentProviderId;
  label: string;
  stages: string;
  account: string;
}

// New providers can be added here without coupling their model controls to a specific view.
export const AGENT_PROVIDER_REGISTRY: AgentProviderDescriptor[] = [
  { id: "codex", label: "Codex（ChatGPT 登录）", stages: "项目派单 · 策划 · 验收", account: "Codex CLI 当前登录账户承担这些阶段的用量。" },
  { id: "workbuddy", label: "WorkBuddy / CodeBuddy", stages: "项目编码", account: "编码阶段使用 WorkBuddy 当前桌面登录账户；CLI 不公开可读取的账号名。" },
];

export type AgentModelSelection = NexusSettings["agentModels"];

export interface AgentProviderInfo {
  codexAccount: string;
  codexStatus: "connected" | "disconnected" | "unknown";
  workbuddyAccount: string;
  workbuddyStatus: "connected" | "disconnected" | "unknown";
  workbuddyModels: string[];
}

export interface AgentMessage {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  agent?: string;
  model?: string;
  stage?: AgentStage;
  createdAt: number;
  imagePath?: string;
  imageUrl?: string;
}

export interface AgentTaskAttachment {
  name: string;
  size: number;
  text: string;
}

export interface AgentTask {
  id: string;
  prompt: string;
  status: AgentStage;
  createdAt: number;
  messages: AgentMessage[];
  attachments?: AgentTaskAttachment[];
  plan?: AgentPlan;
}

export interface AgentProject {
  id: string;
  name: string;
  path: string;
  category: AgentCategory;
  createdAt: number;
  tasks: AgentTask[];
  resources?: AgentProjectResource[];
}

export interface AgentWorkflowProgress {
  taskId: string;
  stage: AgentStage;
  agent: string;
  model: string;
  message: string;
  output?: string | null;
}

export interface ProjectRoute {
  projectId: string | null;
  newProjectName: string | null;
  newProjectCategory: AgentCategory | null;
  reason: string;
  model: string;
}

export async function loadAgentProviderInfo(): Promise<AgentProviderInfo> {
  return await invoke<AgentProviderInfo>("get_agent_provider_info");
}

export type AgentDispatchMessage = Pick<AgentMessage, "id" | "role" | "content" | "createdAt"> & Partial<Pick<AgentMessage, "agent" | "model">>;

function readProjects(): AgentProject[] {
  try {
    const value = localStorage.getItem(PROJECTS_KEY);
    return value ? JSON.parse(value) as AgentProject[] : [];
  } catch { return []; }
}

export function loadAgentProjects(): AgentProject[] { return readProjects(); }
export function saveAgentProjects(projects: AgentProject[]): void { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects)); }
export function loadDispatchMessages(): AgentDispatchMessage[] {
  try { const value = localStorage.getItem(DISPATCH_KEY); return value ? JSON.parse(value) as AgentDispatchMessage[] : []; } catch { return []; }
}
export function saveDispatchMessages(messages: AgentDispatchMessage[]): void { localStorage.setItem(DISPATCH_KEY, JSON.stringify(messages)); }
export function createAgentId(): string { return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
export async function chooseProjectDirectory(): Promise<string | null> { return await invoke<string | null>("pick_project_directory"); }
export async function chooseAgentResourceFile(kind: "image" | "package"): Promise<string | null> { return await invoke<string | null>("pick_agent_resource_file", { kind }); }
export async function copyAgentImageToProject(projectPath: string, sourcePath: string): Promise<string> { return await invoke<string>("copy_agent_image_to_project", { projectPath, sourcePath }); }
export async function routeAgentProject(prompt: string, projects: Array<Pick<AgentProject, "id" | "name" | "category">>, models: AgentModelSelection): Promise<ProjectRoute> {
  return await invoke<ProjectRoute>("route_agent_project", { prompt, projects, models });
}

export interface AgentPlanDraft {
  summary: string;
  steps: Array<Pick<AgentPlanStep, "title" | "description" | "role" | "userPrompt" | "imageChoice">>;
  model: string;
}

export interface AgentStepResult {
  output: string;
  agent: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  imagePath?: string;
  imageUrl?: string;
}

export async function planAgentTask(taskId: string, projectPath: string, prompt: string, models: AgentModelSelection, imageApiAvailable: boolean): Promise<AgentPlanDraft> {
  return await invoke<AgentPlanDraft>("plan_agent_task", { taskId, projectPath, prompt, models, imageApiAvailable });
}

export async function executeAgentPlanStep(input: {
  taskId: string;
  projectPath: string;
  taskPrompt: string;
  planSummary: string;
  title: string;
  description: string;
  role: AgentRole;
  provider: AgentExecutorId;
  priorResults: string[];
  models: AgentModelSelection;
  settings: NexusSettings;
}): Promise<AgentStepResult> {
  if (input.provider === "manual") throw new Error("此步骤需要先由你手动完成。");
  if (input.provider.startsWith("image-api:")) {
    if (input.role !== "image") throw new Error("自定义图片 API 只能用于图像生成步骤。");
    const providerId = input.provider.slice("image-api:".length);
    const provider = input.settings.agentImageProviders.find((item) => item.id === providerId);
    if (!provider) throw new Error("此图片服务已被删除，请为当前步骤重新选择执行者。");
    const result = await invoke<{ imagePath?: string; imageUrl?: string; model: string }>("generate_agent_image", {
      providerId: provider.id,
      model: provider.model,
      size: provider.size,
      prompt: [input.taskPrompt, input.title, input.description].filter(Boolean).join("\n\n").slice(0, 6000),
    });
    const projectImagePath = result.imagePath ? await copyAgentImageToProject(input.projectPath, result.imagePath) : undefined;
    return {
      output: projectImagePath ? `图像已生成并复制到项目目录：${projectImagePath}` : "图像已生成。该服务返回的是临时图片链接，链接可能会过期。",
      agent: provider.name,
      model: result.model,
      imagePath: projectImagePath,
      imageUrl: result.imageUrl,
    };
  }
  const context = input.priorResults.slice(-6).map((item) => item.slice(0, 5000)).join("\n\n--- 前一步结果 ---\n\n").slice(0, 20_000);
  const prompt = `你正在执行 DKN Nexus Agent 计划中的一个步骤。只完成当前步骤，不要扩大范围。\n\n用户总需求：\n${input.taskPrompt}\n\n整体方案：\n${input.planSummary}\n\n当前步骤：${input.title}\n步骤说明：\n${input.description}\n\n此前步骤结果（可能为空）：\n${context || "（暂无）"}\n\n请用简体中文总结实际完成内容、涉及文件/证据和未完成事项。`;

  if (input.provider.startsWith("text-api:")) {
    if (input.role !== "analysis" && input.role !== "review") throw new Error("OpenAI 兼容文本 API 仅支持文本分析与方案复核；项目编码仍需由具备本地文件访问能力的 Agent 执行。");
    const providerId = input.provider.slice("text-api:".length);
    const provider = input.settings.agentTextProviders.find((item) => item.id === providerId);
    if (!provider) throw new Error("此自定义文本服务已被删除，请为当前步骤重新选择执行者。");
    const result = await invoke<{ output: string; agent: string; model: string; usage?: { inputTokens?: number; outputTokens?: number } }>("execute_agent_text_step", {
      providerId: provider.id,
      serviceName: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      prompt,
    });
    return { output: result.output, agent: result.agent, model: result.model, usage: { promptTokens: result.usage?.inputTokens, completionTokens: result.usage?.outputTokens } };
  }

  if (input.provider === "deepseek") {
    if (input.role !== "analysis") throw new Error("DeepSeek API 当前只支持文本分析步骤，不会直接修改项目文件或生成图片/音频。");
    const key = await loadSecret("deepseek-api-key");
    if (!key) throw new Error("要使用 DeepSeek 执行此分析步骤，请先在设置 → AI 设置中保存 API Key。");
    const response = await new DeepSeekProvider(input.settings.deepSeekBaseUrl, key, input.settings.deepSeekModel).chat([{ role: "user", content: prompt }]);
    return { output: response.content, agent: "DeepSeek API", model: input.settings.deepSeekModel, usage: response.usage };
  }

  return await invoke<AgentStepResult>("execute_agent_plan_step", {
    taskId: input.taskId,
    projectPath: input.projectPath,
    taskPrompt: input.taskPrompt,
    planSummary: input.planSummary,
    title: input.title,
    description: input.description,
    role: input.role,
    provider: input.provider,
    priorResults: input.priorResults,
    models: input.models,
  });
}
