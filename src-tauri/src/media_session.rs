use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentMedia {
    title: String,
    artist: String,
    album: String,
    app_id: String,
    cover_data_url: Option<String>,
    playing: bool,
    position: f64,
    duration: f64,
    can_seek: bool,
    can_next: bool,
    can_previous: bool,
    can_toggle: bool,
    metadata_only: bool,
    local_control: bool,
}

#[cfg(windows)]
mod windows_media {
    use super::CurrentMedia;
    use crate::diagnostic_log;
    use base64::Engine;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::core::BOOL;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT,
        KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE,
        VK_MEDIA_PREV_TRACK,
    };
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible};
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };
    use windows::Storage::Streams::DataReader;
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

    const TICKS_PER_SECOND: f64 = 10_000_000.0;
    const MAX_COVER_BYTES: u64 = 4 * 1024 * 1024;
    const WINDOWS_EPOCH_TICKS: i64 = 116_444_736_000_000_000;

    fn window_text(hwnd: HWND) -> String {
        let length = unsafe { GetWindowTextLengthW(hwnd) }.max(0) as usize;
        if length == 0 { return String::new(); }
        let mut buffer = vec![0u16; length + 1];
        let written = unsafe { GetWindowTextW(hwnd, &mut buffer) }.max(0) as usize;
        String::from_utf16_lossy(&buffer[..written.min(buffer.len())]).trim().to_string()
    }

    fn is_cloudmusic_process_name(name: &str) -> bool {
        name.eq_ignore_ascii_case("cloudmusic.exe")
    }

    fn process_executable_names() -> windows::core::Result<HashMap<u32, String>> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)? };
        let mut processes = HashMap::new();
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
            loop {
                let name_length = entry.szExeFile.iter().position(|unit| *unit == 0).unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_length]);
                processes.insert(entry.th32ProcessID, name);
                if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() { break; }
            }
        }
        let _ = unsafe { CloseHandle(snapshot) };
        Ok(processes)
    }

    fn parse_netease_track_title(raw_title: &str) -> Option<(String, String)> {
        let raw_title = raw_title.trim();
        let normalized = raw_title.to_ascii_lowercase();
        if raw_title.is_empty()
            || normalized.contains("mediaplayer")
            || ["网易云音乐", "cloudmusic", "netease cloud music"].iter().any(|generic| raw_title.eq_ignore_ascii_case(generic))
        {
            return None;
        }

        let (title, artist) = raw_title.rsplit_once(" - ")?;
        let title = title.trim();
        let artist = artist.trim();
        if title.is_empty() || artist.is_empty() { return None; }
        Some((title.to_string(), artist.to_string()))
    }

    #[derive(Default)]
    struct CloudMusicWindowScan {
        cloudmusic_processes: std::collections::HashSet<u32>,
        top_level_windows: usize,
        cloudmusic_windows: usize,
        titles: Vec<(bool, String)>,
        window_handles: Vec<(bool, HWND)>,
    }

    unsafe extern "system" fn collect_cloudmusic_window(hwnd: HWND, data: LPARAM) -> BOOL {
        if data.0 == 0 { return BOOL(1); }

        let scan = unsafe { &mut *(data.0 as *mut CloudMusicWindowScan) };
        scan.top_level_windows += 1;
        let mut process_id = 0;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id as *mut u32)); }
        if process_id == 0 || !scan.cloudmusic_processes.contains(&process_id) { return BOOL(1); }

        scan.cloudmusic_windows += 1;
        let visible = unsafe { IsWindowVisible(hwnd) }.as_bool();
        scan.titles.push((visible, window_text(hwnd)));
        scan.window_handles.push((visible, hwnd));
        BOOL(1)
    }

    fn netease_window_media() -> Option<CurrentMedia> {
        static LAST_SNAPSHOT_ERROR: OnceLock<Mutex<Option<i32>>> = OnceLock::new();
        let processes = match process_executable_names() {
            Ok(processes) => {
                if let Ok(mut last_error) = LAST_SNAPSHOT_ERROR.get_or_init(|| Mutex::new(None)).lock() {
                    if last_error.take().is_some() { diagnostic_log("media:netease_process_snapshot=recovered"); }
                }
                processes
            }
            Err(error) => {
                let code = error.code().0;
                if let Ok(mut last_error) = LAST_SNAPSHOT_ERROR.get_or_init(|| Mutex::new(None)).lock() {
                    if *last_error != Some(code) {
                        diagnostic_log(format!("media:netease_process_snapshot_failed hresult={code:#x}"));
                        *last_error = Some(code);
                    }
                }
                return None;
            }
        };
        let cloudmusic_processes = processes.iter()
            .filter_map(|(process_id, name)| is_cloudmusic_process_name(name).then_some(*process_id))
            .collect::<std::collections::HashSet<_>>();
        let mut scan = CloudMusicWindowScan { cloudmusic_processes, ..CloudMusicWindowScan::default() };
        let data = LPARAM((&mut scan as *mut CloudMusicWindowScan) as isize);
        unsafe { EnumWindows(Some(collect_cloudmusic_window), data).ok()?; }

        let matching_titles = scan.titles.iter().filter(|(_, title)| parse_netease_track_title(title).is_some()).count();
        let visible_matching_titles = scan.titles.iter().filter(|(visible, title)| *visible && parse_netease_track_title(title).is_some()).count();
        static LAST_WINDOW_SCAN: OnceLock<Mutex<Option<(usize, usize, usize, usize, usize)>>> = OnceLock::new();
        let scan_state = (
            scan.cloudmusic_processes.len(),
            scan.top_level_windows,
            scan.cloudmusic_windows,
            matching_titles,
            visible_matching_titles,
        );
        if let Ok(mut last) = LAST_WINDOW_SCAN.get_or_init(|| Mutex::new(None)).lock() {
            if *last != Some(scan_state) {
                diagnostic_log(format!(
                    "media:netease_window_scan cloudmusic_processes={} top_level={} cloudmusic_windows={} valid_titles={} visible_valid_titles={}",
                    scan_state.0, scan_state.1, scan_state.2, scan_state.3, scan_state.4,
                ));
                *last = Some(scan_state);
            }
        }

        // EnumWindows walks top-level windows in z-order. Prefer a visible,
        // well-formed player title; only fall back to a hidden window if needed.
        let selected = scan.titles.iter().find(|(visible, title)| *visible && parse_netease_track_title(title).is_some())
            .or_else(|| scan.titles.iter().find(|(_, title)| parse_netease_track_title(title).is_some()))?;
        let (title, artist) = parse_netease_track_title(&selected.1)?;

        Some(CurrentMedia {
            title,
            artist,
            album: String::new(),
            app_id: "网易云音乐".to_string(),
            cover_data_url: None,
            playing: false,
            position: 0.0,
            duration: 0.0,
            can_seek: false,
            can_next: scan.cloudmusic_windows > 0,
            can_previous: scan.cloudmusic_windows > 0,
            can_toggle: scan.cloudmusic_windows > 0,
            metadata_only: true,
            local_control: false,
        })
    }

    fn attach_local_control(mut media: CurrentMedia) -> CurrentMedia {
        if has_foreign_playing_session() == Some(true) { return media; }
        let Some(snapshot) = crate::netease_cdp::read_snapshot() else { return media; };
        // A missing DOM field means "unknown", not paused or zero. Keep the
        // Windows session's authoritative playback state and timeline unless
        // the local page actually supplied usable values.
        if let Some(playing) = snapshot.playing { media.playing = playing; }
        if snapshot.duration.is_finite() && snapshot.duration > 0.0 {
            media.duration = snapshot.duration;
            media.position = snapshot.position.clamp(0.0, snapshot.duration);
        }
        media.can_seek |= snapshot.can_seek && snapshot.duration.is_finite() && snapshot.duration > 0.0;
        media.can_toggle |= snapshot.can_toggle;
        media.can_next |= snapshot.can_next;
        media.can_previous |= snapshot.can_previous;
        media.local_control |= snapshot.can_toggle || snapshot.can_next || snapshot.can_previous || snapshot.can_seek;
        media
    }

    fn netease_fallback() -> Option<CurrentMedia> {
        netease_window_media().map(attach_local_control)
    }

    fn try_netease_local_control(action: &str, position_seconds: Option<f64>) -> Option<bool> {
        if !matches!(action, "toggle" | "next" | "previous" | "seek")
            || netease_window_media().is_none()
            || has_foreign_playing_session() == Some(true)
        {
            return None;
        }
        match crate::netease_cdp::control(action, position_seconds) {
            Ok(true) => {
                crate::diagnostic_log(format!("media:netease_local_control action={action} dispatched=true"));
                Some(true)
            }
            Ok(false) => {
                crate::diagnostic_log(format!("media:netease_local_control action={action} dispatched=false reason=matching_control_not_found"));
                None
            }
            Err(error) => {
                crate::diagnostic_log(format!("media:netease_local_control action={action} failed={error}"));
                None
            }
        }
    }

    fn current_session() -> windows::core::Result<(GlobalSystemMediaTransportControlsSessionManager, Option<GlobalSystemMediaTransportControlsSession>)> {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.get()?;
        let mut netease_session = None;
        let mut playing_session = None;
        if let Ok(sessions) = manager.GetSessions() {
            if let Ok(count) = sessions.Size() {
                for index in 0..count {
                    let Ok(session) = sessions.GetAt(index) else { continue; };
                    let source = session.SourceAppUserModelId().map(|value| value.to_string()).unwrap_or_default();
                    let is_playing = session.GetPlaybackInfo().ok()
                        .and_then(|info| info.PlaybackStatus().ok())
                        .is_some_and(|status| status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing);

                    // Keep metadata and controls bound to the same player,
                    // even when another player is currently active.
                    if is_netease_source(&source) {
                        if is_playing { return Ok((manager, Some(session))); }
                        if netease_session.is_none() { netease_session = Some(session); }
                    } else if is_playing && playing_session.is_none() {
                        playing_session = Some(session);
                    }
                }
            }
        }
        if let Some(session) = netease_session { return Ok((manager, Some(session))); }
        if let Some(session) = playing_session { return Ok((manager, Some(session))); }
        if let Ok(session) = manager.GetCurrentSession() { return Ok((manager, Some(session))); }
        Ok((manager, None))
    }

    fn media_key_for_action(action: &str) -> Option<VIRTUAL_KEY> {
        match action {
            "toggle" => Some(VK_MEDIA_PLAY_PAUSE),
            "next" => Some(VK_MEDIA_NEXT_TRACK),
            "previous" => Some(VK_MEDIA_PREV_TRACK),
            // Windows exposes no standard media key for seeking to a position.
            "seek" => None,
            _ => None,
        }
    }

    fn has_foreign_playing_session() -> Option<bool> {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().ok()?.get().ok()?;
        let sessions = manager.GetSessions().ok()?;
        let count = sessions.Size().ok()?;
        for index in 0..count {
            let session = sessions.GetAt(index).ok()?;
            let source = session.SourceAppUserModelId().map(|value| value.to_string()).unwrap_or_default();
            let playing = session.GetPlaybackInfo().ok()
                .and_then(|info| info.PlaybackStatus().ok())
                .is_some_and(|status| status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing);
            if playing && !is_netease_source(&source) { return Some(true); }
        }
        Some(false)
    }

    fn send_netease_media_key(action: &str) -> windows::core::Result<bool> {
        let Some(key) = media_key_for_action(action) else { return Ok(false); };
        // Only inject a system media key when a song-title window proves the
        // NetEase player is present, and never redirect it over another active
        // GSMTC player. This is a fallback, not an absolute delivery receipt.
        if netease_window_media().is_none() { return Ok(false); }
        if has_foreign_playing_session() == Some(true) {
            diagnostic_log(format!("media:netease_media_key_skipped action={action} reason=other_player_active"));
            return Ok(false);
        }

        let input_for = |flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let inputs = [input_for(KEYBD_EVENT_FLAGS(0)), input_for(KEYEVENTF_KEYUP)];
        let inserted = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        diagnostic_log(format!("media:netease_media_key action={action} inserted={inserted}"));
        Ok(inserted == inputs.len() as u32)
    }

    fn is_netease_source(source: &str) -> bool {
        let source = source.to_ascii_lowercase();
        source.contains("cloudmusic") || source.contains("netease")
    }

    fn log_session_capabilities(is_netease: bool, playing: bool, can_toggle: bool, can_next: bool, can_previous: bool, can_seek: bool) {
        static LAST_STATE: OnceLock<Mutex<Option<(bool, bool, bool, bool, bool, bool)>>> = OnceLock::new();
        let state = (is_netease, playing, can_toggle, can_next, can_previous, can_seek);
        if let Ok(mut last) = LAST_STATE.get_or_init(|| Mutex::new(None)).lock() {
            if *last != Some(state) {
                diagnostic_log(format!(
                    "media:session_controls source={} playing={} toggle={} next={} previous={} seek={}",
                    if is_netease { "netease" } else { "other" }, playing, can_toggle, can_next, can_previous, can_seek,
                ));
                *last = Some(state);
            }
        }
    }

    fn read_cover(properties: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> Option<String> {
        let thumbnail = properties.Thumbnail().ok()?;
        let stream = thumbnail.OpenReadAsync().ok()?.get().ok()?;
        let size = stream.Size().ok()?.min(MAX_COVER_BYTES) as u32;
        if size == 0 { return None; }
        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
        reader.LoadAsync(size).ok()?.get().ok()?;
        let available = reader.UnconsumedBufferLength().ok()?.min(size);
        let mut bytes = vec![0u8; available as usize];
        reader.ReadBytes(&mut bytes).ok()?;
        let mime = stream.ContentType().ok().map(|value| value.to_string()).filter(|value| value.starts_with("image/")).unwrap_or_else(|| "image/jpeg".to_string());
        Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }

    pub fn get_current() -> windows::core::Result<Option<CurrentMedia>> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED)?; }
        let result = (|| {
            let session = match current_session() {
                Ok((_manager, Some(session))) => session,
                Ok((_manager, None)) => return Ok(netease_fallback()),
                Err(error) => return match netease_fallback() {
                    Some(media) => Ok(Some(media)),
                    None => Err(error),
                },
            };
            let source = session.SourceAppUserModelId().map(|value| value.to_string()).unwrap_or_default();
            let is_netease_session = is_netease_source(&source);
            let playback = match session.GetPlaybackInfo() {
                Ok(playback) => playback,
                Err(error) => return match netease_fallback() {
                    Some(media) => Ok(Some(media)),
                    None => Err(error),
                },
            };
            let is_playing = playback.PlaybackStatus().map(|value| value == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing).unwrap_or(false);

            // GSMTC can return a stale paused session from another player.
            // Keep active sessions authoritative, but let a valid NetEase
            // window title fill the gap when no unrelated player is active.
            if !is_netease_session && !is_playing {
                return Ok(netease_fallback());
            }

            let properties = match session.TryGetMediaPropertiesAsync().and_then(|operation| operation.get()) {
                Ok(properties) => properties,
                Err(error) => return match netease_fallback() {
                    Some(media) => Ok(Some(media)),
                    None => Err(error),
                },
            };
            let timeline = session.GetTimelineProperties()?;
            let controls = playback.Controls()?;
            let can_toggle = controls.IsPlayPauseToggleEnabled().unwrap_or(false)
                || if is_playing { controls.IsPauseEnabled().unwrap_or(false) } else { controls.IsPlayEnabled().unwrap_or(false) };
            let can_next = controls.IsNextEnabled().unwrap_or(false);
            let can_previous = controls.IsPreviousEnabled().unwrap_or(false);
            let can_seek = controls.IsPlaybackPositionEnabled().unwrap_or(false);
            log_session_capabilities(is_netease_session, is_playing, can_toggle, can_next, can_previous, can_seek);
            let start = timeline.StartTime().map(|value| value.Duration).unwrap_or(0);
            let end = timeline.EndTime().map(|value| value.Duration).unwrap_or(start);
            let is_playing = playback.PlaybackStatus().map(|value| value == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing).unwrap_or(false);
            let reported_position = timeline.Position().map(|value| value.Duration).unwrap_or(start);
            let updated_at = timeline.LastUpdatedTime().map(|value| value.UniversalTime).unwrap_or(WINDOWS_EPOCH_TICKS);
            let now_ticks = SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_nanos().min(i64::MAX as u128) as i64 / 100 + WINDOWS_EPOCH_TICKS).unwrap_or(WINDOWS_EPOCH_TICKS);
            let elapsed = if is_playing { now_ticks.saturating_sub(updated_at).max(0) } else { 0 };
            let position = reported_position.saturating_add(elapsed).min(end).saturating_sub(start).max(0) as f64 / TICKS_PER_SECOND;
            let duration = end.saturating_sub(start).max(0) as f64 / TICKS_PER_SECOND;
            let cover_key = format!("{}\u{1f}{}\u{1f}{}\u{1f}{}", source, properties.Title().map(|value| value.to_string()).unwrap_or_default(), properties.Artist().map(|value| value.to_string()).unwrap_or_default(), properties.AlbumTitle().map(|value| value.to_string()).unwrap_or_default());
            static COVER_CACHE: OnceLock<Mutex<(String, Option<String>)>> = OnceLock::new();
            let cache = COVER_CACHE.get_or_init(|| Mutex::new((String::new(), None)));
            let cached_cover = cache.lock().ok().and_then(|value| (value.0 == cover_key).then(|| value.1.clone()));
            let cover = cached_cover.unwrap_or_else(|| {
                let cover = read_cover(&properties);
                if let Ok(mut value) = cache.lock() { *value = (cover_key, cover.clone()); }
                cover
            });
            let media = CurrentMedia {
                title: properties.Title().map(|value| value.to_string()).unwrap_or_default(),
                artist: properties.Artist().or_else(|_| properties.AlbumArtist()).map(|value| value.to_string()).unwrap_or_default(),
                album: properties.AlbumTitle().map(|value| value.to_string()).unwrap_or_default(),
                app_id: source,
                cover_data_url: cover,
                playing: is_playing,
                position,
                duration,
                can_seek,
                can_next,
                can_previous,
                can_toggle,
                metadata_only: false,
                local_control: false,
            };
            Ok(Some(if is_netease_session { attach_local_control(media) } else { media }))
        })();
        unsafe { RoUninitialize(); }
        result
    }

    #[cfg(test)]
    mod tests {
        use super::{media_key_for_action, parse_netease_track_title};
        use std::path::Path;

        #[test]
        fn parses_song_and_artist_from_player_title() {
            assert_eq!(parse_netease_track_title("你好吗 - 周杰伦"), Some(("你好吗".into(), "周杰伦".into())));
        }

        #[test]
        fn ignores_generic_or_unstructured_window_titles() {
            assert_eq!(parse_netease_track_title("网易云音乐"), None);
            assert_eq!(parse_netease_track_title("欢迎使用网易云音乐"), None);
            assert_eq!(parse_netease_track_title("只是一个标题"), None);
            assert_eq!(parse_netease_track_title("MediaPlayer - CloudMusic"), None);
            assert_eq!(parse_netease_track_title(" - 周杰伦"), None);
        }

        #[test]
        fn process_snapshot_contains_current_process() {
            let processes = super::process_executable_names().expect("process snapshot should be queryable");
            let current_id = std::process::id();
            let observed = processes.get(&current_id).expect("snapshot should include current process");
            let current_executable = std::env::current_exe().expect("test executable path");
            let expected = Path::new(&current_executable).file_name().unwrap().to_string_lossy();
            assert!(observed.eq_ignore_ascii_case(&expected));
        }

        #[test]
        fn matches_netease_process_name_case_insensitively() {
            assert!(super::is_cloudmusic_process_name("cloudmusic.exe"));
            assert!(super::is_cloudmusic_process_name("CloudMusic.EXE"));
            assert!(!super::is_cloudmusic_process_name("cloudmusic-helper.exe"));
        }

        #[test]
        fn recognizes_netease_media_session_ids() {
            assert!(super::is_netease_source("com.netease.cloudmusic"));
            assert!(super::is_netease_source("cloudmusic.exe"));
            assert!(!super::is_netease_source("Microsoft.ZuneMusic"));
        }

        #[test]
        fn maps_transport_actions_to_windows_media_keys_but_not_seek() {
            assert_eq!(media_key_for_action("toggle").map(|key| key.0), Some(0xB3));
            assert_eq!(media_key_for_action("next").map(|key| key.0), Some(0xB0));
            assert_eq!(media_key_for_action("previous").map(|key| key.0), Some(0xB1));
            assert!(media_key_for_action("seek").is_none());
        }
    }

    pub fn control(action: &str, position_seconds: Option<f64>) -> windows::core::Result<bool> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED)?; }
        let result = (|| {
            let (_manager, session) = match current_session() {
                Ok(selection) => selection,
                Err(error) => {
                    if netease_window_media().is_some() {
                        diagnostic_log(format!("media:gsmc_control_unavailable hresult={:#x}; trying_local_channel", error.code().0));
                        if let Some(result) = try_netease_local_control(action, position_seconds) { return Ok(result); }
                        return if action == "seek" { Ok(false) } else { send_netease_media_key(action) };
                    }
                    return Err(error);
                }
            };
            let Some(session) = session else {
                if let Some(result) = try_netease_local_control(action, position_seconds) { return Ok(result); }
                return send_netease_media_key(action);
            };
            let source = session.SourceAppUserModelId().map(|value| value.to_string()).unwrap_or_default();
            let is_playing = session.GetPlaybackInfo().ok()
                .and_then(|info| info.PlaybackStatus().ok())
                .is_some_and(|status| status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing);
            if !is_netease_source(&source) && !is_playing && netease_window_media().is_some() {
                if let Some(result) = try_netease_local_control(action, position_seconds) { return Ok(result); }
                return if action == "seek" { Ok(false) } else { send_netease_media_key(action) };
            }
            let gsm_tc_result = (|| -> windows::core::Result<bool> { match action {
                "toggle" => {
                    let playback = session.GetPlaybackInfo()?;
                    let controls = playback.Controls()?;
                    if controls.IsPlayPauseToggleEnabled().unwrap_or(false) {
                        Ok(session.TryTogglePlayPauseAsync()?.get()?)
                    } else if playback.PlaybackStatus().ok().is_some_and(|status| status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing) {
                        if !controls.IsPauseEnabled().unwrap_or(false) { return Ok(false); }
                        Ok(session.TryPauseAsync()?.get()?)
                    } else {
                        if !controls.IsPlayEnabled().unwrap_or(false) { return Ok(false); }
                        Ok(session.TryPlayAsync()?.get()?)
                    }
                }
                "next" => Ok(session.TrySkipNextAsync()?.get()?),
                "previous" => Ok(session.TrySkipPreviousAsync()?.get()?),
                "seek" => {
                    let timeline = session.GetTimelineProperties()?;
                    let start = timeline.StartTime()?.Duration;
                    let requested = start.saturating_add((position_seconds.unwrap_or(0.0).max(0.0) * TICKS_PER_SECOND) as i64);
                    Ok(session.TryChangePlaybackPositionAsync(requested)?.get()?)
                }
                _ => return Err(windows::core::Error::new(windows::core::HRESULT(0x80070057u32 as i32), "Unsupported media action")),
            }})();
            match gsm_tc_result {
                Ok(true) => Ok(true),
                Ok(false) if is_netease_source(&source) => {
                    if let Some(result) = try_netease_local_control(action, position_seconds) { return Ok(result); }
                    if action == "seek" { Ok(false) } else { send_netease_media_key(action) }
                }
                Ok(false) => Ok(false),
                Err(error) if is_netease_source(&source) => {
                    diagnostic_log(format!("media:gsmc_action_failed action={action} hresult={:#x}; trying_local_channel", error.code().0));
                    if let Some(result) = try_netease_local_control(action, position_seconds) { return Ok(result); }
                    if action == "seek" { Ok(false) } else { send_netease_media_key(action) }
                }
                Err(error) => Err(error),
            }
        })();
        unsafe { RoUninitialize(); }
        result
    }
}

#[cfg(windows)]
pub fn get_current() -> Result<Option<CurrentMedia>, String> {
    windows_media::get_current().map_err(|error| error.to_string())
}

#[cfg(not(windows))]
pub fn get_current() -> Result<Option<CurrentMedia>, String> { Ok(None) }

#[cfg(windows)]
pub fn control(action: String, position_seconds: Option<f64>) -> Result<bool, String> {
    windows_media::control(&action, position_seconds).map_err(|error| error.to_string())
}

#[cfg(not(windows))]
pub fn control(_action: String, _position_seconds: Option<f64>) -> Result<bool, String> { Ok(false) }
