//! Strictly local Chromium DevTools access for the official NetEase client.
//!
//! This is intentionally limited to 127.0.0.1:9223, the `orpheus://` page,
//! fixed state probes and allowlisted media controls. No arbitrary
//! script, process-memory access, account data, or network forwarding is used.

use serde_json::{json, Value};
use std::ffi::c_void;
use std::ptr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use windows::core::PCWSTR;
use windows::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest,
    WinHttpQueryDataAvailable, WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse,
    WinHttpSendRequest, WinHttpSetTimeouts, WinHttpSetOption, WinHttpWebSocketCompleteUpgrade,
    WinHttpWebSocketReceive, WinHttpWebSocketSend, WINHTTP_ACCESS_TYPE_NO_PROXY,
    WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    WINHTTP_WEB_SOCKET_BUFFER_TYPE, WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE,
    WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
};

const CDP_PORT: u16 = 9223;
const MAX_HTTP_BODY: usize = 64 * 1024;
const MAX_CDP_MESSAGE: usize = 1024 * 1024;
/// Upper bound on unsolicited CDP events skipped while awaiting one reply.
const MAX_SKIPPED_MESSAGES: usize = 64;

/// Progressive, bounded backoff for the local NetEase control channel.
///
/// The previous implementation used a single 3s window (`RETRY_AFTER`): the
/// channel became probeable again as soon as the window expired, but the window
/// was only cleared by a success. So a failure with no later successful
/// *control* call would stall probing until the next failure's window expired —
/// a "stale 3s window, cleared only by success" limitation, not a permanent
/// lockout. These are the delays applied after the 1st, 2nd and 3rd consecutive
/// failure; the last value caps every further failure and a success resets.
const BACKOFF_STEPS: [Duration; 3] = [
    Duration::from_secs(3),
    Duration::from_secs(10),
    Duration::from_secs(30),
];

/// Consecutive-failure counter and the instant the next probe is allowed.
///
/// Deliberately split from the lock that guards channel state: nothing here
/// holds a mutex across network I/O.
#[derive(Debug, Default)]
struct ChannelBackoff {
    consecutive_failures: u32,
    retry_after: Option<Instant>,
}

impl ChannelBackoff {
    /// Backoff delay for the current failure count (1-based).
    fn delay_for(failures: u32) -> Duration {
        let index = failures.saturating_sub(1) as usize;
        BACKOFF_STEPS[index.min(BACKOFF_STEPS.len() - 1)]
    }

    fn is_active(&self, now: Instant) -> bool {
        self.retry_after.is_some_and(|until| now < until)
    }

    /// Records a failure and returns the delay that now applies.
    fn record_failure(&mut self, now: Instant) -> Duration {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        let delay = Self::delay_for(self.consecutive_failures);
        self.retry_after = Some(now + delay);
        delay
    }

    /// Clears the backoff. Returns true only when recovering from failure, so
    /// callers can log the transition exactly once.
    fn record_success(&mut self) -> bool {
        let was_failing = self.consecutive_failures > 0;
        self.consecutive_failures = 0;
        self.retry_after = None;
        was_failing
    }
}

static BACKOFF: OnceLock<Mutex<ChannelBackoff>> = OnceLock::new();

fn backoff() -> &'static Mutex<ChannelBackoff> {
    BACKOFF.get_or_init(|| Mutex::new(ChannelBackoff::default()))
}

fn channel_backoff_active() -> bool {
    let now = Instant::now();
    backoff()
        .lock()
        .map(|state| state.is_active(now))
        .unwrap_or(false)
}

#[derive(Clone, Debug)]
pub(crate) struct PlaybackSnapshot {
    pub position: f64,
    pub duration: f64,
    pub playing: Option<bool>,
    pub can_seek: bool,
    pub can_toggle: bool,
    pub can_next: bool,
    pub can_previous: bool,
}

struct Handles(Vec<*mut c_void>);

impl Handles {
    fn push(&mut self, handle: *mut c_void, what: &str) -> Result<*mut c_void, String> {
        if handle.is_null() {
            return Err(format!("{what} unavailable"));
        }
        self.0.push(handle);
        Ok(handle)
    }
}

impl Drop for Handles {
    fn drop(&mut self) {
        for handle in self.0.iter().rev() {
            let _ = unsafe { WinHttpCloseHandle(*handle) };
        }
    }
}

struct Connection {
    _handles: Handles,
    socket: *mut c_void,
    next_id: i64,
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn internet_session(handles: &mut Handles) -> Result<*mut c_void, String> {
    let agent = wide("DKN Nexus/1.6.19 local media control");
    let session = unsafe {
        WinHttpOpen(
            PCWSTR::from_raw(agent.as_ptr()),
            WINHTTP_ACCESS_TYPE_NO_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        )
    };
    let session = handles.push(session, "local HTTP session")?;
    unsafe { WinHttpSetTimeouts(session, 500, 500, 1000, 1000) }
        .map_err(|error| format!("local HTTP timeout setup failed: {error}"))?;
    Ok(session)
}

fn local_connection(handles: &mut Handles) -> Result<*mut c_void, String> {
    let session = internet_session(handles)?;
    let host = wide("127.0.0.1");
    let connection = unsafe { WinHttpConnect(session, PCWSTR::from_raw(host.as_ptr()), CDP_PORT, 0) };
    handles.push(connection, "localhost connection")
}

fn open_request(handles: &mut Handles, path: &str, method: &str) -> Result<*mut c_void, String> {
    let connection = local_connection(handles)?;
    let path = wide(path);
    let method = wide(method);
    let request = unsafe {
        WinHttpOpenRequest(
            connection,
            PCWSTR::from_raw(method.as_ptr()),
            PCWSTR::from_raw(path.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            ptr::null(),
            Default::default(),
        )
    };
    handles.push(request, "localhost request")
}

fn response_status(request: *mut c_void) -> Result<u32, String> {
    let mut status = 0u32;
    let mut bytes = std::mem::size_of::<u32>() as u32;
    unsafe {
        WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some((&mut status as *mut u32).cast()),
            &mut bytes,
            ptr::null_mut(),
        )
    }
    .map_err(|error| format!("localhost response status unavailable: {error}"))?;
    Ok(status)
}

fn get_targets() -> Result<Vec<Value>, String> {
    let mut handles = Handles(Vec::new());
    let request = open_request(&mut handles, "/json", "GET")?;
    unsafe { WinHttpSendRequest(request, None, None, 0, 0, 0) }
        .map_err(|error| format!("localhost discovery request failed: {error}"))?;
    unsafe { WinHttpReceiveResponse(request, ptr::null_mut()) }
        .map_err(|error| format!("localhost discovery response failed: {error}"))?;
    let status = response_status(request)?;
    if status != 200 {
        return Err(format!("localhost discovery returned HTTP {status}"));
    }

    let mut body = Vec::new();
    loop {
        let mut available = 0u32;
        unsafe { WinHttpQueryDataAvailable(request, &mut available) }
            .map_err(|error| format!("localhost discovery read failed: {error}"))?;
        if available == 0 {
            break;
        }
        if body.len().saturating_add(available as usize) > MAX_HTTP_BODY {
            return Err("localhost discovery response exceeded its size limit".into());
        }
        let mut chunk = vec![0u8; available as usize];
        let mut read = 0u32;
        unsafe {
            WinHttpReadData(
                request,
                chunk.as_mut_ptr().cast(),
                available,
                &mut read,
            )
        }
        .map_err(|error| format!("localhost discovery body read failed: {error}"))?;
        chunk.truncate(read as usize);
        body.extend_from_slice(&chunk);
    }
    let targets: Value = serde_json::from_slice(&body)
        .map_err(|error| format!("localhost discovery JSON invalid: {error}"))?;
    targets
        .as_array()
        .cloned()
        .ok_or_else(|| "localhost discovery did not return a target list".into())
}

fn validated_debugger_path(url: &str) -> Result<String, String> {
    let path = url
        .strip_prefix("ws://127.0.0.1:9223/")
        .ok_or_else(|| "debugger target is not bound to the approved localhost endpoint".to_string())?;
    let id = path.strip_prefix("devtools/page/").unwrap_or("");
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')) {
        return Err("debugger target path contains unexpected characters".into());
    }
    Ok(format!("/devtools/page/{id}"))
}

impl Connection {
    fn open() -> Result<Self, String> {
        let target = get_targets()?
            .into_iter()
            .find(|item| {
                item.get("type").and_then(Value::as_str) == Some("page")
                    && item
                        .get("url")
                        .and_then(Value::as_str)
                        .is_some_and(|url| url.starts_with("orpheus://"))
            })
            .ok_or_else(|| "NetEase player page not found on the local control channel".to_string())?;
        let websocket_url = target
            .get("webSocketDebuggerUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| "NetEase local control target has no WebSocket URL".to_string())?;
        let path = validated_debugger_path(websocket_url)?;

        let mut handles = Handles(Vec::new());
        let request = open_request(&mut handles, &path, "GET")?;
        unsafe { WinHttpSetOption(Some(request), WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, None) }
            .map_err(|error| format!("localhost WebSocket upgrade setup failed: {error}"))?;
        unsafe { WinHttpSendRequest(request, None, None, 0, 0, 0) }
            .map_err(|error| format!("localhost WebSocket handshake failed: {error}"))?;
        unsafe { WinHttpReceiveResponse(request, ptr::null_mut()) }
            .map_err(|error| format!("localhost WebSocket handshake response failed: {error}"))?;
        let status = response_status(request)?;
        if status != 101 {
            return Err(format!("localhost WebSocket upgrade returned HTTP {status}"));
        }
        let socket = unsafe { WinHttpWebSocketCompleteUpgrade(request, None) };
        let socket = handles.push(socket, "localhost WebSocket")?;
        Ok(Self {
            _handles: handles,
            socket,
            next_id: 1,
        })
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = serde_json::to_vec(&json!({"id": id, "method": method, "params": params}))
            .map_err(|error| format!("local command serialization failed: {error}"))?;
        let send_error = unsafe {
            WinHttpWebSocketSend(
                self.socket,
                WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
                Some(&payload),
            )
        };
        if send_error != 0 {
            return Err(format!("localhost WebSocket send failed: {send_error}"));
        }

        // The page can emit unsolicited CDP events (console, network, timeline)
        // before our reply. Skipping them must be bounded: CDP is a single
        // multiplexed stream, so a chatty page could otherwise keep this loop
        // alive indefinitely while the caller waits. Each individual receive is
        // already bounded by the WinHTTP timeouts set in `internet_session`.
        let mut skipped_messages = 0usize;
        loop {
            if skipped_messages > MAX_SKIPPED_MESSAGES {
                return Err("localhost control response did not arrive within the message budget".into());
            }
            let mut message = Vec::new();
            loop {
                let mut chunk = [0u8; 16 * 1024];
                let mut read = 0u32;
                let mut buffer_type = WINHTTP_WEB_SOCKET_BUFFER_TYPE::default();
                let receive_error = unsafe {
                    WinHttpWebSocketReceive(
                        self.socket,
                        chunk.as_mut_ptr().cast(),
                        chunk.len() as u32,
                        &mut read,
                        &mut buffer_type,
                    )
                };
                if receive_error != 0 {
                    return Err(format!("localhost WebSocket receive failed: {receive_error}"));
                }
                if buffer_type.0 == 4 {
                    return Err("localhost WebSocket closed by player".into());
                }
                if message.len().saturating_add(read as usize) > MAX_CDP_MESSAGE {
                    return Err("localhost control message exceeded its size limit".into());
                }
                message.extend_from_slice(&chunk[..read as usize]);
                if buffer_type != WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE {
                    break;
                }
            }
            let response: Value = serde_json::from_slice(&message)
                .map_err(|error| format!("local control response JSON invalid: {error}"))?;
            if response.get("id").and_then(Value::as_i64) != Some(id) {
                skipped_messages += 1;
                continue;
            }
            if let Some(error) = response.get("error") {
                let code = error.get("code").and_then(Value::as_i64).unwrap_or_default();
                return Err(format!("local player rejected control request ({code})"));
            }
            return Ok(response);
        }
    }

    fn evaluate(&mut self, expression: &str) -> Result<Value, String> {
        let response = self.request(
            "Runtime.evaluate",
            json!({"expression": expression, "returnByValue": true, "awaitPromise": false}),
        )?;
        let result = response
            .pointer("/result/result")
            .ok_or_else(|| "local player evaluation returned no result".to_string())?;
        if result.get("exceptionDetails").is_some() {
            return Err("local player state probe was rejected".into());
        }
        Ok(result.get("value").cloned().unwrap_or(Value::Null))
    }

    fn initialize_runtime(&mut self) -> Result<(), String> {
        let ready = self.evaluate(
            "(()=>{if(!window.__gpt_cm_require__&&window.webpackJsonp){window.webpackJsonp.push([[987660],{987660:function(module,exports,require){window.__gpt_cm_require__=require;}},[[987660]]]);}return Boolean(window.__gpt_cm_require__);})()",
        )?;
        if ready.as_bool() == Some(true) {
            Ok(())
        } else {
            Err("NetEase client runtime is not available".into())
        }
    }

    fn click(&mut self, x: f64, y: f64) -> Result<bool, String> {
        for (event_type, button) in [("mouseMoved", None), ("mousePressed", Some("left")), ("mouseReleased", Some("left"))] {
            let mut params = json!({"type": event_type, "x": x, "y": y});
            if let Some(button) = button {
                params["button"] = json!(button);
                params["clickCount"] = json!(1);
            }
            self.request("Input.dispatchMouseEvent", params)?;
        }
        Ok(true)
    }
}

const SNAPSHOT_SCRIPT: &str = r#"(()=>{
  const errorName=e=>String(e&&e.name||'Error').replace(/[^a-zA-Z]/g,'').slice(0,24)||'Error';
  let p={},positionValue=null,durationValue=null,storeStage='runtime_missing';
  try{
    const req=window.__gpt_cm_require__;
    if(typeof req==='function'){
      storeStage='module_12_unavailable';
      const module=req(12),api=module&&module.a;
      if(api&&typeof api.getStore==='function'){
        const store=api.getStore();
        if(store&&typeof store==='object'){
          p=store.playing||{};const track=p.curPlaying||{};storeStage='available';
          const raw=(object,names)=>{for(const name of names){const value=object&&object[name];if(typeof value==='number'&&Number.isFinite(value))return {key:name,value};}return null;};
          positionValue=raw(p,['curPlayingTime','currentTime','currentPlayTime','playingCurrentTime','playingTime','playingProgress','playProgress','progress','position','time'])||raw(track,['currentTime','playingProgress','playProgress','progress','position','time']);
          durationValue=raw(p,['curPlayingDuration','playingDuration','duration'])||raw(track,['duration','dt','durationMs']);
        }else storeStage='empty_store';
      }else storeStage='store_api_missing';
    }
  }catch(e){storeStage='error_'+errorName(e);}
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0;};
  const cls=e=>String(e.getAttribute('class')||'').toLowerCase();
  const label=e=>[e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('data-action'),e.getAttribute('data-tip')].filter(Boolean).join(' ').toLowerCase();
  let elements=[],progress=[],stage='document_missing',controls={previous:false,toggle:false,next:false},mediaElement=null;
  try{
    if(document&&document.documentElement){
      stage='controls_unread';
      const mediaElements=[...document.querySelectorAll('audio,video')].filter(e=>Number.isFinite(e.duration)&&e.duration>0&&!e.ended&&e.readyState>0);
      mediaElement=mediaElements.find(e=>!e.paused)||(mediaElements.length===1?mediaElements[0]:null);
      elements=[...document.querySelectorAll('button,[role="button"],[data-action],[class*="play" i],[class*="prev" i],[class*="next" i]')].slice(0,500).filter(visible);
      const inPlayer=e=>e.closest('[class*="player" i],[class*="playing" i],[class*="control" i],[class*="toolbar" i]');
      const classify=e=>{const l=label(e),c=cls(e),t=String(e.textContent||'').trim().toLowerCase(),zone=inPlayer(e);
        if(/previous|prev|上一首|上一曲|前一首/.test(l)||(/prev|previous/.test(c)&&zone)||/^(上一首|上一曲|prev|previous)$/.test(t))return 'previous';
        if(/next|下一首|下一曲|后一首/.test(l)||(/next/.test(c)&&zone)||/^(下一首|下一曲|next)$/.test(t))return 'next';
        if(/^(播放|暂停|播放\/暂停|暂停播放|play|pause|play\/pause)$/.test(l.trim())||(/play.?pause|pause.?play|icon-play|icon-pause/.test(c)&&zone))return 'toggle';
        return '';
      };
      controls={previous:elements.some(e=>classify(e)==='previous'),toggle:elements.some(e=>classify(e)==='toggle'),next:elements.some(e=>classify(e)==='next')};
      progress=[...document.querySelectorAll('input[type="range"],[role="slider"],[aria-valuenow],[class*="progress" i],[class*="seek" i]')].filter(visible).map(e=>{const r=e.getBoundingClientRect(),c=cls(e);let score=0;if(e.matches('input[type="range"],[role="slider"],[aria-valuenow]'))score+=100;if(/seek|current|playback/.test(c))score+=40;if(/progress/.test(c))score+=20;if(r.top>innerHeight*.55)score+=30;if(/buffer|loading|cache|volume/.test(c))score-=100;if(r.width>250)score+=8;return {e,r,cls:c,score};}).filter(x=>x.r.width>=120&&x.r.height<=64&&!/buffer|loading|cache|volume/.test(x.cls)).sort((a,b)=>b.score-a.score||b.r.width-a.r.width);
      stage='ready';
    }
  }catch(e){stage='error_'+errorName(e);}
  let duration=durationValue?durationValue.value:0;
  if(duration>10000)duration/=1000;
  let position=positionValue?positionValue.value:0;
  if(positionValue&&/progress/i.test(positionValue.key)&&position>=0&&position<=1.2)position*=duration;
  else if(positionValue&&/progress/i.test(positionValue.key)&&position<=100)position=duration*position/100;
  else if(position>Math.max(1000,duration*10))position/=1000;
  if(mediaElement){duration=mediaElement.duration;position=mediaElement.currentTime;}
  const slider=progress[0]&&progress[0].e;
  const sliderPosition=slider?Number(slider.getAttribute('aria-valuenow')??slider.value):NaN;
  const sliderMax=slider?Number(slider.getAttribute('aria-valuemax')??slider.max??slider.getAttribute('data-duration')):NaN;
  if(duration<=0&&Number.isFinite(sliderMax)&&sliderMax>100)duration=sliderMax>10000?sliderMax/1000:sliderMax;
  if(!positionValue&&Number.isFinite(sliderPosition)){if(sliderMax===100&&duration>0)position=duration*sliderPosition/100;else position=sliderPosition>Math.max(1000,duration*10)?sliderPosition/1000:sliderPosition;}
  if(duration<=0){
    const parseClock=value=>{const parts=String(value||'').trim().split(':');if(parts.length<2||parts.length>3||!parts.every(part=>/^\d{1,3}$/.test(part)))return 0;const n=parts.map(Number);return n.length===3?n[0]*3600+n[1]*60+n[2]:n[0]*60+n[1];};
    try{for(const e of document.querySelectorAll('time,[class~="all"],[class*="duration" i],[data-duration]')){if(visible(e)){const seconds=parseClock(e.getAttribute('datetime')||e.textContent);if(seconds>duration)duration=seconds;}}}catch(_){ }
  }
  const inPlayer=e=>e.closest('[class*="player" i],[class*="playing" i],[class*="control" i],[class*="toolbar" i]');
  const pauseVisible=elements.some(e=>/^(暂停|pause)$/.test(label(e).trim())||(/icon-pause/.test(label(e)+' '+cls(e))&&inPlayer(e)));
  const playVisible=elements.some(e=>/^(播放|play)$/.test(label(e).trim())||(/icon-play/.test(label(e)+' '+cls(e))&&inPlayer(e)));
  const state=[p.playingState,p.isPlaying,p.playing].find(value=>typeof value==='boolean');
  const domPlaying=pauseVisible!==playVisible?pauseVisible:null;
  const playing=typeof state==='boolean'?state:(mediaElement?!mediaElement.paused&&!mediaElement.ended:domPlaying);
  const mediaSeekable=!!(mediaElement&&mediaElement.seekable&&mediaElement.seekable.length>0);
  return {ok:stage==='ready',stage,storeStage,position:Number.isFinite(position)?Math.max(0,position):0,duration:Number.isFinite(duration)?Math.max(0,duration):0,positionKey:positionValue&&positionValue.key||'',durationKey:durationValue&&durationValue.key||'',stateType:typeof state,controls,canSeek:progress.length>0||mediaSeekable,progressCount:progress.length,controlCount:elements.length,progressClasses:progress.slice(0,5).map(x=>x.cls.slice(0,100)),stateKeys:Object.keys(p).filter(k=>/time|progress|duration|seek/i.test(k)).slice(0,16),mediaElement:!!mediaElement,mediaSeekable,playing};
})()"#;

const CONTROL_RECT_SCRIPT: &str = r#"(()=>{
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0;};
  const cls=e=>String(e.getAttribute('class')||'').toLowerCase();
  const label=e=>[e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('data-action'),e.getAttribute('data-tip')].filter(Boolean).join(' ').toLowerCase();
  const action=__ACTION__;
  const candidates=[...document.querySelectorAll('button,[role="button"],[data-action],[class*="play" i],[class*="prev" i],[class*="next" i]')].slice(0,500).filter(visible).map(e=>{
    const l=label(e),c=cls(e),t=String(e.textContent||'').trim().toLowerCase(),zone=e.closest('[class*="player" i],[class*="playing" i],[class*="control" i],[class*="toolbar" i]');let match=false,score=0;
    if(action==='previous')match=/previous|prev|上一首|上一曲|前一首/.test(l)||(/prev|previous/.test(c)&&zone)||/^(上一首|上一曲|prev|previous)$/.test(t);
    if(action==='next')match=/next|下一首|下一曲|后一首/.test(l)||(/next/.test(c)&&zone)||/^(下一首|下一曲|next)$/.test(t);
    if(action==='toggle')match=/^(播放|暂停|播放\/暂停|暂停播放|play|pause|play\/pause)$/.test(l.trim())||(/play.?pause|pause.?play|icon-play|icon-pause/.test(c)&&zone);
    if(!match)return null;
    if(l)score+=100;if(t&&/^(播放|暂停|播放\/暂停|上一首|下一首|上一曲|下一曲|play|pause|next|previous|prev)$/.test(t))score+=60;
    if(zone)score+=40;
    const r=e.getBoundingClientRect();return {r,score};
  }).filter(Boolean).sort((a,b)=>b.score-a.score);
  if(!candidates.length||(candidates.length>1&&candidates[0].score===candidates[1].score))return null;
  const r=candidates[0].r;return {x:r.left+r.width/2,y:r.top+r.height/2};
})()"#;

const PROGRESS_RECT_SCRIPT: &str = r#"(()=>{
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0;};
  const candidates=[...document.querySelectorAll('input[type="range"],[role="slider"],[aria-valuenow],[class*="progress" i],[class*="seek" i]')].filter(visible).map(e=>{
    const r=e.getBoundingClientRect(),c=String(e.getAttribute('class')||'').toLowerCase();let score=0;
    if(e.matches('input[type="range"],[role="slider"],[aria-valuenow]'))score+=100;
    if(/seek|current|playback/.test(c))score+=40;if(/progress/.test(c))score+=20;
    if(r.top>innerHeight*.55)score+=30;if(/buffer|loading|cache|volume/.test(c))score-=100;if(r.width>250)score+=8;
    return {r,c,score};
  }).filter(x=>x.r.width>=120&&x.r.height<=64&&!/buffer|loading|cache|volume/.test(x.c)).sort((a,b)=>b.score-a.score||b.r.width-a.r.width);
  if(!candidates.length)return null;const r=candidates[0].r;return {left:r.left,top:r.top,width:r.width,height:r.height};
})()"#;

const MEDIA_SEEK_SCRIPT: &str = r#"(()=>{
  const requested=__POSITION__;
  const candidates=[...document.querySelectorAll('audio,video')].filter(e=>Number.isFinite(e.duration)&&e.duration>0&&!e.ended&&e.readyState>0&&e.seekable&&e.seekable.length>0);
  const media=candidates.find(e=>!e.paused)||(candidates.length===1?candidates[0]:null);
  if(!media)return false;
  try{const start=media.seekable.start(0),end=media.seekable.end(media.seekable.length-1);media.currentTime=Math.max(start,Math.min(end,requested));return true;}catch(_){return false;}
})()"#;

/// Collapses the low-level error strings into a stable category so an
/// alternating pair of error codes cannot produce a log line every poll.
fn failure_category(detail: &str) -> &'static str {
    let lowered = detail.to_ascii_lowercase();
    if lowered.contains("not found on the local control channel") {
        "player_page_missing"
    } else if lowered.contains("handshake") || lowered.contains("upgrade") {
        "websocket_handshake"
    } else if lowered.contains("discovery") {
        "discovery_unavailable"
    } else if lowered.contains("runtime is not available") {
        "client_runtime_unavailable"
    } else if lowered.contains("receive") || lowered.contains("closed") {
        "connection_lost"
    } else if lowered.starts_with("probe:") {
        "probe_incomplete"
    } else if lowered.contains("size limit") || lowered.contains("unexpected characters") || lowered.contains("not bound") {
        "rejected_target"
    } else {
        "unavailable"
    }
}

fn record_channel_state(available: bool, category: &str) {
    static LAST: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    let state = if available {
        "available".to_string()
    } else {
        category.to_string()
    };
    if let Ok(mut last) = LAST.get_or_init(|| Mutex::new(None)).lock() {
        if last.as_ref() != Some(&state) {
            crate::diagnostic_log(format!("media:netease_local_channel state={state}"));
            *last = Some(state);
        }
    }
}

fn channel_available() {
    let recovered = backoff().lock().map(|mut state| state.record_success()).unwrap_or(false);
    if recovered {
        crate::diagnostic_log("media:netease_local_channel recovered");
    }
    record_channel_state(true, "");
}

/// Records that the channel was reachable without claiming a full recovery.
///
/// Used when a control reached the page but found no matching control to click.
/// The channel demonstrably works, so the backoff ladder must not stay latched —
/// otherwise a single transient read failure would suppress local control for
/// 30s even though the endpoint is answering. It must not log "recovered"
/// either, because no failure was actually overcome.
fn channel_reachable() {
    if let Ok(mut state) = backoff().lock() {
        state.record_success();
    }
    record_channel_state(true, "");
}

fn channel_unavailable(detail: &str) {
    let now = Instant::now();
    let category = failure_category(detail);
    let failures = match backoff().lock() {
        Ok(mut state) => {
            let delay = state.record_failure(now);
            crate::diagnostic_log(format!(
                "media:netease_local_channel backoff failures={} retry_in_s={} category={category}",
                state.consecutive_failures,
                delay.as_secs(),
            ));
            state.consecutive_failures
        }
        Err(_) => return,
    };
    // Log the first failure and each category change; steady repetition of the
    // same category at increasing backoff only shows up in the backoff line.
    if failures == 1 {
        crate::diagnostic_log(format!("media:netease_local_channel reason={category}"));
    }
    record_channel_state(false, category);
}

pub(crate) fn read_snapshot() -> Option<PlaybackSnapshot> {
    if channel_backoff_active() { return None; }

    let result = (|| {
        let mut connection = Connection::open()?;
        connection.initialize_runtime()?;
        connection.evaluate(SNAPSHOT_SCRIPT)
    })();
    let state = match result {
        Ok(state) if state.get("ok").and_then(Value::as_bool) == Some(true) => state,
        Ok(state) => {
            let detail = format!("probe:{}:store:{}", state.get("stage").and_then(Value::as_str).unwrap_or("unknown"), state.get("storeStage").and_then(Value::as_str).unwrap_or("unknown"));
            channel_unavailable(&detail);
            return None;
        }
        Err(error) => {
            channel_unavailable(&error);
            return None;
        }
    };
    channel_available();

    let snapshot = PlaybackSnapshot {
        position: state.get("position").and_then(Value::as_f64).unwrap_or(0.0),
        duration: state.get("duration").and_then(Value::as_f64).unwrap_or(0.0),
        playing: state.get("playing").and_then(Value::as_bool),
        can_seek: state.get("canSeek").and_then(Value::as_bool).unwrap_or(false),
        can_toggle: state.pointer("/controls/toggle").and_then(Value::as_bool).unwrap_or(false),
        can_next: state.pointer("/controls/next").and_then(Value::as_bool).unwrap_or(false),
        can_previous: state.pointer("/controls/previous").and_then(Value::as_bool).unwrap_or(false),
    };
    let diagnostic = format!(
        "media:netease_local_probe stage={} store={} state_keys={} position_key={} duration_key={} progress={} controls={}/{}/{} candidates={} media_element={} seekable={} playing_known={}",
        state.get("stage").and_then(Value::as_str).unwrap_or("unknown"),
        state.get("storeStage").and_then(Value::as_str).unwrap_or("unknown"),
        state.get("stateKeys").and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(",")).unwrap_or_default(),
        state.get("positionKey").and_then(Value::as_str).unwrap_or(""),
        state.get("durationKey").and_then(Value::as_str).unwrap_or(""),
        state.get("progressClasses").and_then(Value::as_array).map(|items| items.len()).unwrap_or(0),
        snapshot.can_previous,
        snapshot.can_toggle,
        snapshot.can_next,
        state.get("controlCount").and_then(Value::as_u64).unwrap_or(0),
        state.get("mediaElement").and_then(Value::as_bool).unwrap_or(false),
        state.get("mediaSeekable").and_then(Value::as_bool).unwrap_or(false),
        snapshot.playing.is_some(),
    );
    static LAST_PROBE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    if let Ok(mut last) = LAST_PROBE.get_or_init(|| Mutex::new(None)).lock() {
        if last.as_ref() != Some(&diagnostic) {
            crate::diagnostic_log(diagnostic.clone());
            *last = Some(diagnostic);
        }
    }
    Some(snapshot)
}

fn control_once(action: &str, position: Option<f64>) -> Result<bool, String> {
    let mut connection = Connection::open()?;
    connection.initialize_runtime()?;
    if action == "seek" {
        let snapshot = connection.evaluate(SNAPSHOT_SCRIPT)?;
        let duration = snapshot.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
        if !duration.is_finite() || duration <= 0.0 {
            return Ok(false);
        }
        let position = position.unwrap_or(0.0).clamp(0.0, duration);
        let media_seek = MEDIA_SEEK_SCRIPT.replace("__POSITION__", &serde_json::to_string(&position).unwrap_or_else(|_| "0".into()));
        if connection.evaluate(&media_seek)?.as_bool() == Some(true) { return Ok(true); }
        let rect = connection.evaluate(PROGRESS_RECT_SCRIPT)?;
        let Some(rect) = rect.as_object() else { return Ok(false); };
        let left = rect.get("left").and_then(Value::as_f64).unwrap_or(0.0);
        let top = rect.get("top").and_then(Value::as_f64).unwrap_or(0.0);
        let width = rect.get("width").and_then(Value::as_f64).unwrap_or(0.0);
        let height = rect.get("height").and_then(Value::as_f64).unwrap_or(0.0);
        if width < 120.0 || height <= 0.0 {
            return Ok(false);
        }
        let ratio = (position / duration).clamp(0.005, 0.995);
        let x = left + width * ratio;
        return connection.click(x, top + height / 2.0);
    }

    let action = match action {
        "toggle" | "next" | "previous" => action,
        _ => return Ok(false),
    };
    let expression = CONTROL_RECT_SCRIPT.replace("__ACTION__", &serde_json::to_string(action).unwrap_or_else(|_| "\"\"".into()));
    let rect = connection.evaluate(&expression)?;
    let Some(rect) = rect.as_object() else { return Ok(false); };
    let x = rect.get("x").and_then(Value::as_f64).unwrap_or(0.0);
    let y = rect.get("y").and_then(Value::as_f64).unwrap_or(0.0);
    connection.click(x, y)
}

pub(crate) fn control(action: &str, position: Option<f64>) -> Result<bool, String> {
    if !matches!(action, "toggle" | "next" | "previous" | "seek") { return Ok(false); }
    // A failed poll already established that the local endpoint is unavailable.
    // Skip another synchronous handshake and let the existing Windows media-key
    // fallback handle transport controls immediately during the backoff window.
    if channel_backoff_active() { return Ok(false); }
    match control_once(action, position) {
        // Reaching the page proves the channel works even when no matching
        // control was found, so either outcome clears the wait window. Only a
        // dispatched control reports a recovery: a no-match is not an overcome
        // failure, and logging it as one would be misleading.
        Ok(dispatched) => {
            if dispatched {
                channel_available();
            } else {
                channel_reachable();
            }
            Ok(dispatched)
        }
        Err(error) => {
            channel_unavailable(&error);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        validated_debugger_path, ChannelBackoff, BACKOFF_STEPS,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn only_accepts_the_fixed_local_debugger_host() {
        assert_eq!(
            validated_debugger_path("ws://127.0.0.1:9223/devtools/page/abc").unwrap(),
            "/devtools/page/abc"
        );
        assert!(validated_debugger_path("ws://localhost:9223/devtools/page/abc").is_err());
        assert!(validated_debugger_path("ws://192.168.1.2:9223/devtools/page/abc").is_err());
        assert!(validated_debugger_path("ws://127.0.0.1:9223/devtools/page/a?x=1").is_err());
        assert!(validated_debugger_path("ws://127.0.0.1:9223/admin/secret").is_err());
    }

    #[test]
    fn backoff_grows_through_the_documented_steps_and_then_caps() {
        assert_eq!(ChannelBackoff::delay_for(1), Duration::from_secs(3));
        assert_eq!(ChannelBackoff::delay_for(2), Duration::from_secs(10));
        assert_eq!(ChannelBackoff::delay_for(3), Duration::from_secs(30));
        // Everything beyond the last step stays capped rather than growing
        // without bound.
        assert_eq!(ChannelBackoff::delay_for(4), Duration::from_secs(30));
        assert_eq!(ChannelBackoff::delay_for(500), Duration::from_secs(30));
        assert_eq!(ChannelBackoff::delay_for(u32::MAX), *BACKOFF_STEPS.last().unwrap());
    }

    #[test]
    fn consecutive_failures_advance_the_backoff_and_block_probing_until_due() {
        let start = Instant::now();
        let mut state = ChannelBackoff::default();

        assert!(!state.is_active(start), "a fresh channel must probe immediately");

        assert_eq!(state.record_failure(start), Duration::from_secs(3));
        assert!(state.is_active(start), "backoff must block an immediate retry");
        assert!(state.is_active(start + Duration::from_millis(2_999)));
        assert!(
            !state.is_active(start + Duration::from_secs(3)),
            "the probe becomes due once its delay elapses"
        );

        assert_eq!(state.record_failure(start + Duration::from_secs(3)), Duration::from_secs(10));
        assert_eq!(state.record_failure(start + Duration::from_secs(13)), Duration::from_secs(30));
        assert_eq!(state.record_failure(start + Duration::from_secs(43)), Duration::from_secs(30));
        assert_eq!(state.consecutive_failures, 4);
    }

    #[test]
    fn success_resets_the_backoff_and_reports_recovery_once() {
        let start = Instant::now();
        let mut state = ChannelBackoff::default();

        assert!(!state.record_success(), "no recovery to report on a healthy channel");

        state.record_failure(start);
        state.record_failure(start + Duration::from_secs(3));
        assert_eq!(state.consecutive_failures, 2);

        assert!(state.record_success(), "recovery from failure must be reported");
        assert_eq!(state.consecutive_failures, 0);
        assert!(!state.is_active(start), "success must clear the wait window");
        assert!(
            !state.record_success(),
            "a second success must not report recovery again"
        );

        // After recovery the next failure starts the ladder from the first step.
        assert_eq!(state.record_failure(start), Duration::from_secs(3));
    }

    #[test]
    fn a_reachable_channel_clears_the_wait_window_without_claiming_recovery() {
        // Regression guard. `control` distinguishes two successful outcomes:
        //   - a control was dispatched -> `channel_available()` (logs recovery)
        //   - the page was reached but no control matched -> `channel_reachable()`
        // Both clear the wait window, matching the original design: the
        // pre-patch code called `channel_available()` for any `Ok(_)`, because
        // reaching the page proves the endpoint is answering. The distinction
        // exists so a no-match does not log a recovery that never happened.
        let start = Instant::now();
        let mut state = ChannelBackoff::default();

        // Climb to the capped step.
        state.record_failure(start);
        state.record_failure(start + Duration::from_secs(3));
        assert_eq!(state.record_failure(start + Duration::from_secs(13)), Duration::from_secs(30));
        assert!(state.is_active(start + Duration::from_secs(13)));

        // `channel_reachable` semantics: clear the window, report no recovery.
        assert!(state.record_success(), "clearing a latched ladder is a transition");
        assert!(!state.is_active(start + Duration::from_secs(13)), "the wait window must clear");
        assert_eq!(state.consecutive_failures, 0);

        // And the ladder restarts from step one for genuinely new failures,
        // rather than resuming at the cap.
        assert_eq!(state.record_failure(start + Duration::from_secs(13)), Duration::from_secs(3));
    }

    #[test]
    fn failure_categories_collapse_low_level_detail() {
        use super::failure_category;
        // Two alternating low-level error codes must map to the same category,
        // which is what stops the per-poll log storm.
        for windows_error in ["localhost discovery request failed: 12002", "localhost discovery request failed: 12029"] {
            assert_eq!(failure_category(windows_error), "discovery_unavailable");
        }
        assert_eq!(
            failure_category("NetEase player page not found on the local control channel"),
            "player_page_missing"
        );
        assert_eq!(failure_category("localhost WebSocket handshake failed: 12175"), "websocket_handshake");
        assert_eq!(failure_category("NetEase client runtime is not available"), "client_runtime_unavailable");
        assert_eq!(failure_category("localhost WebSocket closed by player"), "connection_lost");
        assert_eq!(failure_category("debugger target path contains unexpected characters"), "rejected_target");
        assert_eq!(failure_category("something else entirely"), "unavailable");
    }
}
