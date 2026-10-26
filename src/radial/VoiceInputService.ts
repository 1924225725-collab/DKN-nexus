export interface VoiceProvider {
  transcribe(audio: Blob, signal?: AbortSignal): Promise<string>;
}

export interface CloudASRProvider extends VoiceProvider {}

export class VoiceInputService {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private lastBuffer: Blob | null = null;

  async prepare(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new Error("此环境不支持语音采集。");
    }
  }

  async startCapture(): Promise<void> {
    await this.prepare();
    if (this.recorder?.state === "recording") return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.lastBuffer = null;
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (event) => { if (event.data.size) this.chunks.push(event.data); };
    this.recorder.start();
  }

  async stopCapture(): Promise<void> {
    const recorder = this.recorder;
    if (recorder?.state === "recording") {
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      });
      this.lastBuffer = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
    }
    this.releaseTracks();
  }

  cancel(): void {
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.chunks = [];
    this.lastBuffer = null;
    this.releaseTracks();
  }

  getAudioBuffer(): Blob | null { return this.lastBuffer; }

  async transcribe(provider: VoiceProvider, signal?: AbortSignal): Promise<string> {
    if (!this.lastBuffer?.size) throw new Error("没有可转录的录音。请先录音并结束录音。");
    return await provider.transcribe(this.lastBuffer, signal);
  }

  private releaseTracks(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
  }
}
