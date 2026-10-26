export type UiSoundEvent = "approval" | "complete" | "error";

type SoundSettings = { enabled: boolean; volume: number };

const NOTES: Record<UiSoundEvent, [number, number, number]> = {
  approval: [440, 554, 0.14],
  complete: [587, 740, 0.2],
  error: [330, 277, 0.18],
};

/** Short, local synthesized cues. No audio context is kept alive between events. */
export function playUiSound(event: UiSoundEvent, settings: SoundSettings): void {
  if (!settings.enabled || settings.volume <= 0 || typeof window === "undefined") return;
  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) return;

  let context: AudioContext;
  try { context = new AudioContextConstructor(); } catch { return; }
  const [startFrequency, endFrequency, duration] = NOTES[event];
  const now = context.currentTime;
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  const peak = Math.min(.035, Math.max(.001, settings.volume * .055));
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(startFrequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(endFrequency, now + duration);
  envelope.gain.setValueAtTime(.0001, now);
  envelope.gain.exponentialRampToValueAtTime(peak, now + .018);
  envelope.gain.exponentialRampToValueAtTime(.0001, now + duration);
  oscillator.connect(envelope);
  envelope.connect(context.destination);
  void context.resume().catch(() => undefined);
  oscillator.start(now);
  oscillator.stop(now + duration + .01);
  window.setTimeout(() => { void context.close().catch(() => undefined); }, 520);
}
