use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const OVERLAY_LOGICAL_WIDTH: f64 = 760.0;
const OVERLAY_LOGICAL_HEIGHT: f64 = 520.0;

pub(crate) fn active_shortcut() -> &'static Mutex<String> {
    static ACTIVE: OnceLock<Mutex<String>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(String::new()))
}

fn session_open() -> &'static AtomicBool {
    static OPEN: AtomicBool = AtomicBool::new(false);
    &OPEN
}

fn hold_active() -> &'static AtomicBool {
    static HELD: AtomicBool = AtomicBool::new(false);
    &HELD
}

fn shortcut_capture_active() -> &'static AtomicBool {
    static ACTIVE: AtomicBool = AtomicBool::new(false);
    &ACTIVE
}

pub(crate) fn is_shortcut_capture_active() -> bool {
    shortcut_capture_active().load(Ordering::SeqCst)
}

pub fn set_shortcut_capture_active(active: bool) {
    shortcut_capture_active().store(active, Ordering::SeqCst);
}

fn foreground_target() -> &'static AtomicIsize {
    static TARGET: AtomicIsize = AtomicIsize::new(0);
    &TARGET
}

fn anchor_position() -> &'static Mutex<(f64, f64)> {
    static ANCHOR: OnceLock<Mutex<(f64, f64)>> = OnceLock::new();
    ANCHOR.get_or_init(|| Mutex::new((OVERLAY_LOGICAL_WIDTH / 2.0, OVERLAY_LOGICAL_HEIGHT / 2.0)))
}

#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Point { x: i32, y: i32 }

#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    fn GetCursorPos(point: *mut Point) -> i32;
    fn GetForegroundWindow() -> isize;
    fn SetForegroundWindow(window: isize) -> i32;
    fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
}

#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy)]
struct KeyboardInput { virtual_key: u16, scan: u16, flags: u32, time: u32, extra_info: usize }

#[cfg(windows)]
#[repr(C)]
union InputData { keyboard: KeyboardInput, padding: [u64; 4] }

#[cfg(windows)]
#[repr(C)]
struct Input { input_type: u32, data: InputData }

#[cfg(windows)]
fn cursor_position() -> Option<(i32, i32)> {
    let mut point = Point::default();
    (unsafe { GetCursorPos(&mut point) } != 0).then_some((point.x, point.y))
}

#[cfg(not(windows))]
fn cursor_position() -> Option<(i32, i32)> { None }

fn position_overlay(window: &WebviewWindow) -> Result<(f64, f64), String> {
    let cursor = cursor_position().unwrap_or((640, 360));
    let monitors = window.available_monitors().map_err(|error| error.to_string())?;
    let selected = monitors.iter().find(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        cursor.0 >= position.x && cursor.1 >= position.y
            && cursor.0 < position.x.saturating_add(size.width as i32)
            && cursor.1 < position.y.saturating_add(size.height as i32)
    }).or_else(|| monitors.first());

    let Some(monitor) = selected else {
        window.center().map_err(|error| error.to_string())?;
        return Ok((OVERLAY_LOGICAL_WIDTH / 2.0, OVERLAY_LOGICAL_HEIGHT / 2.0));
    };
    let work = monitor.work_area();
    let scale = monitor.scale_factor().max(1.0);
    let width_px = (OVERLAY_LOGICAL_WIDTH * scale).round() as i32;
    let height_px = (OVERLAY_LOGICAL_HEIGHT * scale).round() as i32;
    let width = work.size.width as i32;
    let height = work.size.height as i32;
    let max_x = work.position.x.saturating_add(width).saturating_sub(width_px);
    let max_y = work.position.y.saturating_add(height).saturating_sub(height_px);
    let x = cursor.0.saturating_sub(width_px / 2).clamp(work.position.x, max_x.max(work.position.x));
    let y = cursor.1.saturating_sub(height_px / 2).clamp(work.position.y, max_y.max(work.position.y));
    window.set_size(PhysicalSize::new(width_px.max(1) as u32, height_px.max(1) as u32)).map_err(|error| error.to_string())?;
    window.set_position(PhysicalPosition::new(x, y)).map_err(|error| error.to_string())?;
    let anchor = (((cursor.0 - x) as f64 / scale).clamp(0.0, OVERLAY_LOGICAL_WIDTH), ((cursor.1 - y) as f64 / scale).clamp(0.0, OVERLAY_LOGICAL_HEIGHT));
    Ok(anchor)
}

fn on_shortcut_event(app: &tauri::AppHandle, event: ShortcutState) {
    if is_shortcut_capture_active() { return; }
    let Some(window) = app.get_webview_window("radial") else { return; };
    match event {
        ShortcutState::Pressed => {
            if hold_active().swap(true, Ordering::SeqCst) { return; }
            if !session_open().swap(true, Ordering::SeqCst) {
                #[cfg(windows)] foreground_target().store(unsafe { GetForegroundWindow() }, Ordering::SeqCst);
            }
            let anchor = if window.is_visible().unwrap_or(false) {
                *anchor_position().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
            } else {
                match position_overlay(&window) {
                    Ok(position) => position,
                    Err(error) => {
                        crate::diagnostic_log(format!("radial:position_failed error={error}"));
                        (OVERLAY_LOGICAL_WIDTH / 2.0, OVERLAY_LOGICAL_HEIGHT / 2.0)
                    }
                }
            };
            *anchor_position().lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = anchor;
            if !window.is_visible().unwrap_or(false) {
                if let Err(error) = window.show() {
                    crate::diagnostic_log(format!("radial:show_failed error={error}"));
                    hold_active().store(false, Ordering::SeqCst);
                    session_open().store(false, Ordering::SeqCst);
                    foreground_target().store(0, Ordering::SeqCst);
                    return;
                }
                let _ = window.set_focus();
            }
            let _ = window.emit("dkn://radial/open", serde_json::json!({ "x": anchor.0, "y": anchor.1 }));
            crate::diagnostic_log("radial:hold_start");
        }
        ShortcutState::Released => {
            if !hold_active().swap(false, Ordering::SeqCst) { return; }
            let _ = window.emit("dkn://radial/release", ());
            crate::diagnostic_log("radial:hold_release");
        }
    }
}

pub fn configure(app: &tauri::AppHandle, value: &str, enabled: bool) -> Result<(), String> {
    let normalized = crate::normalize_shortcut(value)?;
    if enabled {
        let main = crate::active_shortcut().lock().map_err(|_| "快捷键状态锁定失败".to_string())?.clone();
        if normalized == main { return Err("轮盘快捷键不能与主窗口快捷键相同。".to_string()); }
    }
    let previous = active_shortcut().lock().map_err(|_| "轮盘快捷键状态锁定失败".to_string())?.clone();
    if previous == normalized && enabled { return Ok(()); }
    if !previous.is_empty() {
        app.global_shortcut().unregister(previous.as_str()).map_err(|error| format!("无法释放旧轮盘快捷键：{error}"))?;
    }
    if enabled {
        let app_for_event = app.clone();
        if let Err(error) = app.global_shortcut().on_shortcut(normalized.as_str(), move |_app, _shortcut, event| {
            on_shortcut_event(&app_for_event, event.state);
        }) {
            if !previous.is_empty() {
                let app_for_restore = app.clone();
                let _ = app.global_shortcut().on_shortcut(previous.as_str(), move |_app, _shortcut, event| on_shortcut_event(&app_for_restore, event.state));
            }
            return Err(format!("轮盘快捷键注册失败：{error}"));
        }
    }
    *active_shortcut().lock().map_err(|_| "轮盘快捷键状态锁定失败".to_string())? = if enabled { normalized.clone() } else { String::new() };
    hold_active().store(false, Ordering::SeqCst);
    crate::diagnostic_log(format!("radial:shortcut configured enabled={enabled} value={normalized}"));
    Ok(())
}

pub fn hide(app: &tauri::AppHandle) -> Result<(), String> {
    hold_active().store(false, Ordering::SeqCst);
    session_open().store(false, Ordering::SeqCst);
    foreground_target().store(0, Ordering::SeqCst);
    *anchor_position().lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = (OVERLAY_LOGICAL_WIDTH / 2.0, OVERLAY_LOGICAL_HEIGHT / 2.0);
    if let Some(window) = app.get_webview_window("radial") { window.hide().map_err(|error| error.to_string())?; }
    Ok(())
}

pub async fn quick_paste(app: tauri::AppHandle, text: String) -> Result<bool, String> {
    crate::set_clipboard_text(text)?;
    let target = foreground_target().load(Ordering::SeqCst);
    hold_active().store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("radial") { window.hide().map_err(|error| error.to_string())?; }
    let pasted = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)] {
            if target == 0 { return false; }
            let foreground = unsafe { GetForegroundWindow() };
            if target == foreground { return false; }
            if unsafe { SetForegroundWindow(target) } == 0 { return false; }
            std::thread::sleep(std::time::Duration::from_millis(90));
            const INPUT_KEYBOARD: u32 = 1;
            const KEYEVENTF_KEYUP: u32 = 0x0002;
            let key = |virtual_key, flags| Input { input_type: INPUT_KEYBOARD, data: InputData { keyboard: KeyboardInput { virtual_key, scan: 0, flags, time: 0, extra_info: 0 } } };
            let inputs = [key(0x11, 0), key(0x56, 0), key(0x56, KEYEVENTF_KEYUP), key(0x11, KEYEVENTF_KEYUP)];
            return unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<Input>() as i32) } == inputs.len() as u32;
        }
        #[cfg(not(windows))]
        { let _ = target; false }
    }).await.map_err(|error| format!("粘贴任务未完成：{error}"))?;
    if pasted {
        hide(&app)?;
    } else {
        if let Some(window) = app.get_webview_window("radial") {
            let _ = window.show();
            let _ = window.set_focus();
            session_open().store(true, Ordering::SeqCst);
            foreground_target().store(target, Ordering::SeqCst);
        }
    }
    Ok(pasted)
}
