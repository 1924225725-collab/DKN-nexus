import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createMediaPolling, type MediaPollingHandle } from "../services/mediaPolling";
import { createMusicWindowLifecycle } from "../services/musicWindowLifecycle";

type CurrentMedia = {
  title: string;
  artist: string;
  album: string;
  appId: string;
  coverDataUrl: string | null;
  playing: boolean;
  position: number;
  duration: number;
  canSeek: boolean;
  canNext: boolean;
  canPrevious: boolean;
  canToggle: boolean;
  metadataOnly: boolean;
  localControl: boolean;
};
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}
function sourceName(appId: string): string {
  const normalized = appId.split("!")[0].split("\\").pop() || appId;
  return normalized.replace(/\.exe$/i, "");
}

export function MusicPlayerWindow() {
  const [media, setMedia] = useState<CurrentMedia | null>(null);
  const [positionDraft, setPositionDraft] = useState(0);
  const [message, setMessage] = useState("");
  const mediaRef = useRef<CurrentMedia | null>(null);
  const seekingRef = useRef(false);
  const commandInFlightRef = useRef(false);
  const pollingRef = useRef<MediaPollingHandle | null>(null);

  const sessionHint = media?.localControl
    ? `网易云本机控制已连接；${media.canSeek ? "当前支持进度定位。" : "当前未检测到进度定位能力。"}`
    : media?.metadataOnly
      ? "网易云当前只提供标题信息。要启用进度和控制，请先完全退出网易云，再按项目状态说明用 127.0.0.1 本地调试参数重开。"
      : "歌曲信息和控制来自 Windows 当前媒体会话。";

  // Applies one successful read. Kept as a ref-stable closure so the scheduler
  // can be created once for the lifetime of the window.
  const applyMedia = (next: CurrentMedia | null) => {
    mediaRef.current = next;
    setMedia(next);
    if (!seekingRef.current) setPositionDraft(next?.position ?? 0);
    if (next) setMessage("");
  };

  useEffect(() => {
    if (!isTauri()) return;

    const lifecycle = createMusicWindowLifecycle<CurrentMedia | null>({
      createPolling: () => {
        const polling = createMediaPolling<CurrentMedia | null>({
          read: () => invoke<CurrentMedia | null>("get_current_media"),
          apply: applyMedia,
          onError: (error) => setMessage(`读取 Windows 媒体会话失败：${String(error)}`),
        });
        pollingRef.current = polling;
        return polling;
      },
      listen: (handler) =>
        listen<boolean>("dkn://music-visibility", (event) => handler(event.payload === true)),
      getVisibility: () => invoke<boolean>("get_music_visibility"),
      applyVisible: () => undefined,
      onError: (error) => setMessage(`媒体窗口生命周期初始化失败：${String(error)}`),
    });

    void lifecycle.start();

    return () => {
      lifecycle.dispose();
      pollingRef.current = null;
    };
  }, []);

  const command = async (action: string, position?: number) => {
    if (!isTauri() || commandInFlightRef.current) return;
    commandInFlightRef.current = true;
    try {
      const accepted = await invoke<boolean>("control_current_media", position === undefined ? { action } : { action, positionSeconds: position });
      if (!accepted) setMessage("当前播放应用没有响应此控制操作");
      else {
        setMessage("");
        if (action === "toggle" && mediaRef.current) {
          const updated = { ...mediaRef.current, playing: !mediaRef.current.playing };
          mediaRef.current = updated;
          setMedia(updated);
        } else if (action === "seek" && mediaRef.current && position !== undefined) {
          const updated = { ...mediaRef.current, position };
          mediaRef.current = updated;
          setMedia(updated);
          setPositionDraft(position);
        }
      }
      // `accepted` only means the interface took the request; the refreshed
      // snapshot is what confirms the player actually changed state. The refresh
      // goes through the same scheduler, so it cannot revive a hidden window or
      // overlap an outstanding read.
      pollingRef.current?.refreshNow();
    } catch (error) { setMessage(`控制当前播放媒体失败：${String(error)}`); }
    finally { commandInFlightRef.current = false; }
  };
  const commitSeek = () => {
    seekingRef.current = false;
    if (mediaRef.current?.canSeek) void command("seek", positionDraft);
    else setMessage("当前播放应用不支持拖动进度");
  };
  const openSoundSettings = async () => {
    try { await invoke("open_main_audio_settings"); }
    catch { setMessage("无法打开软件内的声音设置"); }
  };

  return <main className="music-window">
    <header className="music-titlebar" onMouseDown={(event) => { if (event.button === 0 && !(event.target as HTMLElement).closest("button")) void getCurrentWindow().startDragging(); }}>
      <div className="music-brand"><span className="music-brand-mark">♫</span><div><strong>音乐播放器</strong><small>WINDOWS MEDIA SESSION</small></div></div>
      <div className="music-title-actions"><button aria-label="声音与设备设置" title="声音与设备设置" onClick={() => void openSoundSettings()}>⚙</button><button aria-label="关闭播放器" title="关闭" onClick={() => { if (isTauri()) void invoke("hide_music_window"); }}>×</button></div>
    </header>
    <section className="music-content">
      <div className="music-cover-wrap">{media?.coverDataUrl ? <img src={media.coverDataUrl} alt="当前歌曲封面" /> : <div className="music-cover-empty"><span>♫</span><small>{media?.metadataOnly ? "标题模式不读取封面" : media ? "此曲没有可用封面" : "等待电脑上的音乐播放"}</small></div>}</div>
      <div className="music-track-meta"><strong title={media?.title}>{media?.title || "当前没有媒体会话"}</strong><small>{media ? [media.artist, media.album].filter(Boolean).join(" · ") || sourceName(media.appId) : "在支持 Windows 媒体控制的应用中开始播放"}</small></div>
      {media && <div className="music-source-label">{media.metadataOnly ? `信息来源：${sourceName(media.appId)}窗口标题` : `正在控制：${sourceName(media.appId)}`}</div>}
      <div className={`music-progress ${media?.canSeek ? "" : "is-disabled"}`}><input aria-label="当前音乐播放进度" type="range" min={0} max={media?.duration || 1} step={0.1} value={Math.min(positionDraft, media?.duration || 1)} disabled={!media?.canSeek} onPointerDown={() => { seekingRef.current = true; }} onChange={(event) => setPositionDraft(Number(event.target.value))} onPointerUp={commitSeek} onPointerCancel={commitSeek} onKeyDown={() => { seekingRef.current = true; }} onKeyUp={commitSeek} /><div><span>{formatTime(positionDraft)}</span><span>{formatTime(media?.duration ?? 0)}</span></div></div>
      <div className="music-controls"><button aria-label="上一首" disabled={!media?.canPrevious} onClick={() => void command("previous")}>|‹</button><button className="music-play-button" aria-label={media?.playing ? "暂停" : "播放"} disabled={!media?.canToggle} onClick={() => void command("toggle")}>{media?.playing ? "Ⅱ" : "▶"}</button><button aria-label="下一首" disabled={!media?.canNext} onClick={() => void command("next")}>›|</button></div>
      <div className="music-output-row"><label>播放设备</label><span>跟随当前播放应用</span><button className="music-open-sound-settings" onClick={() => void openSoundSettings()}>设备设置</button></div>
      <div className="music-session-hint">{sessionHint}</div>
      {message && <div className="music-message">{message}</div>}
    </section>
  </main>;
}
