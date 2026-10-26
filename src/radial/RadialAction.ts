export type RadialActionId = "clipboard" | "notes" | "ai" | "web" | "tools";
export interface RadialAction { id: RadialActionId; label: string; hint: string; }

export const RADIAL_ACTIONS: RadialAction[] = [
  { id: "clipboard", label: "剪贴板", hint: "最近与常用" },
  { id: "notes", label: "记事", hint: "新建与最近" },
  { id: "ai", label: "Nexus AI", hint: "快速提问" },
  { id: "web", label: "网页", hint: "已保存网站" },
  { id: "tools", label: "工具", hint: "扩展入口" },
];

export function radialNodePosition(index: number, count: number, radius = 146): { left: string; top: string } {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, count);
  return { left: `calc(50% + ${Math.cos(angle) * radius}px)`, top: `calc(50% + ${Math.sin(angle) * radius}px)` };
}
