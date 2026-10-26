import { useEffect, useState } from "react";

type OutputDevice = { id: string; name: string; note: string };
const OUTPUTS_KEY = "dkn-nexus:music-output-devices";

function readOutputs(): OutputDevice[] {
  try {
    const value = JSON.parse(localStorage.getItem(OUTPUTS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((entry) => entry && typeof entry.id === "string" && typeof entry.name === "string") : [];
  } catch { return []; }
}

export function PlaybackDevicesSettings() {
  const [outputs, setOutputs] = useState<OutputDevice[]>(readOutputs);
  const [available, setAvailable] = useState<MediaDeviceInfo[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => { localStorage.setItem(OUTPUTS_KEY, JSON.stringify(outputs)); }, [outputs]);
  const refresh = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAvailable(devices.filter((device) => device.kind === "audiooutput"));
      setMessage("");
    } catch { setMessage("无法读取音频输出设备"); }
  };
  useEffect(() => { void refresh(); }, []);
  const add = async () => {
    const mediaDevices = navigator.mediaDevices as MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
    if (!mediaDevices.selectAudioOutput) { setMessage("当前系统不支持设备选择器；可刷新已检测的设备"); return; }
    try {
      const device = await mediaDevices.selectAudioOutput();
      setAvailable((items) => items.some((item) => item.deviceId === device.deviceId) ? items : [...items, device]);
      setOutputs((items) => items.some((item) => item.id === device.deviceId) ? items : [...items, { id: device.deviceId, name: device.label || `音频输出 ${items.length + 1}`, note: "" }]);
      setMessage("设备已加入管理列表。实际输出由播放应用和 Windows 声音设置控制。");
    } catch { setMessage("未选择新的播放设备"); }
  };
  const openSoundSettings = async () => {
    try { const { openUrl } = await import("@tauri-apps/plugin-opener"); await openUrl("ms-settings:sound"); }
    catch { setMessage("无法打开 Windows 声音设置"); }
  };
  const update = (id: string, patch: Partial<OutputDevice>) => setOutputs((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));

  return <>
    <p className="settings-description playback-device-intro">这里管理设备备注和常用硬件清单。当前音乐播放器控制 Windows 媒体会话；更改实际输出设备请使用 Windows 声音设置或播放应用自己的输出选项。</p>
    <div className="playback-device-actions"><button className="quiet-button" onClick={() => void add()}>＋ 添加设备</button><button className="quiet-button" onClick={() => void refresh()}>刷新设备</button><button className="primary-action" onClick={() => void openSoundSettings()}>打开 Windows 声音设置</button></div>
    <div className="playback-device-detected">检测到 {available.length} 个音频输出设备</div>
    {outputs.length ? <div className="playback-device-list">{outputs.map((output) => <article className="playback-device-item" key={output.id}><div className="playback-device-fields"><input aria-label="设备名称" value={output.name} onChange={(event) => update(output.id, { name: event.target.value })} /><textarea aria-label={`${output.name}备注`} placeholder="添加备注" rows={2} value={output.note} onChange={(event) => update(output.id, { note: event.target.value })} /></div><button className="quiet-button" onClick={() => setOutputs((items) => items.filter((item) => item.id !== output.id))}>删除</button></article>)}</div> : <p className="panel-empty">还没有管理的播放设备，使用“添加设备”加入。</p>}
    {message && <div className="music-message">{message}</div>}
  </>;
}
