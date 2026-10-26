import type { ClipboardEntry } from "../domain";

export const CLIPBOARD_LIMIT = 100;

export function appendClipboardEntry(current: ClipboardEntry[], text: string, capturedAt = Date.now(), limit = 10): ClipboardEntry[] {
  const value = text.trim();
  if (!value || current[0]?.text === value) return current;
  const safeLimit = Math.max(1, Math.min(CLIPBOARD_LIMIT, Math.floor(limit) || 10));
  return [{ id: `${capturedAt}`, text, capturedAt }, ...current].slice(0, safeLimit);
}

export async function copyClipboard(text: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_clipboard_text", { text });
    return;
  } catch {
    await navigator.clipboard?.writeText(text);
  }
}
