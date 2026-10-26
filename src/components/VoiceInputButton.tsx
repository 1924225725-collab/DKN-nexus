import { useEffect, useRef, useState } from "react";
import { VoiceInputService } from "../radial/VoiceInputService";
import { localWhisperProvider } from "../providers/localWhisper";

interface VoiceInputButtonProps {
  disabled?: boolean;
  onTranscription: (text: string) => void;
  onError: (message: string) => void;
}

function readableCaptureError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") return "麦克风权限未开启，请在 Windows 设置中允许 DKN Nexus 使用麦克风。";
  return error instanceof Error ? error.message : "无法使用麦克风，请检查设备和权限。";
}

export function VoiceInputButton({ disabled = false, onTranscription, onError }: VoiceInputButtonProps) {
  const serviceRef = useRef<VoiceInputService | null>(null);
  if (!serviceRef.current) serviceRef.current = new VoiceInputService();
  const service = serviceRef.current;
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => () => service.cancel(), [service]);

  const toggleRecording = async () => {
    setNotice("");
    if (!recording) {
      try {
        await service.startCapture();
        setRecording(true);
      } catch (error) {
        onError(readableCaptureError(error));
      }
      return;
    }

    setRecording(false);
    setTranscribing(true);
    try {
      await service.stopCapture();
      const text = await service.transcribe(localWhisperProvider);
      if (!text) throw new Error("没有识别到清晰语音，请靠近麦克风后重试。");
      onTranscription(text);
      setNotice("已识别并插入");
    } catch (error) {
      onError(readableCaptureError(error));
    } finally {
      setTranscribing(false);
    }
  };

  return <div className="agents-voice-control">
    <button
      type="button"
      className={`agents-voice-button ${recording ? "is-recording" : ""} ${transcribing ? "is-transcribing" : ""}`}
      disabled={transcribing || (disabled && !recording)}
      aria-label={transcribing ? "本地语音转录中" : recording ? "结束录音并转录" : "开始语音录入"}
      aria-pressed={recording}
      title="本地 Whisper · 录音结束后转录，不会上传音频"
      onClick={() => void toggleRecording()}
    >
      <svg viewBox="0 0 18 18" aria-hidden="true"><rect x="6.1" y="2.4" width="5.8" height="9" rx="2.9" /><path d="M3.7 8.7a5.3 5.3 0 0 0 10.6 0M9 14v2M6.6 16h4.8" /></svg>
      <span>{transcribing ? "本地识别中…" : recording ? "结束录音" : "语音输入"}</span>
    </button>
    {recording && <small className="agents-voice-state" role="status">录音中 · 点击结束后转录</small>}
    {notice && !recording && !transcribing && <small className="agents-voice-state is-success" role="status">{notice}</small>}
  </div>;
}
