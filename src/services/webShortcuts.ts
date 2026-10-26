import type { WebShortcut } from "../domain";

export function normaliseWebUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch { return null; }
}

export function createWebShortcut(name: string, value: string, now = Date.now()): WebShortcut | null {
  const url = normaliseWebUrl(value);
  if (!url || !name.trim()) return null;
  return { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, name: name.trim(), url, updatedAt: now };
}

export async function openWebShortcut(url: string): Promise<void> {
  const normalized = normaliseWebUrl(url);
  if (!normalized) throw new Error("只允许打开有效的 HTTP 或 HTTPS 网页地址。");
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(normalized);
    return;
  }
  window.open(normalized, "_blank", "noopener,noreferrer");
}

export async function loadFavicon(url: string): Promise<string | undefined> {
  try {
    const origin = new URL(url).origin;
    const response = await fetch(`${origin}/favicon.ico`, { signal: AbortSignal.timeout(3500) });
    if (!response.ok) return undefined;
    const blob = await response.blob();
    return await new Promise<string | undefined>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined); reader.onerror = () => resolve(undefined); reader.readAsDataURL(blob); });
  } catch { return undefined; }
}
