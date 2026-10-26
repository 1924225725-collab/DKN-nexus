use std::process::Child;
#[cfg(windows)]
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::thread;
#[cfg(windows)]
use std::time::{Duration, Instant};

/// Owns a Windows job object for a spawned helper process. Closing the job
/// terminates any descendants that outlive the direct child, which also closes
/// inherited stdout/stderr handles before reader threads are joined.
pub(crate) struct ChildProcessJob {
    #[cfg(windows)]
    handle: *mut std::ffi::c_void,
    #[cfg(windows)]
    assigned: bool,
}

impl ChildProcessJob {
    pub(crate) fn new() -> Self {
        #[cfg(windows)]
        {
            Self::create_windows_job().unwrap_or(Self {
                handle: std::ptr::null_mut(),
                assigned: false,
            })
        }
        #[cfg(not(windows))]
        {
            Self {}
        }
    }

    #[cfg(windows)]
    fn create_windows_job() -> Option<Self> {
        use std::ffi::c_void;
        use std::mem::{size_of, zeroed};

        #[repr(C)]
        struct BasicLimitInformation {
            per_process_user_time_limit: i64,
            per_job_user_time_limit: i64,
            limit_flags: u32,
            minimum_working_set_size: usize,
            maximum_working_set_size: usize,
            active_process_limit: u32,
            affinity: usize,
            priority_class: u32,
            scheduling_class: u32,
        }

        #[repr(C)]
        struct IoCounters {
            read_operation_count: u64,
            write_operation_count: u64,
            other_operation_count: u64,
            read_transfer_count: u64,
            write_transfer_count: u64,
            other_transfer_count: u64,
        }

        #[repr(C)]
        struct ExtendedLimitInformation {
            basic_limit_information: BasicLimitInformation,
            io_info: IoCounters,
            process_memory_limit: usize,
            job_memory_limit: usize,
            peak_process_memory_used: usize,
            peak_job_memory_used: usize,
        }

        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
            fn SetInformationJobObject(job: *mut c_void, class: i32, info: *const c_void, size: u32) -> i32;
            fn CloseHandle(handle: *mut c_void) -> i32;
        }

        const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
        const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

        let handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if handle.is_null() {
            return None;
        }

        let mut limits: ExtendedLimitInformation = unsafe { zeroed() };
        limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                &limits as *const _ as *const c_void,
                size_of::<ExtendedLimitInformation>() as u32,
            )
        } != 0;
        if !configured {
            unsafe {
                CloseHandle(handle);
            }
            return None;
        }

        Some(Self {
            handle,
            assigned: false,
        })
    }

    pub(crate) fn assign(&mut self, child: &Child) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            if self.handle.is_null() {
                return false;
            }

            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn AssignProcessToJobObject(job: *mut std::ffi::c_void, process: *mut std::ffi::c_void) -> i32;
            }

            self.assigned = unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle().cast()) } != 0;
            self.assigned
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            false
        }
    }

    pub(crate) fn terminate(&mut self, child: &mut Child) {
        #[cfg(windows)]
        if self.assigned && !self.handle.is_null() {
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn TerminateJobObject(job: *mut std::ffi::c_void, exit_code: u32) -> i32;
            }
            if unsafe { TerminateJobObject(self.handle, 1) } != 0 {
                let _ = child.kill();
                return;
            }
        }

        terminate_with_bounded_taskkill(child.id());
        let _ = child.kill();
    }
}

#[cfg(windows)]
impl Drop for ChildProcessJob {
    fn drop(&mut self) {
        if self.handle.is_null() {
            return;
        }

        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        unsafe {
            CloseHandle(self.handle);
        }
        self.handle = std::ptr::null_mut();
    }
}

#[cfg(windows)]
fn terminate_with_bounded_taskkill(process_id: u32) {
    use std::os::windows::process::CommandExt;

    let mut killer = match Command::new("taskkill")
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .spawn()
    {
        Ok(killer) => killer,
        Err(_) => return,
    };

    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(500) {
        if matches!(killer.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let _ = killer.kill();
}

#[cfg(not(windows))]
fn terminate_with_bounded_taskkill(_process_id: u32) {}

