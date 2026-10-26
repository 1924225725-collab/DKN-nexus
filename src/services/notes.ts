import type { NoteRecord } from "../domain";

export function createNote(now = Date.now()): NoteRecord {
  return { id: `${now}`, title: "未命名笔记", content: "", updatedAt: now };
}

export function updateNote(notes: NoteRecord[], id: string, patch: Partial<NoteRecord>, updatedAt = Date.now()): NoteRecord[] {
  return notes.map((note) => note.id === id ? { ...note, ...patch, updatedAt } : note);
}

export async function saveNoteFile(note: NoteRecord, directory: string): Promise<string | undefined> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("save_note", { title: note.title, content: note.content, directory: directory || null });
  } catch {
    return undefined;
  }
}
