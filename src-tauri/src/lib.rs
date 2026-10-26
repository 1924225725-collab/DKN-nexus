#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

mod radial;
mod child_process;
mod agent_workflow;
mod agent_image;
mod agent_text;
mod local_asr;
mod media_session;
#[cfg(windows)]
pub(crate) mod netease_cdp;

#[cfg(windows)]
mod single_instance {
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::thread;
    use std::time::Duration;

    const ERROR_ALREADY_EXISTS: u32 = 183;
    const SW_RESTORE: i32 = 9;
    const TH32CS_SNAPPROCESS: u32 = 0x00000002;

    fn recovery_start_state() -> &'static Mutex<HashMap<u64, isize>> {
        static STATE: OnceLock<Mutex<HashMap<u64, isize>>> = OnceLock::new();
        STATE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    static NEXT_RECOVERY_ID: AtomicU64 = AtomicU64::new(1);

    fn release_recovery_start_for(recovery_id: u64) {
        let handle = {
            let mut state = recovery_start_state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            state.remove(&recovery_id)
        };
        if let Some(handle) = handle {
            unsafe { CloseHandle(handle as *mut c_void); }
        }
    }

    pub fn release_recovery_start() {
        let handles: Vec<isize> = recovery_start_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .map(|(_, handle)| handle)
            .collect();
        for handle in handles {
            unsafe { CloseHandle(handle as *mut c_void); }
        }
    }

    #[repr(C)]
    struct ProcessEntry32W {
        size: u32,
        usage: u32,
        process_id: u32,
        default_heap_id: usize,
        module_id: u32,
        threads: u32,
        parent_process_id: u32,
        base_priority: i32,
        flags: u32,
        executable_name: [u16; 260],
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateMutexW(attributes: *mut c_void, initial_owner: i32, name: *const u16) -> *mut c_void;
        fn GetLastError() -> u32;
        fn SetLastError(error: u32);
        fn GetCurrentProcessId() -> u32;
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn FindWindowW(class_name: *const u16, window_name: *const u16) -> isize;
        fn EnumWindows(callback: Option<unsafe extern "system" fn(isize, isize) -> i32>, parameter: isize) -> i32;
        fn GetWindowTextLengthW(window: isize) -> i32;
        fn GetWindowTextW(window: isize, text: *mut u16, max_count: i32) -> i32;
        fn ShowWindow(window: isize, command: i32) -> i32;
        fn SetForegroundWindow(window: isize) -> i32;
        fn GetWindowThreadProcessId(window: isize, process_id: *mut u32) -> u32;
    }

    struct WindowSearch {
        target: *const u16,
        target_len: usize,
        found: isize,
    }

    unsafe extern "system" fn find_window_callback(window: isize, parameter: isize) -> i32 {
        let search = &mut *(parameter as *mut WindowSearch);
        let length = GetWindowTextLengthW(window);
        if length <= 0 { return 1; }
        let mut title = vec![0u16; length as usize + 1];
        let written = GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32);
        if written <= 0 { return 1; }
        let candidate = std::slice::from_raw_parts(title.as_ptr(), written as usize);
        let target = std::slice::from_raw_parts(search.target, search.target_len);
        if candidate == target {
            search.found = window;
            return 0;
        }
        1
    }

    fn find_existing_window(window_name: &[u16]) -> isize {
        let direct = unsafe { FindWindowW(std::ptr::null(), window_name.as_ptr()) };
        if direct != 0 { return direct; }
        let mut search = WindowSearch { target: window_name.as_ptr(), target_len: window_name.len().saturating_sub(1), found: 0 };
        unsafe { EnumWindows(Some(find_window_callback), &mut search as *mut WindowSearch as isize); }
        search.found
    }

    fn find_existing_process_ids() -> Vec<u32> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot.is_null() || snapshot as isize == -1 { return Vec::new(); }

        let current_process_id = unsafe { GetCurrentProcessId() };
        let mut entry: ProcessEntry32W = unsafe { std::mem::zeroed() };
        entry.size = std::mem::size_of::<ProcessEntry32W>() as u32;
        let mut process_ids = Vec::new();
        let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while has_entry {
            let name_end = entry.executable_name.iter().position(|value| *value == 0).unwrap_or(entry.executable_name.len());
            let executable_name = String::from_utf16_lossy(&entry.executable_name[..name_end]);
            if entry.process_id != current_process_id && executable_name.eq_ignore_ascii_case("dkn-nexus.exe") {
                process_ids.push(entry.process_id);
            }
            has_entry = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot); }
        process_ids
    }

    struct ProcessWindowSearch {
        process_id: u32,
        found: isize,
    }

    unsafe extern "system" fn find_process_window_callback(window: isize, parameter: isize) -> i32 {
        let search = &mut *(parameter as *mut ProcessWindowSearch);
        let mut process_id = 0;
        GetWindowThreadProcessId(window, &mut process_id);
        if process_id == search.process_id {
            search.found = window;
            return 0;
        }
        1
    }

    fn find_window_for_process(process_id: u32) -> isize {
        let mut search = ProcessWindowSearch { process_id, found: 0 };
        unsafe { EnumWindows(Some(find_process_window_callback), &mut search as *mut ProcessWindowSearch as isize); }
        search.found
    }

    fn claim_recovery_start_for(mutex_name: &[u16], lease: Duration) -> bool {
        unsafe { SetLastError(0); }
        let handle = unsafe { CreateMutexW(null_mut(), 0, mutex_name.as_ptr()) };
        if handle.is_null() {
            return true;
        }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe { CloseHandle(handle); }
            return false;
        }
        let recovery_id = NEXT_RECOVERY_ID.fetch_add(1, Ordering::SeqCst);
        {
            let mut state = recovery_start_state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            state.insert(recovery_id, handle as isize);
        }
        let lease_thread = thread::Builder::new()
            .name("dkn-recovery-lease".to_string())
            .spawn(move || {
                thread::sleep(lease);
                release_recovery_start_for(recovery_id);
            });
        if lease_thread.is_err() {
            release_recovery_start_for(recovery_id);
        }
        true
    }

    fn claim_recovery_start(mutex_name: &[u16]) -> bool {
        claim_recovery_start_for(mutex_name, Duration::from_secs(30))
    }

    pub fn ensure() -> bool {
        let mutex_name: Vec<u16> = "Local\\DKNNexus.SingleInstance\0".encode_utf16().collect();
        unsafe { SetLastError(0); }
        let handle = unsafe { CreateMutexW(null_mut(), 0, mutex_name.as_ptr()) };
        if handle.is_null() {
            super::diagnostic_log("single-instance:mutex-create-failed; continuing");
            return true;
        }
        if unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
            super::diagnostic_log("single-instance:owner");
            return true;
        }

        let window_name: Vec<u16> = "DKN Nexus\0".encode_utf16().collect();
        // A second launch can arrive while the first Tauri process is still
        // constructing its native window. Give it a short bounded window to
        // publish the title before deciding that it cannot be focused.
        for _ in 0..20 {
            let window = find_existing_window(&window_name);
            if window != 0 {
                unsafe {
                    ShowWindow(window, SW_RESTORE);
                    SetForegroundWindow(window);
                }
                super::diagnostic_log("single-instance:existing-window-focused");
                return false;
            }
            for process_id in find_existing_process_ids() {
                let process_window = find_window_for_process(process_id);
                if process_window != 0 {
                    unsafe {
                        ShowWindow(process_window, SW_RESTORE);
                        SetForegroundWindow(process_window);
                    }
                    super::diagnostic_log(format!("single-instance:existing-window-focused-by-pid pid={process_id}"));
                    return false;
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        // A live process without any top-level window cannot serve the user.
        // Let one recovery launch continue instead of silently exiting; the
        // separate recovery mutex prevents concurrent launchers from all
        // creating duplicate windows while the first recovery is starting.
        let recovery_mutex_name: Vec<u16> = format!("Local\\DKNNexus.Recovery.{}\0", env!("CARGO_PKG_VERSION"))
            .encode_utf16()
            .collect();
        if !claim_recovery_start(&recovery_mutex_name) {
            super::diagnostic_log("single-instance:recovery-already-starting");
            return false;
        }
        super::diagnostic_log("single-instance:existing-process-window-not-found; recovery-owner");
        true
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::time::Instant;

        // Successful setup releases this process's recovery handles together.
        // Keep tests using that process-wide state from releasing each other's leases.
        static RECOVERY_TEST: Mutex<()> = Mutex::new(());

        #[test]
        fn only_one_process_claims_a_windowless_instance_recovery() {
            let _guard = RECOVERY_TEST.lock().unwrap_or_else(|e| e.into_inner());
            let name: Vec<u16> = format!(
                "Local\\DKNNexus.Recovery.Test.{}\0",
                unsafe { GetCurrentProcessId() }
            )
            .encode_utf16()
            .collect();
            unsafe { SetLastError(ERROR_ALREADY_EXISTS); }
            assert!(claim_recovery_start(&name));
            unsafe { SetLastError(ERROR_ALREADY_EXISTS); }
            assert!(!claim_recovery_start(&name));
            release_recovery_start();
        }

        #[test]
        fn a_windowless_recovery_slot_expires_and_can_be_reclaimed() {
            let _guard = RECOVERY_TEST.lock().unwrap_or_else(|e| e.into_inner());
            let name: Vec<u16> = format!(
                "Local\\DKNNexus.Recovery.Lease.Test.{}\0",
                unsafe { GetCurrentProcessId() }
            )
            .encode_utf16()
            .collect();
            assert!(claim_recovery_start_for(&name, Duration::from_millis(30)));
            assert!(!claim_recovery_start_for(&name, Duration::from_millis(30)));
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                if claim_recovery_start_for(&name, Duration::from_millis(30)) { break; }
                assert!(Instant::now() < deadline, "recovery lease did not expire");
                thread::sleep(Duration::from_millis(10));
            }
            release_recovery_start();
        }
    }
}

#[cfg(windows)]
mod clipboard_listener {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};
    use std::sync::{Mutex, OnceLock};
    use std::thread;
    use std::time::{Duration, Instant};
    use tauri::Emitter;

    const WM_CLIPBOARDUPDATE: u32 = 0x031D;
    const HWND_MESSAGE: isize = -3;
    const CF_UNICODETEXT: u32 = 13;
    const GMEM_MOVEABLE: u32 = 0x0002;

    struct PendingInternalWrite {
        text: String,
        expires_at: Instant,
    }

    fn pending_internal_write() -> &'static Mutex<Option<PendingInternalWrite>> {
        static PENDING: OnceLock<Mutex<Option<PendingInternalWrite>>> = OnceLock::new();
        PENDING.get_or_init(|| Mutex::new(None))
    }

    fn mark_internal_write(text: &str) {
        if let Ok(mut pending) = pending_internal_write().lock() {
            *pending = Some(PendingInternalWrite { text: text.to_string(), expires_at: Instant::now() + Duration::from_secs(2) });
        }
    }

    fn consume_internal_write(text: &str) -> bool {
        let Ok(mut pending) = pending_internal_write().lock() else { return false; };
        let Some(value) = pending.as_ref() else { return false; };
        if value.expires_at <= Instant::now() {
            *pending = None;
            return false;
        }
        if value.text == text {
            *pending = None;
            return true;
        }
        false
    }

    #[repr(C)]
    struct WndClassW {
        style: u32,
        window_proc: Option<unsafe extern "system" fn(isize, u32, usize, isize) -> isize>,
        class_extra: i32,
        window_extra: i32,
        instance: isize,
        icon: isize,
        cursor: isize,
        background: isize,
        menu_name: *const u16,
        class_name: *const u16,
    }

    #[repr(C)]
    struct Msg {
        window: isize,
        message: u32,
        w_param: usize,
        l_param: isize,
        time: u32,
        point: [i32; 2],
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn RegisterClassW(class: *const WndClassW) -> u16;
        fn CreateWindowExW(ex_style: u32, class_name: *const u16, window_name: *const u16, style: u32, x: i32, y: i32, width: i32, height: i32, parent: isize, menu: isize, instance: isize, parameter: *mut c_void) -> isize;
        fn AddClipboardFormatListener(window: isize) -> i32;
        fn GetMessageW(message: *mut Msg, window: isize, min_filter: u32, max_filter: u32) -> i32;
        fn TranslateMessage(message: *const Msg) -> i32;
        fn DispatchMessageW(message: *const Msg) -> isize;
        fn DefWindowProcW(window: isize, message: u32, w_param: usize, l_param: isize) -> isize;
        fn OpenClipboard(window: isize) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn GetClipboardData(format: u32) -> isize;
        fn SetClipboardData(format: u32, data: isize) -> isize;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleW(module: *const u16) -> isize;
        fn GlobalLock(memory: isize) -> *mut c_void;
        fn GlobalUnlock(memory: isize) -> i32;
        fn GlobalAlloc(flags: u32, bytes: usize) -> isize;
        fn GlobalFree(memory: isize) -> isize;
    }

    unsafe extern "system" fn window_proc(window: isize, message: u32, w_param: usize, l_param: isize) -> isize {
        DefWindowProcW(window, message, w_param, l_param)
    }

    fn read_text() -> Option<String> {
        unsafe {
            if OpenClipboard(0) == 0 { return None; }
            let data = GetClipboardData(CF_UNICODETEXT);
            if data == 0 {
                CloseClipboard();
                return None;
            }
            let pointer = GlobalLock(data) as *const u16;
            if pointer.is_null() {
                CloseClipboard();
                return None;
            }
            let mut length = 0usize;
            while *pointer.add(length) != 0 { length += 1; }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length));
            GlobalUnlock(data);
            CloseClipboard();
            (!text.is_empty()).then_some(text)
        }
    }

    pub fn set_text(text: &str) -> Result<(), String> {
        unsafe {
            if OpenClipboard(0) == 0 { return Err("无法打开 Windows 剪贴板".to_string()); }
            if EmptyClipboard() == 0 {
                CloseClipboard();
                return Err("无法清空 Windows 剪贴板".to_string());
            }
            let mut wide = text.encode_utf16().collect::<Vec<_>>();
            wide.push(0);
            let memory = GlobalAlloc(GMEM_MOVEABLE, wide.len() * std::mem::size_of::<u16>());
            if memory == 0 {
                CloseClipboard();
                return Err("无法分配剪贴板内存".to_string());
            }
            let pointer = GlobalLock(memory) as *mut u16;
            if pointer.is_null() {
                GlobalFree(memory);
                CloseClipboard();
                return Err("无法锁定剪贴板内存".to_string());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), pointer, wide.len());
            GlobalUnlock(memory);
            if SetClipboardData(CF_UNICODETEXT, memory) == 0 {
                GlobalFree(memory);
                CloseClipboard();
                return Err("无法写入 Windows 剪贴板".to_string());
            }
            mark_internal_write(text);
            CloseClipboard();
            Ok(())
        }
    }

    pub fn start(app: tauri::AppHandle) {
        thread::spawn(move || unsafe {
            let class_name: Vec<u16> = "DKNNexusClipboardListener\0".encode_utf16().collect();
            let instance = GetModuleHandleW(null());
            let class = WndClassW { style: 0, window_proc: Some(window_proc), class_extra: 0, window_extra: 0, instance, icon: 0, cursor: 0, background: 0, menu_name: null(), class_name: class_name.as_ptr() };
            RegisterClassW(&class);
            let window = CreateWindowExW(0, class_name.as_ptr(), class_name.as_ptr(), 0, 0, 0, 0, 0, HWND_MESSAGE, 0, instance, null_mut());
            if window == 0 || AddClipboardFormatListener(window) == 0 {
                super::diagnostic_log("clipboard:listener_start_failed");
                return;
            }
            super::diagnostic_log("clipboard:listener_ready");
            let mut message = Msg { window: 0, message: 0, w_param: 0, l_param: 0, time: 0, point: [0, 0] };
            while GetMessageW(&mut message, 0, 0, 0) > 0 {
                if message.message == WM_CLIPBOARDUPDATE {
                    if let Some(text) = read_text() {
                        if !consume_internal_write(&text) {
                            let _ = app.emit("dkn://clipboard", text);
                        } else {
                            super::diagnostic_log("clipboard:ignore_internal_write");
                        }
                    }
                }
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        });
    }
}

#[cfg(windows)]
mod secure_store {
    use std::ffi::c_void;
    use std::fs;
    use std::path::PathBuf;
    use std::ptr::null_mut;

    const CRED_TYPE_GENERIC: u32 = 1;

    #[repr(C)]
    struct FileTime { low: u32, high: u32 }

    #[repr(C)]
    struct CredentialW {
        flags: u32,
        credential_type: u32,
        target_name: *mut u16,
        comment: *mut u16,
        last_written: FileTime,
        credential_blob_size: u32,
        credential_blob: *mut u8,
        persist: u32,
        attribute_count: u32,
        attributes: *mut c_void,
        target_alias: *mut u16,
        user_name: *mut u16,
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn CredReadW(target_name: *const u16, credential_type: u32, flags: u32, credential: *mut *mut CredentialW) -> i32;
        fn CredDeleteW(target_name: *const u16, credential_type: u32, flags: u32) -> i32;
    }

    #[link(name = "advapi32")]
    unsafe extern "system" { fn CredFree(buffer: *mut c_void); }

    #[repr(C)]
    struct DataBlob { size: u32, data: *mut u8 }

    #[link(name = "crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(input: *const DataBlob, description: *const u16, entropy: *const DataBlob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, output: *mut DataBlob) -> i32;
        fn CryptUnprotectData(input: *const DataBlob, description: *mut *mut u16, entropy: *const DataBlob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, output: *mut DataBlob) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(std::iter::once(0)).collect() }
    fn target(name: &str) -> Vec<u16> { wide(&format!("DKN Nexus/{name}")) }
    fn secret_path(name: &str) -> Result<PathBuf, String> {
        let image_key = name.strip_prefix("agent-image-").is_some_and(|id| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let text_key = name.strip_prefix("agent-text-").is_some_and(|id| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()));
        if !matches!(name, "deepseek-api-key" | "bocha-api-key") && !image_key && !text_key { return Err("不支持的密钥名称".to_string()); }
        let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).ok_or_else(|| "找不到当前用户的 LOCALAPPDATA 目录".to_string())?;
        Ok(base.join("DKN Nexus").join("secrets").join(format!("{name}.bin")))
    }

    fn protect(value: &[u8]) -> Result<Vec<u8>, String> {
        let input = DataBlob { size: value.len() as u32, data: value.as_ptr() as *mut u8 };
        let mut output = DataBlob { size: 0, data: null_mut() };
        if unsafe { CryptProtectData(&input, null_mut(), null_mut(), null_mut(), null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) } == 0 {
            return Err(format!("Windows DPAPI 加密失败：{}", std::io::Error::last_os_error()));
        }
        let bytes = unsafe { std::slice::from_raw_parts(output.data, output.size as usize).to_vec() };
        unsafe { LocalFree(output.data as *mut c_void); }
        Ok(bytes)
    }

    fn unprotect(value: &[u8]) -> Result<String, String> {
        let input = DataBlob { size: value.len() as u32, data: value.as_ptr() as *mut u8 };
        let mut output = DataBlob { size: 0, data: null_mut() };
        if unsafe { CryptUnprotectData(&input, null_mut(), null_mut(), null_mut(), null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) } == 0 {
            return Err(format!("Windows DPAPI 解密失败：{}", std::io::Error::last_os_error()));
        }
        let result = unsafe { String::from_utf8(std::slice::from_raw_parts(output.data, output.size as usize).to_vec()) }
            .map_err(|_| "保存的密钥格式无效".to_string());
        unsafe { LocalFree(output.data as *mut c_void); }
        result
    }

    pub fn save(name: &str, value: &str) -> Result<(), String> {
        let path = secret_path(name)?;
        let parent = path.parent().ok_or_else(|| "密钥保存目录无效".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("无法创建本机密钥目录：{error}"))?;
        let encrypted = protect(value.as_bytes())?;
        let temporary = path.with_extension("bin.tmp");
        fs::write(&temporary, encrypted).map_err(|error| format!("无法写入加密密钥文件：{error}"))?;
        let temporary_wide = wide(&temporary.to_string_lossy());
        let path_wide = wide(&path.to_string_lossy());
        if unsafe { MoveFileExW(temporary_wide.as_ptr(), path_wide.as_ptr(), 0x1 | 0x8) } == 0 {
            let error = std::io::Error::last_os_error();
            let _ = fs::remove_file(&temporary);
            return Err(format!("无法完成密钥文件保存：{error}"));
        }
        // Keep the prior Credential Manager entry until the DPAPI copy has been written.
        let _ = delete_credential(name);
        Ok(())
    }

    fn load_credential(name: &str) -> Result<String, String> {
        let target_name = target(name); let mut credential: *mut CredentialW = null_mut();
        if unsafe { CredReadW(target_name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 { return Err(format!("未找到旧版凭据：{}", std::io::Error::last_os_error())); }
        let value = unsafe { let item = &*credential; let bytes = std::slice::from_raw_parts(item.credential_blob, item.credential_blob_size as usize); String::from_utf8(bytes.to_vec()).map_err(|_| "旧版密钥格式无效".to_string()) };
        unsafe { CredFree(credential as *mut c_void); }
        value
    }

    pub fn load(name: &str) -> Result<String, String> {
        let path = secret_path(name)?;
        match fs::read(path) {
            Ok(encrypted) => unprotect(&encrypted),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Migrate keys saved by earlier app versions on first successful read.
                let legacy = load_credential(name)?;
                save(name, &legacy)?;
                Ok(legacy)
            }
            Err(error) => Err(format!("无法读取本机加密密钥文件：{error}")),
        }
    }

    fn delete_credential(name: &str) -> Result<(), String> {
        let target_name = target(name);
        if unsafe { CredDeleteW(target_name.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(1168) { return Err(format!("旧版凭据删除失败：{error}")); }
        }
        Ok(())
    }

    pub fn delete(name: &str) -> Result<(), String> {
        let path = secret_path(name)?;
        if path.exists() { fs::remove_file(path).map_err(|error| format!("本机密钥删除失败：{error}"))?; }
        delete_credential(name)
    }

}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AppClassification {
    #[serde(rename = "normal-app")]
    NormalApp,
    #[serde(rename = "runtime")]
    Runtime,
    #[serde(rename = "system-component")]
    SystemComponent,
    #[serde(rename = "uninstaller")]
    Uninstaller,
    #[serde(rename = "installer")]
    Installer,
    #[serde(rename = "updater")]
    Updater,
    #[serde(rename = "helper")]
    Helper,
    #[serde(rename = "developer-tool")]
    DeveloperTool,
    #[serde(rename = "unknown")]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppCategory { Ai, Development, Game, Office, Browser, Media, Social, SystemTool, Other }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedApplication {
    pub id: String,
    pub name: String,
    pub launch_target: String,
    pub source: String,
    pub icon: Option<String>,
    pub is_pinned: bool,
    pub classification: AppClassification,
    pub category: AppCategory,
    pub publisher: Option<String>,
    pub product_name: Option<String>,
    pub file_description: Option<String>,
    pub shortcut_path: Option<String>,
}

fn shortcut_roots() -> Vec<(PathBuf, &'static str)> {
    let mut roots = Vec::new();
    if let Ok(app_data) = env::var("APPDATA") {
        roots.push((PathBuf::from(app_data).join(r"Microsoft\Windows\Start Menu\Programs"), "start-menu"));
    }
    if let Ok(program_data) = env::var("PROGRAMDATA") {
        roots.push((PathBuf::from(program_data).join(r"Microsoft\Windows\Start Menu\Programs"), "start-menu"));
    }
    if let Ok(user_profile) = env::var("USERPROFILE") {
        roots.push((PathBuf::from(user_profile).join("Desktop"), "desktop"));
    }
    roots
}

fn scan_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(windows)]
fn configure_hidden_child(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_hidden_child(_command: &mut Command) {}

fn run_powershell_script(script: &str, timeout: Duration) -> Result<Vec<u8>, String> {
    let started = Instant::now();
    let mut command = Command::new("powershell");
    configure_hidden_child(&mut command);
    let mut child = command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("无法启动 PowerShell 扫描器：{error}"))?;
    let stdout = child.stdout.take();
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut stdout) = stdout { let _ = stdout.read_to_end(&mut bytes); }
        bytes
    });
    let mut wait_error = None;
    let timed_out = loop {
        match child.try_wait() {
            Ok(Some(_)) => break false,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                break true;
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                wait_error = Some(error.to_string());
                let _ = child.kill();
                break false;
            }
        }
    };
    let status = child.wait().map_err(|error| format!("等待 PowerShell 扫描器失败：{error}"))?;
    let stdout = stdout_reader.join().map_err(|_| "读取 PowerShell 扫描结果失败。".to_string())?;
    if let Some(error) = wait_error { return Err(format!("等待 PowerShell 扫描器失败：{error}")); }
    if timed_out { return Err(format!("PowerShell 扫描器超过 {} 秒，已终止。", timeout.as_secs())); }
    if !status.success() { return Err(format!("PowerShell 扫描器退出状态异常：{status}")); }
    Ok(stdout)
}

struct DiagnosticLogger;

fn last_webview_creation_error() -> &'static Mutex<Option<String>> {
    static ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    ERROR.get_or_init(|| Mutex::new(None))
}

impl log::Log for DiagnosticLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Warn
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            let message = record.args().to_string();
            if record.level() == log::Level::Error && record.target().starts_with("tauri_runtime_wry")
                && message.contains("failed to create webview") {
                *last_webview_creation_error().lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(message.chars().take(2048).collect());
            }
            diagnostic_log(format!("runtime:{}:{} {}", record.level(), record.target(), record.args()));
        }
    }

    fn flush(&self) {}
}

fn initialize_diagnostic_logger() {
    static LOGGER: DiagnosticLogger = DiagnosticLogger;
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Warn);
    }
}

#[cfg(windows)]
fn report_startup_failure(reason: &str) {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(window: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }
    let text: Vec<u16> = format!("DKN Nexus 无法创建应用界面，本次启动将退出。\n\n错误详情：{reason}\n\n请保留此提示以便排查。\0")
        .encode_utf16().collect();
    let caption: Vec<u16> = "DKN Nexus 启动失败\0".encode_utf16().collect();
    unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), 0x10); }
}

fn diagnostic_log(message: impl AsRef<str>) {
    let message = message.as_ref();
    let _ = writeln!(std::io::stderr(), "[DKN] {message}");
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_secs()).unwrap_or_default();
    let mut directories = Vec::new();
    if let Some(directory) = env::var_os("DKN_DIAGNOSTIC_DIR") {
        directories.push(PathBuf::from(directory));
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        directories.push(PathBuf::from(local_app_data).join("DKN Nexus"));
    }
    directories.push(env::temp_dir().join("DKN Nexus"));
    for directory in directories {
        if fs::create_dir_all(&directory).is_err() { continue; }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(directory.join("dkn-nexus.log")) {
            let _ = writeln!(file, "{timestamp} {message}");
            break;
        }
    }
}

fn active_shortcut() -> &'static Mutex<String> {
    static SHORTCUT: OnceLock<Mutex<String>> = OnceLock::new();
    SHORTCUT.get_or_init(|| Mutex::new("ALT+SPACE".to_string()))
}

fn allow_shortcut_trigger() -> bool {
    static LAST_TRIGGER: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    let now = Instant::now();
    let mut last = LAST_TRIGGER.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if last.is_some_and(|previous| now.duration_since(previous) < Duration::from_millis(220)) { return false; }
    *last = Some(now);
    true
}

fn normalize_shortcut(value: &str) -> Result<String, String> {
    let normalized = value.split_whitespace().collect::<String>().to_uppercase();
    if normalized.is_empty() || !normalized.contains('+') { return Err("快捷键格式应类似 ALT+SPACE 或 CTRL+SHIFT+F".to_string()); }
    Ok(normalized)
}

fn tray_icon_image() -> tauri::image::Image<'static> {
    tauri::image::Image::new_owned(include_bytes!("../icons/32x32.rgba").to_vec(), 32, 32)
}

fn stable_id(name: &str, target: &str) -> String {
    let raw = format!("{}:{}", name.to_lowercase(), target.to_lowercase());
    raw.chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

fn contains_word(haystack: &str, needle: &str) -> bool {
    haystack.match_indices(needle).any(|(index, value)| {
        let before = haystack[..index].chars().next_back();
        let after = haystack[index + value.len()..].chars().next();
        let boundary = |character: Option<char>| character.map(|character| !character.is_ascii_alphanumeric()).unwrap_or(true);
        boundary(before) && boundary(after)
    })
}

fn has_any_word(haystack: &str, words: &[&str]) -> bool {
    words.iter().any(|word| contains_word(haystack, word))
}

#[derive(Debug, Clone)]
struct ShortcutMetadata {
    target: String,
    publisher: Option<String>,
    product_name: Option<String>,
    file_description: Option<String>,
    icon: Option<String>,
}

fn shortcut_cache() -> &'static Mutex<HashMap<String, ShortcutMetadata>> {
    static CACHE: OnceLock<Mutex<HashMap<String, ShortcutMetadata>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn powershell_shortcut_targets(paths: &[PathBuf]) -> HashMap<String, ShortcutMetadata> {
    if paths.is_empty() { return HashMap::new(); }
    let pending = {
        let cache = shortcut_cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        paths.iter().filter(|path| !cache.contains_key(&path.to_string_lossy().to_string())).cloned().collect::<Vec<_>>()
    };
    if pending.is_empty() {
        let cache = shortcut_cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        return paths.iter().filter_map(|path| cache.get(&path.to_string_lossy().to_string()).cloned().map(|value| (path.to_string_lossy().to_string(), value))).collect();
    }
    let quoted_paths = pending.iter().map(|path| {
        format!("'{}'", path.to_string_lossy().replace('\'', "''"))
    }).collect::<Vec<_>>().join(",");
    let script = format!(
        "Add-Type -AssemblyName System.Drawing; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $shell=New-Object -ComObject WScript.Shell; $paths=@({quoted_paths}); foreach ($path in $paths) {{ try {{ $shortcut=$shell.CreateShortcut($path); $target=$shortcut.TargetPath; if (!$target) {{ continue }}; $iconPath=$shortcut.IconLocation; if ($iconPath -and $iconPath.Contains(',')) {{ $iconPath=$iconPath.Split(',')[0] }}; if (!$iconPath -or !(Test-Path -LiteralPath $iconPath)) {{ $iconPath=$target }}; $publisher=''; $productName=''; $description=''; try {{ $version=[Diagnostics.FileVersionInfo]::GetVersionInfo($target); $publisher=$version.CompanyName; $productName=$version.ProductName; $description=$version.FileDescription }} catch {{ }}; $iconData=''; try {{ $icon=[Drawing.Icon]::ExtractAssociatedIcon($iconPath); if ($icon) {{ $bitmap=$icon.ToBitmap(); $stream=New-Object IO.MemoryStream; $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png); $iconData=[Convert]::ToBase64String($stream.ToArray()); $stream.Dispose(); $bitmap.Dispose(); $icon.Dispose() }} }} catch {{ }}; [Console]::WriteLine($path + \"`t\" + $target + \"`t\" + $publisher + \"`t\" + $productName + \"`t\" + $description + \"`t\" + $iconData) }} catch {{ }} }}"
    );
    let stdout = match run_powershell_script(&script, Duration::from_secs(8)) {
        Ok(stdout) => stdout,
        Err(error) => {
            diagnostic_log(format!("scan:powershell_failed files={} error={error}", paths.len()));
            return HashMap::new();
        }
    };
    let mut cache = shortcut_cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for line in String::from_utf8_lossy(&stdout).lines() {
        let mut fields = line.splitn(6, '\t');
        let Some(path) = fields.next().map(str::trim).filter(|value| !value.is_empty()) else { continue; };
        let Some(target) = fields.next().map(str::trim).filter(|value| !value.is_empty()) else { continue; };
        let publisher = fields.next().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
        let product_name = fields.next().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
        let file_description = fields.next().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
        let icon = fields.next().map(str::trim).filter(|value| !value.is_empty()).map(|value| format!("data:image/png;base64,{value}"));
        cache.insert(path.to_string(), ShortcutMetadata { target: target.to_string(), publisher, product_name, file_description, icon });
    }
    paths.iter().filter_map(|path| cache.get(&path.to_string_lossy().to_string()).cloned().map(|value| (path.to_string_lossy().to_string(), value))).collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryApplication {
    name: String,
    target: String,
    publisher: Option<String>,
    product_name: Option<String>,
    file_description: Option<String>,
    icon: Option<String>,
}

fn scan_registry_applications() -> Result<Vec<ScannedApplication>, String> {
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$roots = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$apps = foreach ($root in $roots) { Get-ItemProperty -Path $root -ErrorAction SilentlyContinue }
foreach ($app in $apps) {
  if (!$app.DisplayName -or $app.SystemComponent -eq 1) { continue }
  $iconSpec = [Environment]::ExpandEnvironmentVariables(([string]$app.DisplayIcon).Trim())
  $target = $null
  if ($iconSpec -match '^\s*"(?<exe>[^"]+\.exe)"(?:\s*,\s*-?\d+)?\s*$') { $target = $Matches.exe }
  elseif ($iconSpec -match '^\s*(?<exe>.*?\.exe)(?:\s*,\s*-?\d+)?\s*$') { $target = $Matches.exe.Trim('"') }
  if (!$target -or !(Test-Path -LiteralPath $target -PathType Leaf)) { continue }
  try {
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($target)
    $iconData = $null
    try {
      $icon = [Drawing.Icon]::ExtractAssociatedIcon($target)
      if ($icon) {
        $bitmap = $icon.ToBitmap(); $stream = New-Object IO.MemoryStream
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        $iconData = 'data:image/png;base64,' + [Convert]::ToBase64String($stream.ToArray())
        $stream.Dispose(); $bitmap.Dispose(); $icon.Dispose()
      }
    } catch { }
    $publisher = [string]$app.Publisher
    if (!$publisher) { $publisher = [string]$version.CompanyName }
    $productName = [string]$version.ProductName
    if (!$productName) { $productName = [string]$app.DisplayName }
    $record = [ordered]@{
      name = [string]$app.DisplayName
      target = [string]$target
      publisher = $publisher
      productName = $productName
      fileDescription = [string]$version.FileDescription
      icon = $iconData
    }
    [Console]::WriteLine(($record | ConvertTo-Json -Compress -Depth 3))
  } catch { }
}
"#;
    let output = run_powershell_script(script, Duration::from_secs(12))?;
    let mut applications = Vec::new();
    for line in String::from_utf8_lossy(&output).lines().map(str::trim).filter(|line| !line.is_empty()) {
        let Ok(record) = serde_json::from_str::<RegistryApplication>(line) else { continue; };
        let name = record.name.trim().to_string();
        let target = record.target.trim().to_string();
        if name.is_empty() || target.is_empty() { continue; }
        let classification = classify_application(&name, "", &target, record.publisher.as_deref(), record.product_name.as_deref(), record.file_description.as_deref());
        let category = categorize_application(&name, "", &target, record.publisher.as_deref(), record.product_name.as_deref(), record.file_description.as_deref(), &classification);
        let id = stable_id(&name, &target);
        applications.push(ScannedApplication {
            id, name, launch_target: target, source: "registry".to_string(), icon: record.icon, is_pinned: false,
            classification, category, publisher: record.publisher, product_name: record.product_name,
            file_description: record.file_description, shortcut_path: None,
        });
    }
    Ok(applications)
}

fn classify_application(name: &str, shortcut_path: &str, target: &str, publisher: Option<&str>, product_name: Option<&str>, file_description: Option<&str>) -> AppClassification {
    let haystack = format!("{} {} {} {} {} {}", name, shortcut_path, target, publisher.unwrap_or_default(), product_name.unwrap_or_default(), file_description.unwrap_or_default()).to_lowercase();
    let path = target.to_lowercase();
    let has_any = |items: &[&str]| items.iter().any(|item| haystack.contains(item));
    if has_any(&["uninstall", "uninstaller", "unins", "remove", "repair", "maintenance"]) { return AppClassification::Uninstaller; }
    if has_any(&["setup", "installer", "installshield", "redistributable installer", "install.exe", "setup.exe"]) { return AppClassification::Installer; }
    if has_any(&["runtime", "redistributable", "vcredist", "visual c++", "java runtime", "jre", "dotnet", ".net runtime", ".net framework"]) { return AppClassification::Runtime; }
    if has_any(&["updater", "update service", "crash reporter", "crashreporter", "error reporter"]) { return AppClassification::Updater; }
    if has_any(&["helper", "background task", "launcher helper", "readme", "documentation", "tutorials", "crash reporter", "crashreporter", "error reporter", "license"]) || has_any_word(&haystack, &["service", "help"]) || ["chm", "html", "htm", "url", "pdf", "txt"].iter().any(|extension| path.ends_with(&format!(".{extension}"))) { return AppClassification::Helper; }
    if path.contains("\\windows\\") || path.contains("\\system32\\") || path.contains("\\windowsapps\\") || haystack.contains("system component") { return AppClassification::SystemComponent; }
    if has_any(&["visual studio", "vs code", "code.exe", "jetbrains", "android studio"]) || has_any_word(&haystack, &["terminal", "git", "node", "python", "developer", "sdk"]) { return AppClassification::DeveloperTool; }
    if publisher.is_none() && !std::path::Path::new(target).exists() { return AppClassification::Unknown; }
    AppClassification::NormalApp
}

fn categorize_application(name: &str, shortcut_path: &str, target: &str, publisher: Option<&str>, product_name: Option<&str>, file_description: Option<&str>, classification: &AppClassification) -> AppCategory {
    let haystack = format!("{} {} {} {} {} {}", name, shortcut_path, target, publisher.unwrap_or_default(), product_name.unwrap_or_default(), file_description.unwrap_or_default()).to_lowercase();
    let has_any = |items: &[&str]| items.iter().any(|item| haystack.contains(item));
    if has_any(&["chatgpt", "deepseek", "claude", "copilot", "perplexity", "cursor", "openai"]) { return AppCategory::Ai; }
    if matches!(classification, AppClassification::DeveloperTool) || has_any(&["visual studio", "vs code", "jetbrains", "android studio", "xcode"]) || has_any_word(&haystack, &["terminal", "git", "node", "python"]) { return AppCategory::Development; }
    if has_any(&["obs studio", "obs64.exe", "studio one", "afterfx", "premiere", "photoshop", "jianying", "剪映", "直播伴侣"]) { return AppCategory::Media; }
    if has_any(&["steam", "steamapps", "epic games", "riot games", "battle.net", "ubisoft game launcher", "ea games", "origin games", "rockstar games", "xboxgames", "gamepass", "minecraft", "gog galaxy", "playnite", "heroic", "game launcher", "\\games\\", "\\game\\", "\\steamapps\\common\\", "wegame", "wegameapps", "gamepp", "5eclient", "5e对战", "三角洲行动", "delta force", "完美世界竞技", "无畏契约", "英雄联盟", "aimlab", "aim lab", "playgtav", "grand theft auto", "cyberpunk", "redprelauncher", "ghostrunner", "puzzlegame", "plain craft launcher", "leigod", "游戏加加", "无极画质"]) { return AppCategory::Game; }
    if has_any(&["valve", "epic games, inc", "riot games", "ubisoft", "electronic arts", "rockstar games", "bethesda", "cd projekt", "blizzard", "activision", "bandai namco", "square enix", "capcom", "mihoyo", "hoyoverse"]) { return AppCategory::Game; }
    if has_any(&["word", "excel", "powerpoint", "office", "notion", "obsidian", "libreoffice", "wps"]) { return AppCategory::Office; }
    if has_any(&["chrome", "firefox", "edge", "brave", "opera", "vivaldi", "browser"]) { return AppCategory::Browser; }
    if has_any(&["spotify", "vlc", "foobar", "itunes", "premiere", "photoshop", "after effects", "music", "video"]) { return AppCategory::Media; }
    if has_any(&["discord", "slack", "telegram", "wechat", "weixin", "qq", "teams", "zoom", "skype"]) { return AppCategory::Social; }
    if has_any(&["terminal", "powershell", "cmd", "task manager", "control panel", "settings", "system", "defender"]) { return AppCategory::SystemTool; }
    AppCategory::Other
}

fn scan_shortcuts() -> Vec<ScannedApplication> {
    let _scan_guard = scan_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let started = Instant::now();
    let mut shortcut_files: Vec<(PathBuf, &'static str)> = Vec::new();
    for (root, source) in shortcut_roots() {
        if !root.exists() { continue; }
        for entry in walkdir::WalkDir::new(&root).follow_links(false) {
            match entry {
                Ok(entry) => {
                    let path = entry.path();
                    let is_shortcut = path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("lnk")).unwrap_or(false);
                    if is_shortcut { shortcut_files.push((path.to_path_buf(), source)); }
                }
                Err(error) => diagnostic_log(format!("scan:walk_error root={} error={error}", root.display())),
            }
        }
    }
    diagnostic_log(format!("scan:start files={}", shortcut_files.len()));
    let paths = shortcut_files.iter().map(|(path, _)| path.clone()).collect::<Vec<_>>();
    let mut targets = HashMap::new();
    for batch in paths.chunks(64) {
        targets.extend(powershell_shortcut_targets(batch));
    }
    let mut by_id: HashMap<String, ScannedApplication> = HashMap::new();
    for (path, source) in &shortcut_files {
        let path_key = path.to_string_lossy().to_string();
        let Some(metadata) = targets.get(&path_key) else { continue; };
        let Some(stem) = path.file_stem().and_then(|name| name.to_str()) else { continue; };
        let name = stem.trim().to_string();
        if name.is_empty() { continue; }
        let id = stable_id(&name, &metadata.target);
        let classification = classify_application(&name, &path_key, &metadata.target, metadata.publisher.as_deref(), metadata.product_name.as_deref(), metadata.file_description.as_deref());
        let category = categorize_application(&name, &path_key, &metadata.target, metadata.publisher.as_deref(), metadata.product_name.as_deref(), metadata.file_description.as_deref(), &classification);
        by_id.entry(id.clone()).or_insert(ScannedApplication { id, name, launch_target: metadata.target.clone(), source: (*source).to_string(), icon: metadata.icon.clone(), is_pinned: false, classification, category, publisher: metadata.publisher.clone(), product_name: metadata.product_name.clone(), file_description: metadata.file_description.clone(), shortcut_path: Some(path_key) });
    }
    let shortcut_app_count = by_id.len();
    let shortcut_targets = by_id.values().map(|app| app.launch_target.to_lowercase().replace('/', "\\")).collect::<HashSet<_>>();
    let registry_result = scan_registry_applications();
    let mut registry_added = 0usize;
    match registry_result {
        Ok(registry_apps) => {
            for app in registry_apps {
                let target_key = app.launch_target.to_lowercase().replace('/', "\\");
                if shortcut_targets.contains(&target_key) { continue; }
                if !by_id.contains_key(&app.id) {
                    by_id.insert(app.id.clone(), app);
                    registry_added += 1;
                }
            }
        }
        Err(error) => diagnostic_log(format!("scan:registry_failed error={error}")),
    }
    let mut applications: Vec<_> = by_id.into_values().collect();
    applications.sort_by_key(|app| app.name.to_lowercase());
    diagnostic_log(format!("scan:done shortcuts={} resolved={} shortcut_apps={} registry_added={} apps={} elapsed_ms={}", shortcut_files.len(), targets.len(), shortcut_app_count, registry_added, applications.len(), started.elapsed().as_millis()));
    applications
}

#[tauri::command]
async fn list_applications() -> Vec<ScannedApplication> {
    match tauri::async_runtime::spawn_blocking(scan_shortcuts).await {
        Ok(applications) => applications,
        Err(error) => {
            diagnostic_log(format!("scan:worker_failed error={error}"));
            Vec::new()
        }
    }
}

#[cfg(test)]
mod app_scan_tests {
    use super::*;

    #[test]
    fn service_brand_is_not_filtered_as_a_helper() {
        assert_eq!(
            classify_application("ServiceNow", "", r"C:\Program Files\ServiceNow\Agent.exe", Some("ServiceNow"), Some("ServiceNow Agent"), Some("Desktop client")),
            AppClassification::NormalApp,
        );
    }

    #[test]
    fn digital_name_is_not_misclassified_as_development() {
        let classification = classify_application("Digital Wallet", "", r"C:\Program Files\Wallet\wallet.exe", Some("Example Corp"), Some("Digital Wallet"), None);
        assert_ne!(classification, AppClassification::DeveloperTool);
        assert_eq!(categorize_application("Digital Wallet", "", r"C:\Program Files\Wallet\wallet.exe", Some("Example Corp"), Some("Digital Wallet"), None, &classification), AppCategory::Other);
    }

    #[test]
    fn sdk_tools_are_developer_tools_not_hidden_runtimes() {
        assert_eq!(
            classify_application("Example SDK Manager", "", r"C:\Program Files\Example\sdk-manager.exe", Some("Example Corp"), Some("Example SDK Manager"), None),
            AppClassification::DeveloperTool,
        );
    }
}

#[tauri::command]
fn launch_application(target: String, shortcut_path: Option<String>) -> Result<(), String> {
    diagnostic_log(format!("launch:start target={target}"));
    if let Some(shortcut) = shortcut_path.filter(|path| PathBuf::from(path).is_file() && path.to_lowercase().ends_with(".lnk")) {
        let mut command = Command::new("cmd");
        configure_hidden_child(&mut command);
        diagnostic_log("launch:via_shortcut");
        return command.args(["/C", "start", "", &shortcut]).spawn().map(|_| ()).map_err(|error| format!("无法打开 Windows 快捷方式：{error}"));
    }
    let direct_path = PathBuf::from(target.trim().trim_matches('"'));
    if direct_path.is_file() && direct_path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("exe")) {
        let mut command = Command::new(&direct_path);
        if let Some(parent) = direct_path.parent() { command.current_dir(parent); }
        configure_hidden_child(&mut command);
        return command.spawn().map(|_| ()).map_err(|error| format!("无法启动自定义应用：{error}"));
    }
    let mut command = Command::new("cmd");
    configure_hidden_child(&mut command);
    command.args(["/C", "start", "", &target]).spawn().map(|_| ()).map_err(|error| error.to_string())
}

#[tauri::command]
fn pick_application_file() -> Result<Option<String>, String> {
    let script = "Add-Type -AssemblyName System.Windows.Forms; $dialog=New-Object System.Windows.Forms.OpenFileDialog; $dialog.Title='选择应用程序'; $dialog.Filter='应用程序 (*.exe)|*.exe|快捷方式 (*.lnk)|*.lnk|所有文件 (*.*)|*.*'; $dialog.CheckFileExists=$true; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Write($dialog.FileName) }";
    let mut command = Command::new("powershell");
    configure_hidden_child(&mut command);
    let output = command.args(["-STA", "-NoProfile", "-NonInteractive", "-Command", script]).output().map_err(|error| format!("无法打开文件选择器：{error}"))?;
    if !output.status.success() { return Err("文件选择器打开失败".to_string()); }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!path.is_empty()).then_some(path))
}

fn close_processes_for_target(target: &str) -> Result<(), String> {
    let path = PathBuf::from(target.trim());
    if !path.is_absolute() || !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("exe")) { return Ok(()); }
    let escaped = target.replace('\'', "''");
    let script = format!("$target='{}'; Get-CimInstance Win32_Process | Where-Object {{ $_.ExecutablePath -eq $target -and $_.Name -ne 'dkn-nexus.exe' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}", escaped);
    let mut command = Command::new("powershell");
    configure_hidden_child(&mut command);
    command.args(["-NoProfile", "-NonInteractive", "-Command", &script]).spawn().map(|_| ()).map_err(|error| error.to_string())
}

fn close_all_non_system_processes() -> Result<(), String> {
    let script = r#"$protected=@('dkn-nexus.exe','explorer.exe','powershell.exe','pwsh.exe','cmd.exe','conhost.exe','svchost.exe','services.exe','lsass.exe','winlogon.exe','csrss.exe','smss.exe','wininit.exe','MsMpEng.exe','RuntimeBroker.exe'); Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -and $_.Path -notlike 'C:\Windows\*' -and $protected -notcontains $_.ProcessName+'.exe' } | Stop-Process -Force -ErrorAction SilentlyContinue"#;
    let mut command = Command::new("powershell");
    configure_hidden_child(&mut command);
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]).spawn().map(|_| ()).map_err(|error| error.to_string())
}

#[tauri::command]
fn run_nexus_mode(close_targets: Vec<String>, launch_targets: Vec<String>, launch_shortcut_paths: Vec<Option<String>>, close_all_non_system: bool) -> Result<(), String> {
    diagnostic_log(format!("mode:run close={} launch={} close_all={close_all_non_system}", close_targets.len(), launch_targets.len()));
    if close_all_non_system { close_all_non_system_processes()?; }
    for target in close_targets { close_processes_for_target(&target)?; }
    for (index, target) in launch_targets.into_iter().enumerate() { launch_application(target, launch_shortcut_paths.get(index).cloned().flatten())?; }
    Ok(())
}

#[tauri::command]
fn save_secret(name: String, value: String) -> Result<(), String> {
    if name.starts_with("agent-image-") || name.starts_with("agent-text-") { return Err("Agent API Key 必须通过对应服务配置流程安全保存。".to_string()); }
    #[cfg(windows)] { return secure_store::save(&name, &value); }
    #[cfg(not(windows))] { let _ = (name, value); Err("当前平台没有启用 Windows 安全存储".to_string()) }
}

#[tauri::command]
fn load_secret(name: String) -> Result<String, String> {
    if name.starts_with("agent-image-") || name.starts_with("agent-text-") { return Err("Agent API Key 只能由本机服务在执行时使用，不能返回给前端。".to_string()); }
    #[cfg(windows)] { return secure_store::load(&name); }
    #[cfg(not(windows))] { let _ = name; Err("当前平台没有启用 Windows 安全存储".to_string()) }
}

#[tauri::command]
fn delete_secret(name: String) -> Result<(), String> {
    #[cfg(windows)] { return secure_store::delete(&name); }
    #[cfg(not(windows))] { let _ = name; Err("当前平台没有启用 Windows 安全存储".to_string()) }
}

fn default_notes_directory() -> PathBuf {
    if let Ok(exe) = env::current_exe() {
        let mut ancestor = exe.parent().map(PathBuf::from);
        for _ in 0..3 {
            if let Some(path) = ancestor.as_mut() { *path = path.parent().map(PathBuf::from).unwrap_or_else(|| path.clone()); }
        }
        if let Some(project_root) = ancestor {
            if project_root.join("src-tauri").is_dir() {
                return project_root.join("data").join("notes");
            }
        }
    }
    env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(env::temp_dir).join("DKN Nexus").join("notes")
}

fn safe_file_component(value: &str) -> String {
    let sanitized = value.chars().map(|character| match character {
        '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
        character if character.is_control() => '_',
        character => character,
    }).collect::<String>();
    let trimmed = sanitized.trim().trim_matches('.').to_string();
    if trimmed.is_empty() { "未命名笔记".to_string() } else { trimmed.chars().take(80).collect() }
}

#[tauri::command]
fn save_note(title: String, content: String, directory: Option<String>) -> Result<String, String> {
    let directory = directory.filter(|value| !value.trim().is_empty()).map(PathBuf::from).unwrap_or_else(default_notes_directory);
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建记事本目录：{error}"))?;
    let timestamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let path = directory.join(format!("{}_{}.txt", timestamp, safe_file_component(&title)));
    fs::write(&path, content.as_bytes()).map_err(|error| format!("无法保存 TXT：{error}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn set_clipboard_text(text: String) -> Result<(), String> {
    #[cfg(windows)]
    { clipboard_listener::set_text(&text) }
    #[cfg(not(windows))]
    { let _ = text; Err("当前平台不支持 Windows 剪贴板写入".to_string()) }
}

#[tauri::command]
fn set_launch_at_startup(enabled: bool) -> Result<(), String> {
    diagnostic_log(format!("startup:set enabled={enabled}"));
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    if enabled {
        let exe = env::current_exe().map_err(|error| error.to_string())?;
        let mut command = Command::new("reg");
        configure_hidden_child(&mut command);
        command.args(["add", key, "/v", "DKNNexus", "/t", "REG_SZ", "/d", &format!("\"{}\" --background", exe.display()), "/f"]).status().map_err(|error| error.to_string())?;
    } else {
        let mut command = Command::new("reg");
        configure_hidden_child(&mut command);
        let _ = command.args(["delete", key, "/v", "DKNNexus", "/f"]).status();
    }
    Ok(())
}

#[tauri::command]
fn set_global_shortcut(app: tauri::AppHandle, shortcut: String) -> Result<(), String> {
    let next = normalize_shortcut(&shortcut)?;
    let radial = radial::active_shortcut().lock().map_err(|_| "轮盘快捷键状态锁定失败".to_string())?.clone();
    if !radial.is_empty() && radial == next { return Err("主窗口快捷键不能与轮盘快捷键相同。".to_string()); }
    let previous = active_shortcut().lock().map_err(|_| "快捷键状态锁定失败".to_string())?.clone();
    if next == previous { return Ok(()); }
    let window = app.get_webview_window("main").ok_or_else(|| "main window not found".to_string())?;
    let restore_window = window.clone();
    app.global_shortcut().unregister(previous.as_str()).map_err(|error| format!("无法释放旧快捷键：{error}"))?;
    let next_for_handler = next.clone();
    if let Err(error) = app.global_shortcut().on_shortcut(next.as_str(), move |_app, _shortcut, event| {
        if radial::is_shortcut_capture_active() { return; }
        if event.state != ShortcutState::Pressed || !allow_shortcut_trigger() { return; }
        diagnostic_log(format!("shortcut:custom:{next_for_handler}"));
        show_launcher(&window);
    }) {
        let _ = app.global_shortcut().on_shortcut(previous.as_str(), move |_app, _shortcut, event| {
            if radial::is_shortcut_capture_active() { return; }
            if event.state != ShortcutState::Pressed || !allow_shortcut_trigger() { return; }
            diagnostic_log("shortcut:restore_previous");
            show_launcher(&restore_window);
        });
        return Err(format!("快捷键注册失败：{error}"));
    }
    *active_shortcut().lock().map_err(|_| "快捷键状态锁定失败".to_string())? = next.clone();
    diagnostic_log(format!("shortcut:changed value={next}"));
    Ok(())
}

#[tauri::command]
fn configure_radial_shortcut(app: tauri::AppHandle, shortcut: String, enabled: bool) -> Result<(), String> {
    radial::configure(&app, &shortcut, enabled)
}

#[tauri::command]
fn set_shortcut_capture_active(active: bool) {
    radial::set_shortcut_capture_active(active);
}

#[tauri::command]
fn hide_radial_overlay(app: tauri::AppHandle) -> Result<(), String> { radial::hide(&app) }

#[tauri::command]
async fn radial_quick_paste(app: tauri::AppHandle, text: String) -> Result<bool, String> { radial::quick_paste(app, text).await }

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or_else(|| "main window not found".to_string())?;
    // The music window is owned by main, so hiding main hides music with it.
    // Notify through the shared helper so the music WebView stops polling
    // instead of continuing to probe hidden.
    hide_music_window_internal(&app);
    diagnostic_log("window:hide:command");
    window.hide().map_err(|error| {
        diagnostic_log(format!("window:hide:failed error={error}"));
        error.to_string()
    })?;
    diagnostic_log("window:hide:ok source=command");
    Ok(())
}

#[cfg(windows)]
fn set_music_window_owner(main: &WebviewWindow, music: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::{GetLastError, SetLastError, WIN32_ERROR};
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowLongPtrW, SetWindowPos, GWLP_HWNDPARENT, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    };

    let main_hwnd = main.hwnd().map_err(|error| error.to_string())?;
    let music_hwnd = music.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        SetLastError(WIN32_ERROR(0));
        let previous_owner = SetWindowLongPtrW(music_hwnd, GWLP_HWNDPARENT, main_hwnd.0 as isize);
        let error = GetLastError();
        if previous_owner == 0 && error.0 != 0 {
            return Err(format!("SetWindowLongPtrW failed with Win32 error {}", error.0));
        }
        SetWindowPos(
            music_hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        ).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Records the music window's native visibility so a late-mounting frontend can
/// reconcile against the CURRENT state rather than a stale snapshot.
///
/// The event below is edge-triggered, but visibility is level-triggered state.
/// A Tauri `emit` is fire-and-forget: showing or hiding the window before its
/// WebView has registered a listener delivers that transition nowhere, and it
/// is never replayed. Keeping the last applied value here lets the frontend ask
/// for ground truth instead of guessing.
static MUSIC_VISIBLE: AtomicBool = AtomicBool::new(false);

fn notify_music_visibility(music: &WebviewWindow, visible: bool) {
    MUSIC_VISIBLE.store(visible, Ordering::SeqCst);
    if let Err(error) = music.emit("dkn://music-visibility", visible) {
        diagnostic_log(format!("music:visibility_emit_failed visible={visible} error={error}"));
    }
}

/// Reports the music window's real visibility.
///
/// Read directly from the window, with the last notified value only as a
/// fallback, so this answers "is it visible right now" rather than "what did we
/// last tell the frontend".
#[tauri::command]
fn get_music_visibility(app: tauri::AppHandle) -> bool {
    app.get_webview_window("music")
        .and_then(|music| music.is_visible().ok())
        .unwrap_or_else(|| MUSIC_VISIBLE.load(Ordering::SeqCst))
}

/// Hides the music window through the single place that owns the transition.
///
/// Returns whether the window is hidden afterwards. Callers that must hide
/// music (command, main-window hide, close requests) go through here so the
/// visibility event can never be skipped on one path.
fn hide_music_window_internal(app: &tauri::AppHandle) -> bool {
    let Some(music) = app.get_webview_window("music") else { return false; };
    // A no-op hide on an already hidden window still reports success, so guard
    // on the real state to keep the event honest and avoid redundant emits.
    if !music.is_visible().unwrap_or(false) { return true; }
    match music.hide() {
        Ok(()) => {
            notify_music_visibility(&music, false);
            true
        }
        Err(error) => {
            diagnostic_log(format!("music:hide_failed error={error}"));
            false
        }
    }
}

/// Shows the music window and notifies the WebView that it is visible.
fn show_music_window_internal(app: &tauri::AppHandle) -> Result<(), String> {
    let music = app.get_webview_window("music").ok_or_else(|| "music window not found".to_string())?;
    let was_visible = music.is_visible().unwrap_or(false);
    position_music_window(app);
    music.show().map_err(|error| error.to_string())?;
    if !was_visible {
        notify_music_visibility(&music, true);
    }
    music.set_focus().map_err(|error| error.to_string())
}

fn position_music_window(app: &tauri::AppHandle) {
    let (Some(main), Some(music)) = (app.get_webview_window("main"), app.get_webview_window("music")) else { return; };
    let (Ok(main_pos), Ok(main_size), Ok(scale)) = (main.outer_position(), main.outer_size(), main.scale_factor()) else { return; };
    let Ok(music_size) = music.outer_size() else { return; };
    let gap = (12.0 * scale).round() as i32;
    let main_right = main_pos.x.saturating_add(main_size.width.min(i32::MAX as u32) as i32);
    let main_bottom = main_pos.y.saturating_add(main_size.height.min(i32::MAX as u32) as i32);
    let monitor_bounds = main.available_monitors().ok().and_then(|monitors| {
        monitors.iter().filter_map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let right = position.x as i64 + size.width as i64;
            let bottom = position.y as i64 + size.height as i64;
            let overlap_width = (main_right as i64).min(right) - (main_pos.x as i64).max(position.x as i64);
            let overlap_height = (main_bottom as i64).min(bottom) - (main_pos.y as i64).max(position.y as i64);
            let overlap_area = overlap_width.max(0) * overlap_height.max(0);
            (overlap_area > 0).then_some((overlap_area, monitor))
        }).max_by_key(|(overlap_area, _)| *overlap_area).map(|(_, monitor)| {
            let work = monitor.work_area();
            let left = work.position.x;
            let top = work.position.y;
            let right = left.saturating_add(work.size.width.min(i32::MAX as u32) as i32);
            let bottom = top.saturating_add(work.size.height.min(i32::MAX as u32) as i32);
            (left, top, right, bottom)
        })
    }).filter(|(left, top, right, bottom)| right > left && bottom > top)
        .or_else(|| main.current_monitor().ok().flatten().map(|monitor| {
            let work = monitor.work_area();
            (work.position.x, work.position.y,
                work.position.x.saturating_add(work.size.width.min(i32::MAX as u32) as i32),
                work.position.y.saturating_add(work.size.height.min(i32::MAX as u32) as i32))
        }))
        .or_else(|| main.primary_monitor().ok().flatten().map(|monitor| {
            let work = monitor.work_area();
            (work.position.x, work.position.y,
                work.position.x.saturating_add(work.size.width.min(i32::MAX as u32) as i32),
                work.position.y.saturating_add(work.size.height.min(i32::MAX as u32) as i32))
        }));

    let width = music_size.width.min(i32::MAX as u32) as i32;
    let height = music_size.height.min(i32::MAX as u32) as i32;
    let mut x = main_pos.x.saturating_sub(width).saturating_sub(gap);
    let mut y = main_pos.y.saturating_add((main_size.height.min(i32::MAX as u32) as i32 - height) / 2);
    if let Some((left, top, right, bottom)) = monitor_bounds {
        let right_x = main_right.saturating_add(gap);
        if x < left && right_x.saturating_add(width) <= right { x = right_x; }
        x = x.clamp(left, right.saturating_sub(width).max(left));
        y = y.clamp(top, bottom.saturating_sub(height).max(top));
    }
    let _ = music.set_position(tauri::PhysicalPosition::new(x, y));
}

#[tauri::command]
fn toggle_music_window(app: tauri::AppHandle) -> Result<(), String> {
    let music = app.get_webview_window("music").ok_or_else(|| "music window not found".to_string())?;
    if music.is_visible().unwrap_or(false) {
        if hide_music_window_internal(&app) { Ok(()) } else { Err("music window could not be hidden".to_string()) }
    } else {
        show_music_window_internal(&app)
    }
}

#[tauri::command]
fn hide_music_window(app: tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("music").is_none() { return Err("music window not found".to_string()); }
    if hide_music_window_internal(&app) { Ok(()) } else { Err("music window could not be hidden".to_string()) }
}

/// Hides music without touching the main window.
///
/// Used by the main window's frontend fallback path: when the native
/// `hide_main_window` command times out, the frontend hides its own window
/// through the JS window API, which never reaches the Rust helpers. Without
/// this the owned music window would stay visible and keep polling.
#[tauri::command]
fn hide_owned_music_window(app: tauri::AppHandle) -> Result<(), String> {
    if hide_music_window_internal(&app) {
        Ok(())
    } else {
        Err("music window could not be hidden".to_string())
    }
}

static MEDIA_READ_SLOW: AtomicBool = AtomicBool::new(false);
static MEDIA_CONTROL_SLOW: AtomicBool = AtomicBool::new(false);

fn record_media_command_latency(operation: &str, elapsed: Duration, slow_state: &AtomicBool) {
    const SLOW_THRESHOLD: Duration = Duration::from_millis(1500);
    if elapsed >= SLOW_THRESHOLD {
        if !slow_state.swap(true, Ordering::SeqCst) {
            diagnostic_log(format!("media:command_slow operation={operation} elapsed_ms={}", elapsed.as_millis()));
        }
    } else if slow_state.swap(false, Ordering::SeqCst) {
        diagnostic_log(format!("media:command_recovered operation={operation} elapsed_ms={}", elapsed.as_millis()));
    }
}

#[tauri::command]
async fn get_current_media() -> Result<Option<media_session::CurrentMedia>, String> {
    let started = Instant::now();
    let result = tauri::async_runtime::spawn_blocking(media_session::get_current).await;
    record_media_command_latency("read", started.elapsed(), &MEDIA_READ_SLOW);
    result.map_err(|error| format!("Windows media session worker stopped: {error}"))?
}

#[tauri::command]
async fn control_current_media(action: String, position_seconds: Option<f64>) -> Result<bool, String> {
    let started = Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || media_session::control(action, position_seconds)).await;
    record_media_command_latency("control", started.elapsed(), &MEDIA_CONTROL_SLOW);
    result.map_err(|error| format!("Windows media control worker stopped: {error}"))?
}

static AGENT_WINDOW_REQUEST_PENDING: AtomicBool = AtomicBool::new(false);
static AGENT_UI_READY_REPORTED: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentPanelPosition {
    x: i32,
    y: i32,
}

fn arrange_agent_panels(app: &tauri::AppHandle, saved_positions: Option<&HashMap<String, AgentPanelPosition>>, requested_workspace_width: f64, requested_workspace_height: f64) {
    let Ok(Some(monitor)) = app.primary_monitor() else {
        diagnostic_log("agent:layout:primary_monitor_unavailable");
        return;
    };
    let scale = monitor.scale_factor().max(1.0);
    let screen_width = monitor.size().width as f64 / scale;
    let screen_height = monitor.size().height as f64 / scale;
    let workspace_width = requested_workspace_width.min((screen_width - 32.0).max(720.0)).max(720.0);
    let panel_height = requested_workspace_height.min((screen_height - 52.0).max(560.0)).max(560.0);
    let origin = monitor.position();
    let y = origin.y + (((screen_height - panel_height) / 2.0).max(0.0) * scale).round() as i32;
    let x = origin.x + (((screen_width - workspace_width) / 2.0).max(0.0) * scale).round() as i32;
    let origin_y = origin.y;
    let max_y = origin.y + monitor.size().height as i32;
    let origin_x = origin.x;
    let max_x = origin.x + monitor.size().width as i32;
    if let Some(window) = app.get_webview_window("agent") {
            let _ = window.set_size(tauri::LogicalSize::new(workspace_width, panel_height));
            let physical_width = (workspace_width * scale).round() as i32;
            let physical_height = (panel_height * scale).round() as i32;
            let fallback = (x, y);
            let requested = saved_positions.and_then(|positions| positions.get("agent")).map(|position| (position.x, position.y)).unwrap_or(fallback);
            let bounded_x = requested.0.clamp(origin_x, (max_x - physical_width).max(origin_x));
            let bounded_y = requested.1.clamp(origin_y, (max_y - physical_height).max(origin_y));
            if let Err(error) = window.set_position(tauri::PhysicalPosition::new(bounded_x, bounded_y)) {
                diagnostic_log(format!("agent:layout:position_failed error={error}"));
            }
    }
    diagnostic_log(format!("agent:layout:arranged single_window workspace_width={workspace_width:.0}"));
}

fn hide_agent_panels(app: &tauri::AppHandle) {
    for label in ["agent"] {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(error) = window.hide() {
                diagnostic_log(format!("agent:layout:hide_failed label={label} error={error}"));
            }
        }
    }
    diagnostic_log("agent:layout:hidden_all");
}

fn set_agent_window_visibility(app: &tauri::AppHandle, reveal: bool, focus: bool) {
    let group_active = reveal || app.get_webview_window("agent").and_then(|window| window.is_visible().ok()).unwrap_or(false);
    for label in ["agent"] {
        let Some(window) = app.get_webview_window(label) else { continue; };
        let should_show = group_active;
        let was_visible = window.is_visible().unwrap_or(false);
        if should_show {
            if !was_visible {
                if let Err(error) = window.show() { diagnostic_log(format!("window:agent:show_failed label={label} error={error}")); }
                let _ = window.emit("dkn://agent-open", ());
            }
            if window.is_minimized().unwrap_or(false) {
                if let Err(error) = window.unminimize() { diagnostic_log(format!("window:agent:unminimize_failed label={label} error={error}")); }
            }
        } else if was_visible {
            if let Err(error) = window.hide() { diagnostic_log(format!("window:agent:hide_failed label={label} error={error}")); }
        }
    }
    if focus {
        if let Some(window) = app.get_webview_window("agent") {
            if let Err(error) = window.set_focus() { diagnostic_log(format!("window:agent:focus_failed error={error}")); }
        }
    }
}

fn request_agent_panels(app: tauri::AppHandle, saved_positions: Option<HashMap<String, AgentPanelPosition>>, workspace_width: f64, workspace_height: f64) -> Result<(), String> {
    diagnostic_log("window:agent:request_received");
    if AGENT_WINDOW_REQUEST_PENDING.swap(true, Ordering::AcqRel) {
        diagnostic_log("window:agent:request_coalesced");
        return Ok(());
    }
    let app_for_main_thread = app.clone();
    let schedule_result = app.run_on_main_thread(move || {
        diagnostic_log("window:agent:main_thread_begin");
        arrange_agent_panels(&app_for_main_thread, saved_positions.as_ref(), workspace_width, workspace_height);
        set_agent_window_visibility(&app_for_main_thread, true, true);
        diagnostic_log("window:agent:shown single_window");
        AGENT_WINDOW_REQUEST_PENDING.store(false, Ordering::Release);
    });
    schedule_result.map_err(|error| {
        AGENT_WINDOW_REQUEST_PENDING.store(false, Ordering::Release);
        diagnostic_log(format!("window:agent:schedule_failed error={error}"));
        error.to_string()
    })?;
    diagnostic_log("window:agent:show_request_queued");
    Ok(())
}

#[tauri::command]
async fn open_agent_window(
    app: tauri::AppHandle,
    saved_positions: Option<HashMap<String, AgentPanelPosition>>,
    window_mode: Option<String>,
    workspace_width: Option<f64>,
    workspace_height: Option<f64>,
) -> Result<(), String> {
    let _ = window_mode;
    request_agent_panels(app, saved_positions, workspace_width.unwrap_or(1600.0), workspace_height.unwrap_or(900.0))
}

#[tauri::command]
async fn configure_agent_window_mode(
    app: tauri::AppHandle,
    saved_positions: Option<HashMap<String, AgentPanelPosition>>,
    window_mode: String,
    workspace_width: f64,
    workspace_height: f64,
) -> Result<(), String> {
    let _ = window_mode;
    let app_for_main_thread = app.clone();
    app.run_on_main_thread(move || {
        arrange_agent_panels(&app_for_main_thread, saved_positions.as_ref(), workspace_width, workspace_height);
        set_agent_window_visibility(&app_for_main_thread, false, false);
    }).map_err(|error| error.to_string())
}

#[tauri::command]
async fn hide_agent_window(app: tauri::AppHandle) -> Result<(), String> {
    diagnostic_log("window:agent:hide_group_requested");
    let app_for_main_thread = app.clone();
    app.run_on_main_thread(move || hide_agent_panels(&app_for_main_thread))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn agent_window_ui_ready() {
    if !AGENT_UI_READY_REPORTED.swap(true, Ordering::AcqRel) {
        diagnostic_log("window:agent:webview_ui_ready");
    }
}

#[tauri::command]
fn open_main_settings(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or_else(|| "main window not found".to_string())?;
    show_settings(&window);
    Ok(())
}

#[tauri::command]
fn open_main_audio_settings(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or_else(|| "main window not found".to_string())?;
    show_main_window(&window);
    let _ = window.emit("dkn://settings-audio", ());
    Ok(())
}

fn show_main_window(window: &WebviewWindow) {
    if let Err(error) = window.show() {
        diagnostic_log(format!("window:show:failed error={error}"));
        return;
    }
    if let Err(error) = window.unminimize() {
        diagnostic_log(format!("window:unminimize:failed error={error}"));
    }
    if let Err(error) = window.set_focus() {
        diagnostic_log(format!("window:focus:failed error={error}"));
    }
    if let Err(error) = window.eval("document.querySelector('input')?.focus()") {
        diagnostic_log(format!("window:input_focus:failed error={error}"));
    }
    diagnostic_log(format!("window:show:complete visible={:?} minimized={:?}", window.is_visible(), window.is_minimized()));
}

fn schedule_startup_window_visibility_check(window: WebviewWindow) {
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(750));
        let callback_window = window.clone();
        if let Err(error) = window.run_on_main_thread(move || {
            let visible = callback_window.is_visible().unwrap_or(false);
            let minimized = callback_window.is_minimized().unwrap_or(false);
            diagnostic_log(format!("startup:window_check visible={visible} minimized={minimized}"));
            if !visible || minimized {
                show_main_window(&callback_window);
            }
        }) {
            diagnostic_log(format!("startup:window_check_schedule_failed error={error}"));
        }
    });
}

fn show_launcher(window: &WebviewWindow) {
    let was_visible = window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
    show_main_window(window);
    let _ = window.emit(if was_visible { "dkn://focus" } else { "dkn://open" }, ());
}

fn show_settings(window: &WebviewWindow) {
    show_main_window(window);
    let _ = window.emit("dkn://settings", ());
}

fn hide_after_close_request(window: &tauri::Window, label: String) {
    match window.hide() {
        Ok(()) => diagnostic_log(format!("window:close-hide:ok label={label}")),
        Err(error) => {
            diagnostic_log(format!("window:close-hide:failed label={label} error={error}"));
            let retry_window = window.clone();
            let retry_label = label.clone();
            if let Err(schedule_error) = window.run_on_main_thread(move || {
                if let Err(error) = retry_window.hide() {
                    diagnostic_log(format!("window:close-hide:retry_failed label={retry_label} error={error}"));
                } else {
                    diagnostic_log(format!("window:close-hide:retry_ok label={retry_label}"));
                }
            }) {
                diagnostic_log(format!("window:close-hide:retry_schedule_failed label={label} error={schedule_error}"));
            }
        }
    }
}

pub fn run() {
    initialize_diagnostic_logger();
    let background = env::args().any(|argument| argument.eq_ignore_ascii_case("--background"));
    diagnostic_log(format!("startup:run_enter version={} executable={} background={background}",
        env!("CARGO_PKG_VERSION"), env::current_exe().map(|path| path.display().to_string()).unwrap_or_default()));
    let previous_panic_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        diagnostic_log(format!("startup:panic {info}"));
        previous_panic_hook(info);
    }));

    #[cfg(windows)]
    if !single_instance::ensure() { return; }

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![list_applications, launch_application, pick_application_file, run_nexus_mode, set_launch_at_startup, set_global_shortcut, configure_radial_shortcut, set_shortcut_capture_active, hide_radial_overlay, radial_quick_paste, hide_main_window, toggle_music_window, hide_music_window, hide_owned_music_window, get_music_visibility, get_current_media, control_current_media, open_agent_window, configure_agent_window_mode, hide_agent_window, agent_window_ui_ready, open_main_settings, open_main_audio_settings, save_note, set_clipboard_text, save_secret, load_secret, delete_secret, agent_workflow::pick_project_directory, agent_workflow::pick_agent_resource_file, agent_workflow::copy_agent_image_to_project, agent_workflow::get_agent_provider_info, agent_workflow::route_agent_project, agent_workflow::plan_agent_task, agent_workflow::execute_agent_plan_step, agent_workflow::run_agent_workflow, agent_image::save_agent_image_secret, agent_image::has_agent_image_secret, agent_image::generate_agent_image, agent_image::read_agent_image, agent_image::read_project_image, agent_text::save_agent_text_secret, agent_text::has_agent_text_secret, agent_text::delete_agent_text_secret, agent_text::execute_agent_text_step, local_asr::transcribe_local_audio])
        .setup(move |app| {
            diagnostic_log(format!("startup:setup_enter background={background}"));
            let main_window = app.get_webview_window("main").unwrap_or_else(|| {
                diagnostic_log("startup:main_window_missing");
                panic!("Tauri main window was not created")
            });
            #[cfg(windows)]
            if let Err(error) = main_window.hwnd() {
                let reason = last_webview_creation_error().lock().unwrap_or_else(|e| e.into_inner())
                    .clone().unwrap_or_else(|| error.to_string());
                diagnostic_log(format!("startup:failed native_main_window error={reason}"));
                report_startup_failure(&reason);
                single_instance::release_recovery_start();
                app.handle().exit(1);
                return Ok(());
            }
            #[cfg(windows)]
            if let Some(music_window) = app.get_webview_window("music") {
                match set_music_window_owner(&main_window, &music_window) {
                    Ok(()) => diagnostic_log("music:window_owner=main"),
                    Err(error) => diagnostic_log(format!("music:window_owner_failed error={error}")),
                }
            }
            #[cfg(windows)]
            clipboard_listener::start(app.handle().clone());
            let open_item = MenuItem::with_id(app, "open", "打开 DKN Nexus", true, None::<&str>)?;
            let agent_item = MenuItem::with_id(app, "agent", "打开 Agent 工作台", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &agent_item, &settings_item, &quit_item])?;
            let window_for_tray = main_window.clone();
            TrayIconBuilder::with_id("dkn-nexus-tray")
                .icon(tray_icon_image())
                .tooltip("DKN Nexus")
                .menu(&menu)
                // Windows shows the tray menu on right click by default. Keep
                // left click from opening it so the native behavior is explicit.
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|_tray, event| {
                    if let TrayIconEvent::Click { button, button_state, .. } = event {
                        diagnostic_log(format!("tray:event click button={button:?} state={button_state:?}"));
                    }
                })
                .on_menu_event(move |app, event| {
                match event.id().as_ref() {
                    "open" => show_launcher(&window_for_tray),
                    "agent" => { let _ = window_for_tray.emit("dkn://open-agent", ()); }
                    "settings" => show_settings(&window_for_tray),
                    "quit" => {
                        diagnostic_log("tray:quit:request");
                        // Let Tauri clear the native tray icon before the
                        // process exits. `std::process::exit` bypasses that
                        // cleanup and leaves ghost icons in Explorer.
                        app.exit(0);
                    }
                    _ => {}
                }
            }).build(app)?;
            diagnostic_log("tray:created id=dkn-nexus-tray");

            let shortcut_window = main_window.clone();
            let shortcut_result = app.global_shortcut().on_shortcut("ALT+SPACE", move |_app, _shortcut, event| {
                if radial::is_shortcut_capture_active() { return; }
                if event.state != ShortcutState::Pressed || !allow_shortcut_trigger() { return; }
                diagnostic_log("shortcut:alt-space");
                show_launcher(&shortcut_window);
            });
            if shortcut_result.is_ok() { *active_shortcut().lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = "ALT+SPACE".to_string(); }
            if let Err(error) = shortcut_result { diagnostic_log(format!("shortcut:register_failed error={error}")); }
            if let Err(error) = radial::configure(app.handle(), "ALT+SHIFT+SPACE", true) {
                diagnostic_log(format!("radial:shortcut_register_failed error={error}"));
            }
            let background = env::args().any(|argument| argument.eq_ignore_ascii_case("--background"));
            diagnostic_log(format!("startup:ready background={background}"));
            if background {
                if let Err(error) = main_window.hide() { diagnostic_log(format!("window:background-hide:failed error={error}")); }
            } else {
                show_main_window(&main_window);
                schedule_startup_window_visibility_check(main_window.clone());
            }
            #[cfg(windows)]
            single_instance::release_recovery_start();
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                if let Some(music) = window.app_handle().get_webview_window("music") {
                    if music.is_visible().unwrap_or(false) { position_music_window(window.app_handle()); }
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "main" {
                    diagnostic_log("window:close-requested -> hide" );
                    hide_music_window_internal(window.app_handle());
                    hide_after_close_request(window, "main".to_string());
                } else if window.label() == "music" {
                    // The music window's own X must also stop its poll loop,
                    // otherwise the hidden WebView keeps probing media.
                    hide_music_window_internal(window.app_handle());
                } else if matches!(window.label(), "agent" | "agent-projects" | "agent-tools") {
                    diagnostic_log(format!("window:close-requested -> hide-agent-group label={}", window.label()));
                    hide_agent_panels(window.app_handle());
                } else {
                    hide_after_close_request(window, window.label().to_string());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building DKN Nexus")
        .run(|_app, event| match event {
            tauri::RunEvent::ExitRequested { code, .. } => {
                diagnostic_log(format!("app:exit_requested code={code:?}"));
            }
            tauri::RunEvent::Exit => diagnostic_log("app:exit"),
            _ => {}
        });
}
