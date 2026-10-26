//! `CodePathWin` for a Node.js Stream Deck plugin: start `plugin.js` under the
//! Stream Deck app's own Node runtime, with no console window, and nothing else.
//!
//! ## Why a launcher at all
//!
//! Stream Deck starts a Node plugin with `node.exe`, which is a CONSOLE-subsystem
//! binary (`subsystem=3 WINDOWS_CUI`, measured). Windows hands a console process
//! that has no terminal to the default terminal application, which opens a
//! window; that is invisible while the default is Console Host and becomes a
//! blank terminal per plugin once a real terminal is the default. Elgato has no
//! fix and no switch for it: the `Nodejs` manifest block is
//! `additionalProperties: false` and holds exactly `Version`, `Debug` and
//! `GenerateProfilerOutput`, so an undocumented key would be rejected by
//! `streamdeck validate` rather than honoured.
//!
//! A GUI-subsystem process cannot be given a console at all, and a child created
//! with `CREATE_NO_WINDOW` gets a headless pseudoconsole. Measured on this
//! machine (default terminal delegated away from Console Host), 2/2 each way:
//! spawning `node.exe` from a console-less GUI parent WITHOUT `CREATE_NO_WINDOW`
//! added one visible top-level window titled with node's own path; WITH it, zero
//! new windows.
//!
//! `bun build --compile --windows-hide-console` is also GUI-subsystem and also
//! works, but it embeds the Bun runtime: 0.1 MB became 52 MB, over Cloudflare
//! Workers' 25 MiB asset cap, and shipped Node, V8, OpenSSL, libuv, ICU, zlib,
//! llhttp, nghttp2 and brotli with no notice file in the bundle. This embeds
//! nothing.
//!
//! ## Finding the runtime
//!
//! The host provisions Node per declared major under
//! `%APPDATA%\Elgato\StreamDeck\NodeJS\<exact patch version>\node.exe` and shares
//! it across every Node plugin. Elgato documents neither the path nor any
//! environment variable naming it, and the leaf directory is the exact patch
//! version, which Stream Deck bumps on its own from 7.1 onward. So this READS
//! the directory and picks a version; it never names one. Preference order is the
//! declared major (newest patch), then the newest runtime of any major, then
//! `node.exe` on `PATH`.
//!
//! Whether the host still provisions the declared major when `CodePathWin` points
//! at an executable is UNVERIFIED -- Stream Deck is not installed on the build
//! machine -- hence the fallbacks. When nothing is found at all the failure is
//! written to `logs/launcher.log` beside the plugin and to stderr, which Stream
//! Deck captures into its own log, rather than being a plugin that merely never
//! appears.

#![windows_subsystem = "windows"]

use std::ffi::c_void;
use std::fs::{read_dir, OpenOptions};
use std::io::Write;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

/// Node major the plugin's manifest declares, stamped in by `deck-pack.ts`.
/// Empty when the manifest has no `Nodejs` block.
const NODE_MAJOR: &str = match option_env!("DECK_NODE_MAJOR") {
    Some(v) => v,
    None => "",
};

/// Flags Elgato documents it always passes to a Node plugin. Reproduced so the
/// plugin runs in the environment the host would have given it.
const NODE_FLAGS: [&str; 2] = ["--enable-source-maps", "--no-global-search-paths"];

fn main() -> ExitCode {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        // Nowhere to log to: the log path is derived from this.
        Err(_) => return ExitCode::from(70),
    };
    let bin = exe.parent().unwrap_or(Path::new(".")).to_path_buf();
    let script = bin.join("plugin.js");

    if !script.is_file() {
        fail(&bin, &format!("no plugin to run: {} is missing", script.display()));
        return ExitCode::from(70);
    }

    let Some(node) = find_node() else {
        fail(
            &bin,
            "no Node.js runtime found. Looked for \
             %APPDATA%\\Elgato\\StreamDeck\\NodeJS\\<version>\\node.exe (the runtime the Stream \
             Deck app provisions) and for node.exe on PATH. Reinstalling the plugin while online \
             lets Stream Deck provision it.",
        );
        return ExitCode::from(70);
    };

    let mut cmd = Command::new(&node);
    cmd.args(NODE_FLAGS)
        .arg(&script)
        // The host's own registration arguments -- -port, -pluginUUID,
        // -registerEvent, -info -- passed through untouched.
        .args(std::env::args_os().skip(1))
        .creation_flags(CREATE_NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            fail(&bin, &format!("could not start {}: {e}", node.display()));
            return ExitCode::from(70);
        }
    };

    // Stream Deck stops a plugin by terminating the process it launched, which is
    // THIS one. Without a kill-on-close job the real plugin would survive every
    // stop and restart still holding the host's WebSocket, and a customer would
    // accumulate one duplicate per restart -- a worse bug than the window this
    // launcher exists to prevent.
    let job = attach_kill_on_close_job(&child);

    let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(70);
    drop(job);
    ExitCode::from(code.clamp(0, 255) as u8)
}

/// The runtime to run `plugin.js` with, or `None` if there is none to be had.
fn find_node() -> Option<PathBuf> {
    let mut best: Option<((bool, [u64; 3]), PathBuf)> = None;

    if let Some(appdata) = std::env::var_os("APPDATA") {
        let root = Path::new(&appdata).join("Elgato").join("StreamDeck").join("NodeJS");
        for entry in read_dir(root).into_iter().flatten().flatten() {
            let candidate = entry.path().join("node.exe");
            if !candidate.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let rank = (!NODE_MAJOR.is_empty() && name.split('.').next() == Some(NODE_MAJOR), version(&name));
            if best.as_ref().is_none_or(|(b, _)| *b < rank) {
                best = Some((rank, candidate));
            }
        }
    }

    best.map(|(_, path)| path).or_else(node_on_path)
}

/// `20.20.2` as a comparable triple. A directory name that is not a version
/// sorts lowest rather than disqualifying itself, so an unexpected layout still
/// yields a runtime.
fn version(name: &str) -> [u64; 3] {
    let mut parts = name.split('.');
    [0, 0, 0].map(|_| parts.next().and_then(|p| p.parse().ok()).unwrap_or(0))
}

fn node_on_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join("node.exe")).find(|p| p.is_file())
}

/// Appends to `logs/launcher.log` beside the plugin, and to stderr, which the
/// host captures. Best effort: there is no one to report a failure to report.
fn fail(bin: &Path, message: &str) {
    eprintln!("deck-launcher: {message}");
    let logs = bin.parent().unwrap_or(bin).join("logs");
    let _ = std::fs::create_dir_all(&logs);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(logs.join("launcher.log")) {
        let _ = writeln!(f, "deck-launcher: {message}");
    }
}

#[repr(C)]
#[derive(Default)]
struct JobObjectBasicLimitInformation {
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
#[derive(Default)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
#[derive(Default)]
struct JobObjectExtendedLimitInformation {
    basic_limit_information: JobObjectBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

/// Closes the returned handle on drop, which kills the child with it.
struct Job(*mut c_void);

impl Drop for Job {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

unsafe extern "system" {
    fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
    fn SetInformationJobObject(job: *mut c_void, class: u32, info: *const c_void, len: u32) -> i32;
    fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
}

fn attach_kill_on_close_job(child: &std::process::Child) -> Option<Job> {
    let job = Job(unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) });
    if job.0.is_null() {
        return None;
    }

    let mut limits = JobObjectExtendedLimitInformation::default();
    limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let set = unsafe {
        SetInformationJobObject(
            job.0,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            &limits as *const _ as *const c_void,
            size_of::<JobObjectExtendedLimitInformation>() as u32,
        )
    };
    if set == 0 {
        return None;
    }

    if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle().cast()) } == 0 {
        return None;
    }
    Some(job)
}
