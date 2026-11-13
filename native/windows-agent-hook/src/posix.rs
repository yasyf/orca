//! The macOS and Linux build, registered in exec form as `orca-agent-hook claude <script>`.
//! It keeps the contract of the managed `claude-hook.sh` (src/main/claude/hooks/hook-script.ts)
//! in one process: Claude Code is the parent, so no shell, `cat`, `ps` or `curl` starts.

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::{append_form_field, arm, endpoint_value, read_endpoint_file, var, Agent};
use crate::{CONNECT_TIMEOUT, TOTAL_TIMEOUT};

// The names agent-tool-plugin-hooks.ts, claude-permission-hook-hold.ts and agent-hook-types.ts use.
const PRE_TOOL_USE_DECISION: &str = "claude-pre-tool-use-v1";
const PERMISSION_REQUEST_DECISION: &str = "claude-permission-request-v1";
const RAW_JSON_TRANSPORT: &str = "raw-json-v1";
const PRE_TOOL_USE_TIMEOUT: Duration = Duration::from_secs(8);
// Why 126 s: Orca answers within its 122 s hold; the managed entry's 130 s timeout outlasts both.
const PERMISSION_REQUEST_TIMEOUT: Duration = Duration::from_secs(126);
const SPOOL_FILE_BYTE_LIMIT: u64 = 5 * 1024 * 1024;
const SPOOL_MAX_AGE_DAYS: u64 = 7;

#[derive(Clone, Copy)]
struct Decision {
    name: &'static str,
    timeout: Duration,
    answer_prefix: &'static [u8],
    answer_suffix: &'static [u8],
}

const PRE_TOOL_USE: Decision = Decision {
    name: PRE_TOOL_USE_DECISION,
    timeout: PRE_TOOL_USE_TIMEOUT,
    answer_prefix: br#"{"hookSpecificOutput":{"hookEventName":"PreToolUse""#,
    answer_suffix: b"}}",
};

const PERMISSION_REQUEST: Decision = Decision {
    name: PERMISSION_REQUEST_DECISION,
    timeout: PERMISSION_REQUEST_TIMEOUT,
    answer_prefix:
        br#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":""#,
    answer_suffix: b"}}}",
};

struct Pane {
    key: String,
    tab: String,
    launch_token: String,
    worktree: String,
    env: String,
    version: String,
    port: String,
    token: String,
    transport: String,
    agent_process: String,
    tmux_pane: String,
}

pub fn main(agent: Option<Agent>) {
    let mut stdout = io::stdout();
    let mut payload = Vec::new();
    // Why read first: the caller must never see a broken pipe, even on a skip path.
    let _ = io::stdin().lock().read_to_end(&mut payload);
    while payload.last() == Some(&b'\n') {
        payload.pop();
    }
    let answer = match agent {
        Some(agent) if !payload.is_empty() => report(&agent, &payload, &mut stdout),
        _ => Some(Vec::new()),
    };
    // Why always an answer: permission hooks fail closed on empty stdout.
    if let Some(answer) = answer {
        let line = if answer.is_empty() {
            b"{}".to_vec()
        } else {
            answer
        };
        let _ = stdout.write_all(&line);
        let _ = stdout.write_all(b"\n");
        let _ = stdout.flush();
    }
}

/// Posts one event; returns the line still owed on stdout, or None once it was printed.
fn report(agent: &Agent, payload: &[u8], stdout: &mut io::Stdout) -> Option<Vec<u8>> {
    let decision = if has_event(payload, "PreToolUse") {
        Some(PRE_TOOL_USE)
    } else if has_event(payload, "PermissionRequest") && !async_entry() {
        Some(PERMISSION_REQUEST)
    } else {
        None
    };
    if decision.is_none() {
        let _ = stdout.write_all(b"{}\n");
        let _ = stdout.flush();
    }
    let owed = |answer: Vec<u8>| decision.is_some().then_some(answer);

    let cursor_replay = !var("CURSOR_VERSION").is_empty() && !var("CURSOR_PROJECT_DIR").is_empty();
    if cursor_replay || agent.exit_vars.iter().any(|name| !var(name).is_empty()) {
        return owed(Vec::new());
    }

    let mut pane = read_pane();
    if !pane.key.is_empty() {
        pane.agent_process = agent_process().unwrap_or_default();
    }
    if pane.key.is_empty() || pane.port.is_empty() || pane.token.is_empty() {
        spool(agent.source, &pane, payload);
        return owed(Vec::new());
    }
    let timeout = decision
        .as_ref()
        .map_or(TOTAL_TIMEOUT, |decision| decision.timeout);
    let request = build_request(
        agent.source,
        &pane,
        payload,
        decision.as_ref().map(|d| d.name),
    );
    match exchange(&pane.port, &request, timeout) {
        Some(reply) => owed(match decision {
            Some(decision) if is_answer(&reply, &decision) => reply,
            _ => Vec::new(),
        }),
        None => {
            spool(agent.source, &pane, payload);
            owed(Vec::new())
        }
    }
}

/// An async entry's output is ignored, so it answers `{}` first like any other event.
fn async_entry() -> bool {
    !var("ORCA_HOOK_ASYNC").is_empty() || std::env::args_os().skip(2).any(|arg| arg == "--async")
}

fn has_event(payload: &[u8], name: &str) -> bool {
    contains(payload, format!(r#""hook_event_name":"{name}""#).as_bytes())
        || contains(
            payload,
            format!(r#""hook_event_name": "{name}""#).as_bytes(),
        )
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn is_answer(reply: &[u8], decision: &Decision) -> bool {
    reply.starts_with(decision.answer_prefix) && reply.ends_with(decision.answer_suffix)
}

fn read_pane() -> Pane {
    let scrub_safe = |name: &str, alias: &str| {
        let value = var(name);
        if value.is_empty() {
            var(alias)
        } else {
            value
        }
    };
    let endpoint = read_endpoint_file();
    let refreshed = endpoint.is_some();
    let endpoint = endpoint.unwrap_or_default();
    let coordinate = |key: &str| endpoint_value(&endpoint, key).unwrap_or_else(|| var(key));
    Pane {
        key: scrub_safe("ORCA_PANE_KEY", "ORCA_AGENT_PANE"),
        tab: var("ORCA_TAB_ID"),
        launch_token: scrub_safe("ORCA_AGENT_LAUNCH_TOKEN", "ORCA_AGENT_LAUNCH"),
        worktree: var("ORCA_WORKTREE_ID"),
        env: coordinate("ORCA_AGENT_HOOK_ENV"),
        version: coordinate("ORCA_AGENT_HOOK_VERSION"),
        port: coordinate("ORCA_AGENT_HOOK_PORT"),
        token: coordinate("ORCA_AGENT_HOOK_TOKEN"),
        // The script unsets the transport before it sources a readable endpoint file.
        transport: if refreshed {
            endpoint_value(&endpoint, "ORCA_AGENT_HOOK_TRANSPORT").unwrap_or_default()
        } else {
            var("ORCA_AGENT_HOOK_TRANSPORT")
        },
        agent_process: String::new(),
        tmux_pane: tmux_pane(),
    }
}

/// The tmux pane id and socket; only a lookup hint for the host's attachment check.
fn tmux_pane() -> String {
    let pane = var("TMUX_PANE");
    let tmux = var("TMUX");
    let numbered = pane
        .strip_prefix('%')
        .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()));
    if !numbered || tmux.is_empty() {
        return String::new();
    }
    let socket = tmux.rsplitn(3, ',').nth(2).unwrap_or(&tmux);
    format!("{pane} {socket}")
}

fn agent_process() -> Option<String> {
    let pid = std::os::unix::process::parent_id();
    let (platform, start_time) = process_start(pid)?;
    Some(format!(
        r#"{{"pid":{pid},"platform":"{platform}","startTime":"{start_time}"}}"#
    ))
}

#[cfg(target_os = "linux")]
fn process_start(pid: u32) -> Option<(&'static str, String)> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // Field 22 overall; the command name before ") " may contain spaces and parentheses.
    let start = stat.rsplit_once(") ")?.1.split_whitespace().nth(19)?;
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let boot = boot.lines().next()?;
    let numeric = !start.is_empty() && start.bytes().all(|byte| byte.is_ascii_digit());
    (numeric && !boot.is_empty()).then(|| ("linux", format!("{boot}:{start}")))
}

/// macOS: the start time exactly as `TZ=UTC0 LC_ALL=C ps -o lstart=` prints it for the probe.
#[cfg(target_os = "macos")]
fn process_start(pid: u32) -> Option<(&'static str, String)> {
    #[repr(C)]
    struct ProcBsdInfo {
        ids: [u32; 12],
        comm: [u8; 16],
        name: [u8; 32],
        counts: [u32; 6],
        start_tvsec: u64,
        start_tvusec: u64,
    }
    extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut ProcBsdInfo,
            size: i32,
        ) -> i32;
    }
    const PROC_PIDTBSDINFO: i32 = 3;
    let size = std::mem::size_of::<ProcBsdInfo>() as i32;
    let mut info = std::mem::MaybeUninit::<ProcBsdInfo>::zeroed();
    // SAFETY: the buffer is a zeroed proc_bsdinfo of exactly the size passed.
    let written = unsafe { proc_pidinfo(pid as i32, PROC_PIDTBSDINFO, 0, info.as_mut_ptr(), size) };
    if written != size {
        return None;
    }
    // SAFETY: the kernel filled all `size` bytes, and every field is plain data.
    let info = unsafe { info.assume_init() };
    Some(("darwin", ps_lstart(info.start_tvsec)))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_start(_pid: u32) -> Option<(&'static str, String)> {
    None
}

/// `%a %b %e %T %Y` in UTC, the C locale's `%c` that `ps -o lstart=` uses.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn ps_lstart(seconds: u64) -> String {
    const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let days = seconds / 86_400;
    let time = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{} {} {day:>2} {:02}:{:02}:{:02} {year}",
        WEEKDAYS[(days % 7) as usize],
        MONTHS[month - 1],
        time / 3600,
        time % 3600 / 60,
        time % 60
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn civil_from_days(days: u64) -> (u64, usize, u64) {
    let shifted = days + 719_468;
    let era = shifted / 146_097;
    let day_of_era = shifted % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    (year, month as usize, day)
}

fn build_request(source: &str, pane: &Pane, payload: &[u8], decision: Option<&str>) -> Vec<u8> {
    let mut headers = vec![("X-Orca-Agent-Hook-Token", pane.token.clone())];
    let body = if pane.transport == RAW_JSON_TRANSPORT {
        let metadata = [
            &pane.key,
            &pane.tab,
            &pane.launch_token,
            &pane.worktree,
            &pane.env,
            &pane.version,
        ]
        .map(String::as_str)
        .join("\u{1f}");
        headers.push(("Content-Type", "application/json".to_string()));
        headers.push(("X-Orca-Agent-Hook-Meta-Encoding", "base64".to_string()));
        headers.push(("X-Orca-Agent-Hook-Meta", base64(metadata.as_bytes())));
        headers.push(("X-Orca-Agent-Process", pane.agent_process.clone()));
        headers.push(("X-Orca-Tmux-Pane", pane.tmux_pane.clone()));
        payload.to_vec()
    } else {
        headers.push((
            "Content-Type",
            "application/x-www-form-urlencoded".to_string(),
        ));
        let mut body = Vec::with_capacity(payload.len() * 3 / 2 + 512);
        for (name, value) in [
            ("paneKey", &pane.key),
            ("tabId", &pane.tab),
            ("launchToken", &pane.launch_token),
            ("worktreeId", &pane.worktree),
            ("env", &pane.env),
            ("version", &pane.version),
            ("agentProcess", &pane.agent_process),
            ("tmuxPane", &pane.tmux_pane),
        ] {
            append_form_field(&mut body, name, value.as_bytes());
            body.push(b'&');
        }
        append_form_field(&mut body, "payload", payload);
        body
    };
    if let Some(decision) = decision {
        headers.push(("X-Orca-Hook-Decision", decision.to_string()));
    }
    let mut request = format!(
        "POST /hook/{source} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nContent-Length: {}\r\n",
        pane.port,
        body.len()
    );
    // curl drops an empty header; a control character would split the request.
    for (name, value) in headers {
        if !value.is_empty() && !value.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    request.push_str("\r\n");
    let mut request = request.into_bytes();
    request.extend_from_slice(&body);
    request
}

/// The reply body, or None where curl would fail (no listener, timeout, short body).
fn exchange(port: &str, request: &[u8], timeout: Duration) -> Option<Vec<u8>> {
    let port = port.parse::<u16>().ok().filter(|port| *port != 0)?;
    let deadline = Instant::now() + timeout;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT.min(timeout)).ok()?;
    // Re-arm per write so a slow reader cannot stretch the total past the deadline.
    let mut unsent = request;
    while !unsent.is_empty() {
        if !arm(&stream, deadline) {
            return None;
        }
        match stream.write(unsent) {
            Ok(0) => return None,
            Ok(written) => unsent = &unsent[written..],
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return None,
        }
    }
    let mut response = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        if !arm(&stream, deadline) {
            return None;
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => response.extend_from_slice(&chunk[..read]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return None,
        }
        // Like curl, stop at the end of a framed body instead of waiting for the close.
        if response_body(&response, false).is_some() {
            break;
        }
    }
    let mut body = response_body(&response, true)?;
    // Command substitution strips the reply's trailing newlines before the script compares it.
    while body.last() == Some(&b'\n') {
        body.pop();
    }
    Some(body)
}

/// The body once the response is complete; an unframed body is complete only at the close.
fn response_body(response: &[u8], closed: bool) -> Option<Vec<u8>> {
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&response[..split]).to_ascii_lowercase();
    let body = &response[split + 4..];
    let no_body = head
        .split_whitespace()
        .nth(1)
        .is_some_and(|status| status == "204" || status == "304");
    if no_body {
        return Some(Vec::new());
    }
    let header = |name: &str| {
        head.lines()
            .find_map(|line| line.strip_prefix(name)?.strip_prefix(':').map(str::trim))
    };
    if header("transfer-encoding").is_some_and(|value| value.contains("chunked")) {
        return dechunk(body);
    }
    match header("content-length").map(str::parse::<usize>) {
        Some(Ok(length)) if body.len() >= length => Some(body[..length].to_vec()),
        Some(_) => None,
        None => closed.then(|| body.to_vec()),
    }
}

fn dechunk(mut body: &[u8]) -> Option<Vec<u8>> {
    let mut decoded = Vec::new();
    loop {
        let line_end = body.windows(2).position(|window| window == b"\r\n")?;
        let size_text = std::str::from_utf8(&body[..line_end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        body = &body[line_end + 2..];
        if size == 0 {
            // The last chunk is complete only once its (possibly empty) trailer section ends.
            let complete =
                body.starts_with(b"\r\n") || body.windows(4).any(|window| window == b"\r\n\r\n");
            return complete.then_some(decoded);
        }
        decoded.extend_from_slice(body.get(..size)?);
        body = body.get(size..)?.strip_prefix(b"\r\n")?;
    }
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let value = group.iter().enumerate().fold(0u32, |value, (index, byte)| {
            value | u32::from(*byte) << (16 - 8 * index)
        });
        for index in 0..4 {
            if index <= group.len() {
                encoded.push(ALPHABET[(value >> (18 - 6 * index) & 63) as usize] as char);
            } else {
                encoded.push('=');
            }
        }
    }
    encoded
}

/// Appends the event for Orca to replay at startup, as `spool_hook_event` does.
fn spool(source: &str, pane: &Pane, payload: &[u8]) {
    let tool_event = [
        "\"PreToolUse\"",
        "\"PostToolUse\"",
        "\"PostToolUseFailure\"",
    ]
    .iter()
    .any(|name| contains(payload, name.as_bytes()))
        || has_event(payload, "PostToolBatch");
    let endpoint = var("ORCA_AGENT_HOOK_ENDPOINT");
    // A stale variable must not create spool state for an absent Orca installation.
    if tool_event || endpoint.is_empty() || pane.key.is_empty() || File::open(&endpoint).is_err() {
        return;
    }
    let Some(directory) = Path::new(&endpoint).parent().map(|base| base.join("spool")) else {
        return;
    };
    if DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)
        .is_err()
    {
        return;
    }
    let _ = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700));
    let path = spool_path(&directory, &pane.key);
    let expired = fs::metadata(&path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age.as_secs() / 86_400 > SPOOL_MAX_AGE_DAYS);
    if expired {
        let _ = File::create(&path);
    }
    let Ok(mut file) = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(&path)
    else {
        return;
    };
    if file
        .metadata()
        .map_or(true, |metadata| metadata.len() >= SPOOL_FILE_BYTE_LIMIT)
    {
        return;
    }
    let received_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() * 1000);
    let mut record = format!(
        "\n{{\"paneKey\":\"{}\",\"tabId\":\"{}\",\"worktreeId\":\"{}\",\"env\":\"{}\",\"version\":\"{}\",\"launchToken\":\"{}\",\"source\":\"{}\",\"receivedAt\":{received_at},\"agentProcess\":\"{}\",\"tmuxPane\":\"{}\",\"payload\":",
        json_escape(&pane.key),
        json_escape(&pane.tab),
        json_escape(&pane.worktree),
        json_escape(&pane.env),
        json_escape(&pane.version),
        json_escape(&pane.launch_token),
        json_escape(source),
        json_escape(&pane.agent_process),
        json_escape(&pane.tmux_pane),
    )
    .into_bytes();
    record.extend_from_slice(payload);
    record.extend_from_slice(b"}\n");
    let _ = file.write_all(&record);
    let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
}

/// `pane-<last 36 bytes of the pane key>.jsonl`, with `/` and `:` replaced like the script's `tr`.
fn spool_path(directory: &Path, pane_key: &str) -> PathBuf {
    let bytes = pane_key.as_bytes();
    let id: Vec<u8> = bytes[bytes.len().saturating_sub(36)..]
        .iter()
        .map(|byte| {
            if matches!(byte, b'/' | b':') {
                b'_'
            } else {
                *byte
            }
        })
        .collect();
    let mut name = b"pane-".to_vec();
    name.extend_from_slice(&id);
    name.extend_from_slice(b".jsonl");
    directory.join(std::ffi::OsStr::from_bytes(&name))
}

/// The script's `sed` escape: backslash and quote escaped, control characters as spaces.
fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            c if c.is_ascii_control() => escaped.push(' '),
            c => escaped.push(c),
        }
    }
    escaped
}
