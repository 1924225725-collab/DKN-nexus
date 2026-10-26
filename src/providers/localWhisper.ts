import { invoke } from "@tauri-apps/api/core";
import type { VoiceProvider } from "../radial/VoiceInputService";

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const BASE64_CHUNK_BYTES = 0x8000;

async function blobToBase64(audio: Blob): Promise<string> {
  const bytes = new Uint8Array(await audio.arrayBuffer());
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES)));
  }
  return btoa(chunks.join(""));
}

/** Offline ASR adapter. The cloud provider can implement the same VoiceProvider contract later. */
export class LocalWhisperProvider implements VoiceProvider {
  readonly id = "local-faster-whisper-small";

  async transcribe(audio: Blob, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new DOMException("语音转录已取消。", "AbortError");
    if (!audio.size) throw new Error("录音为空，请重新录制。");
    if (audio.size > MAX_AUDIO_BYTES) throw new Error("录音文件超过 32 MB，请缩短录音后重试。");

    const text = await invoke<string>("transcribe_local_audio", {
      audioBase64: await blobToBase64(audio),
      audioMimeType: audio.type,
    });
    if (signal?.aborted) throw new DOMException("语音转录已取消。", "AbortError");
    return text.trim();
  }
}

export const localWhisperProvider = new LocalWhisperProvider();
