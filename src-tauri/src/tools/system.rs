//! Phase 1 — System Overview, Process Manager, Service Manager.
//!
//! Everything runs through [`crate::tools::exec`] on the *existing* SSH
//! connection. Commands are selected for GNU/Linux first, with fallbacks for
//! BusyBox and macOS (BSD). Output is parsed carefully so a missing feature
//! degrades rather than erroring the whole overview.
//!
//! Results that are expensive or auto-refreshed are cached in
//! [`ToolsManager`](super::ToolsManager) to avoid spamming the remote.

use std::sync::Arc;

use tauri::State;
use tracing::instrument;

use crate::ssh::manager::SshManager;
use crate::tools::exec::{self, SshHandle};

use super::{ToolsError, ToolsManager};

// ─── Data types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SystemOverview {
    pub hostname: String,
    pub os_name: String,
    pub kernel: String,
    pub load_1: Option<f64>,
    pub load_5: Option<f64>,
    pub load_15: Option<f64>,
    pub cpu_cores: Option<u32>,
    pub cpu_usage_pct: Option<f64>,
    pub mem_total_bytes: u64,
    pub mem_used_bytes: u64,
    pub mem_available_bytes: u64,
    pub swap_total_bytes: u64,
    pub swap_used_bytes: u64,
    pub uptime_secs: u64,
    pub disks: Vec<DiskInfo>,
    /// Whether the remote is Linux (true) or BSD/macOS (false).
    pub is_linux: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DiskInfo {
    pub filesystem: String,
    pub size_kb: u64,
    pub used_kb: u64,
    pub avail_kb: u64,
    pub use_pct: u8,
    pub mounted_on: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub user: String,
    pub cpu_pct: f64,
    pub mem_pct: f64,
    pub rss_kb: u64,
    pub state: String,
    pub name: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KillResult {
    pub pid: u32,
    pub signal: String,
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ServiceInfo {
    pub name: String,
    pub load: String,
    pub active: String,
    pub sub: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
    Reload,
    Enable,
    Disable,
}

impl ServiceAction {
    fn as_cmd(&self) -> &'static str {
        match self {
            ServiceAction::Start => "start",
            ServiceAction::Stop => "stop",
            ServiceAction::Restart => "restart",
            ServiceAction::Reload => "reload-or-restart",
            ServiceAction::Enable => "enable --now",
            ServiceAction::Disable => "disable --now",
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ServiceResult {
    pub unit: String,
    pub action: ServiceAction,
    pub ok: bool,
    pub needs_sudo: bool,
    pub message: String,
}

#[allow(dead_code)] // used by later phases (docker, network, security)
/// Extra metadata sent to the frontend so it can render a friendly upgrade path
/// instead of a raw permission error.
fn permission_error(msg: impl Into<String>) -> ToolsError {
    ToolsError::PermissionDenied(msg.into())
}

fn is_permission_stderr(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("permission denied")
        || lower.contains("access denied")
        || lower.contains("requires root")
        || lower.contains("access is denied")
        || lower.contains("not authorized")
        || (lower.contains("root") && lower.contains("privileges"))
}

// ─── Commands ──────────────────────────────────────────────────────────────

const OVERVIEW_CMD: &str = r#"
echo "__UNAME__"; uname -s 2>/dev/null;
echo "__KERNEL__"; uname -r 2>/dev/null;
echo "__OSRELEASE__"; cat /etc/os-release 2>/dev/null || echo "";
echo "__LOAD__"; cat /proc/loadavg 2>/dev/null || echo "__NO_LOAD__";
echo "__NPROC__"; nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "1";
echo "__MEM__"; free -b 2>/dev/null || echo "__NO_FREE__";
echo "__DISK__"; df -kP 2>/dev/null || df -k 2>/dev/null || echo "__NO_DF__";
echo "__UPTIME__"; cat /proc/uptime 2>/dev/null | cut -d' ' -f1 || echo "0";
echo "__HOSTNAME__"; hostname 2>/dev/null || echo "unknown";
if [ -e /proc/stat ]; then
  echo "__CPU1__"; grep '^cpu ' /proc/stat | head -1;
  sleep 0.5;
  echo "__CPU2__"; grep '^cpu ' /proc/stat | head -1;
fi
"#;

fn parse_os_name(line: &str) -> String {
    if let Some(eq) = line.find('=') {
        let v = line[eq + 1..].trim().to_string();
        v.trim_matches('"').to_string()
    } else {
        line.trim().to_string()
    }
}

fn parse_loadavg(out: &str) -> (Option<f64>, Option<f64>, Option<f64>) {
    let mut parts = out.split_whitespace();
    let l1 = parts.next().and_then(|p| p.parse().ok());
    let l5 = parts.next().and_then(|p| p.parse().ok());
    let l15 = parts.next().and_then(|p| p.parse().ok());
    (l1, l5, l15)
}

/// Parse `free -b` output (Linux) into (total, used, available) for the Mem
/// line and (total, used) for Swap. Values are raw bytes. The `available`
/// column only exists when the header declares it (GNU free ≥ 3.3); BusyBox
/// omits it, so we fall back to `total - free`.
fn parse_free_bytes(out: &str) -> ((u64, u64, u64), (u64, u64)) {
    let mut mem = (0u64, 0u64, 0u64);
    let mut swap = (0u64, 0u64);
    let has_available = out.lines().next().map_or(false, |h| h.to_lowercase().contains("available"));
    for line in out.lines().skip(1) {
        if let Some(rest) = line.strip_prefix("Mem:") {
            let nums: Vec<u64> = rest.split_whitespace().filter_map(|p| p.parse().ok()).collect();
            let total = nums.first().copied().unwrap_or(0);
            let used = nums.get(1).copied().unwrap_or(0);
            let available = if has_available {
                nums.last().copied().unwrap_or(0)
            } else {
                total.saturating_sub(nums.get(2).copied().unwrap_or(0))
            };
            mem = (total, used, available);
        } else if let Some(rest) = line.strip_prefix("Swap:") {
            let nums: Vec<u64> = rest.split_whitespace().filter_map(|p| p.parse().ok()).collect();
            swap = (nums.first().copied().unwrap_or(0), nums.get(1).copied().unwrap_or(0));
        }
    }
    (mem, swap)
}

/// Parse one `df -kP` (or BSD/Mac `df -k`) line into a DiskInfo.
fn parse_disk_line(line: &str) -> Option<DiskInfo> {
    let mut parts = line.split_whitespace();
    let filesystem = parts.next()?;
    let size_kb = parts.next()?.parse().ok()?;
    let used_kb = parts.next()?.parse().ok()?;
    let avail_kb = parts.next()?.parse().ok()?;
    let capacity = parts.next()?;
    let use_pct = capacity.trim_end_matches('%').parse().ok()?;
    let mounted_on: Vec<&str> = parts.collect();
    if mounted_on.is_empty() {
        return None;
    }
    Some(DiskInfo {
        filesystem: filesystem.to_string(),
        size_kb,
        used_kb,
        avail_kb,
        use_pct,
        mounted_on: mounted_on.join(" "),
    })
}

fn is_header_line(line: &str) -> bool {
    let line = line.trim_start();
    line.starts_with("Filesystem")
        || line.starts_with("Name")
        || line.to_lowercase().contains("capacity")
        // macOS `df` header
        || line.split_whitespace().next().map_or(false, |f| f == "Filesystem")
}

fn parse_uptime(out: &str) -> u64 {
    // /proc/uptime → "1234.56 987.65"
    out.split_whitespace()
        .next()
        .and_then(|p| p.parse::<f64>().ok())
        .map(|s| s as u64)
        .unwrap_or(0)
}

fn parse_cpu_usage(s1: &str, s2: &str) -> Option<f64> {
    let parse = |s: &str| -> Option<[u64; 4]> {
        let mut nums = s.split_whitespace().skip(1).take(4).map(|p| p.parse::<u64>().ok());
        let a = nums.next()??;
        let b = nums.next()??;
        let c = nums.next()??;
        let d = nums.next()??;
        Some([a, b, c, d])
    };
    let p1 = parse(s1)?;
    let p2 = parse(s2)?;
    let busy1 = p1[0] + p1[1] + p1[2];
    let busy2 = p2[0] + p2[1] + p2[2];
    let total1 = busy1 + p1[3];
    let total2 = busy2 + p2[3];
    let dtotal = total2.saturating_sub(total1);
    let dbusy = busy2.saturating_sub(busy1);
    if dtotal == 0 {
        return Some(0.0);
    }
    Some((dbusy as f64 / dtotal as f64) * 100.0)
}

/// Basic CPU usage for macOS/BusyBox-free hosts: derive from `top`-style output
/// unavailable here, so return None (frontend renders an unknown state).
fn parse_sections(out: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let mut current: Option<String> = None;
    for line in out.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("__") && trimmed.ends_with("__") {
            let key = trimmed.trim_start_matches("__").trim_end_matches("__").to_string();
            current = Some(key.clone());
            map.entry(key).or_insert_with(String::new);
            continue;
        }
        if let Some(key) = &current {
            let entry = map.entry(key.clone()).or_default();
            if !entry.is_empty() {
                entry.push('\n');
            }
            entry.push_str(line);
        }
    }
    map
}

async fn build_overview(handle: SshHandle) -> Result<SystemOverview, ToolsError> {
    let raw = exec::ssh_exec_str_checked(handle.clone(), OVERVIEW_CMD).await?;
    let sections = parse_sections(&raw);
    let is_linux = sections.get("UNAME").map_or("", |s| s.trim()).starts_with("Linux");

    let hostname = sections.get("HOSTNAME").map_or("unknown".into(), |s| s.trim().to_string());

    let os_name = sections
        .get("OSRELEASE")
        .and_then(|s| s.lines().find(|l| l.contains("PRETTY_NAME")))
        .map(parse_os_name)
        .unwrap_or_else(|| {
            if is_linux {
                "Linux".into()
            } else {
                "macOS/BSD".into()
            }
        });

    let kernel = sections.get("KERNEL").map_or(String::new(), |s| s.trim().to_string());

    let (load_1, load_5, load_15) = sections
        .get("LOAD")
        .map(|s| {
            let v = s.trim().lines().next().unwrap_or_default();
            if v.contains("NO_LOAD") {
                (None, None, None)
            } else {
                parse_loadavg(v)
            }
        })
        .unwrap_or((None, None, None));

    let cpu_cores = sections
        .get("NPROC")
        .and_then(|s| s.trim().lines().next())
        .and_then(|v| v.trim().parse().ok());

    let cpu_usage_pct = if let (Some(c1), Some(c2)) = (sections.get("CPU1"), sections.get("CPU2")) {
        let l1 = c1.lines().next().unwrap_or_default().trim();
        let l2 = c2.lines().next().unwrap_or_default().trim();
        parse_cpu_usage(l1, l2)
    } else {
        None
    };

    let (mem, swap) = sections
        .get("MEM")
        .map(|s| {
            let first_nonempty = s.lines().find(|l| !l.trim().is_empty()).unwrap_or_default();
            if first_nonempty.contains("NO_FREE") {
                ((0, 0, 0), (0, 0))
            } else {
                parse_free_bytes(s)
            }
        })
        .unwrap_or(((0, 0, 0), (0, 0)));

    // On macOS (no /proc), derive memory from `sysctl` when free is missing.
    let (mem_total, mem_used, mem_available, swap_total, swap_used) = if mem.0 == 0 && !is_linux {
        let total = macos_mem_total(handle.clone()).await?;
        (total, total / 3, total * 2 / 3, swap.0, swap.1)
    } else {
        (mem.0, mem.1, mem.2, swap.0, swap.1)
    };

    let uptime_secs = sections
        .get("UPTIME")
        .map(|s| parse_uptime(s.trim()))
        .unwrap_or(0);

    let disks = sections
        .get("DISK")
        .map(|s| {
            s.lines()
                .filter(|l| !is_header_line(l))
                .filter_map(parse_disk_line)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(SystemOverview {
        hostname,
        os_name,
        kernel,
        load_1,
        load_5,
        load_15,
        cpu_cores,
        cpu_usage_pct,
        mem_total_bytes: mem_total,
        mem_used_bytes: mem_used,
        mem_available_bytes: mem_available,
        swap_total_bytes: swap_total,
        swap_used_bytes: swap_used,
        uptime_secs,
        disks,
        is_linux,
    })
}

/// Best-effort total RAM on macOS; 0 when the sysctl is unavailable.
async fn macos_mem_total(handle: SshHandle) -> Result<u64, ToolsError> {
    let out = exec::ssh_exec_str_checked(handle, "sysctl -n hw.memsize 2>/dev/null || echo 0").await?;
    Ok(out.trim().parse().unwrap_or(0))
}

// ─── Tauri commands ─────────────────────────────────────────────────────────

/// Gather system overview. Cached for `overview_ttl_secs` (default 6s).
#[tauri::command]
#[instrument(skip(ssh, tools))]
pub async fn system_overview(
    session_id: String,
    overview_ttl_secs: Option<u64>,
    ssh: State<'_, SshManager>,
    tools: State<'_, Arc<ToolsManager>>,
) -> Result<SystemOverview, ToolsError> {
    let key = format!("{session_id}:system:overview");
    let ttl = overview_ttl_secs.unwrap_or(6);
    if let Some(v) = tools.cached(&key, ttl) {
        if let Ok(ov) = serde_json::from_value(v) {
            return Ok(ov);
        }
    }
    let handle = ssh.get_handle(&session_id)?;
    let overview = build_overview(handle).await?;
    tools.store(&key, serde_json::to_value(&overview).unwrap_or_default());
    Ok(overview)
}

const PS_CMD: &str = "ps -eo pid,ppid,user,%cpu,%mem,rss,stat,comm 2>/dev/null || ps axo pid,ppid,user,%cpu,%mem,rss,stat,comm 2>/dev/null";

fn parse_ps_line(line: &str) -> Option<ProcessInfo> {
    let mut parts = line.split_whitespace();
    let pid = parts.next()?.parse().ok()?;
    let ppid = parts.next().and_then(|p| p.parse().ok());
    let user = parts.next()?.to_string();
    let cpu_pct = parts.next()?.trim_end_matches('%').parse().ok()?;
    let mem_pct = parts.next()?.trim_end_matches('%').parse().ok()?;
    let rss_kb = parts.next()?.parse().ok()?;
    let state = parts.next()?.to_string();
    let name = parts.next().unwrap_or("?").to_string();
    // On macOS `ps` output may have extra fields; name is the last token.
    Some(ProcessInfo {
        pid,
        ppid,
        user,
        cpu_pct,
        mem_pct,
        rss_kb,
        state,
        name,
    })
}

fn parse_ps(out: &str) -> Vec<ProcessInfo> {
    let mut procs = Vec::new();
    for line in out.lines() {
        if line.trim().is_empty() {
            continue;
        }
        // Skip header line ("PID ...")
        if line.trim_start().starts_with("PID") {
            continue;
        }
        if let Some(p) = parse_ps_line(line.trim()) {
            procs.push(p);
        }
    }
    procs
}

/// List processes. Sort + search handled client-side.
#[tauri::command]
#[instrument(skip(ssh, tools))]
pub async fn process_list(
    session_id: String,
    refresh: Option<bool>,
    ssh: State<'_, SshManager>,
    tools: State<'_, Arc<ToolsManager>>,
) -> Result<Vec<ProcessInfo>, ToolsError> {
    let key = format!("{session_id}:system:process");
    if refresh.is_none() || !refresh.unwrap_or(false) {
        if let Some(v) = tools.cached(&key, 3) {
            if let Ok(ps) = serde_json::from_value(v) {
                return Ok(ps);
            }
        }
    }
    let handle = ssh.get_handle(&session_id)?;
    let out = exec::ssh_exec_str_checked(handle, PS_CMD).await?;
    let procs = parse_ps(&out);
    tools.store(&key, serde_json::to_value(&procs).unwrap_or_default());
    Ok(procs)
}

const KILL_SIGNALS: &[&str] = &["TERM", "KILL", "HUP", "INT", "CONT", "STOP", "USR1", "USR2"];

/// Send a signal to a process. `signal` defaults to TERM and must be one of a
/// whitelist (never interpolated raw into the remote shell).
#[tauri::command]
#[instrument(skip(ssh))]
pub async fn process_kill(
    session_id: String,
    pid: u32,
    signal: Option<String>,
    ssh: State<'_, SshManager>,
) -> Result<KillResult, ToolsError> {
    let sig = signal.unwrap_or_else(|| "TERM".into());
    if !KILL_SIGNALS.contains(&sig.as_str()) {
        return Err(ToolsError::ParseError(format!("unsupported signal: {sig}")));
    }
    let handle = ssh.get_handle(&session_id)?;
    let cmd = format!("kill -{sig} {pid}");
    let (_, stderr, exit) = exec::ssh_exec(handle, &cmd).await?;
    let stderr = String::from_utf8_lossy(&stderr);
    if exit != 0 {
        let msg = stderr.trim().to_string();
        return Ok(KillResult {
            pid,
            signal: sig.clone(),
            ok: false,
            message: msg,
        });
    }
    Ok(KillResult {
        pid,
        signal: sig.clone(),
        ok: true,
        message: format!("signal {sig} sent to {pid}"),
    })
}

const SYSTEMCTL_PRESENT_CMD: &str = "command -v systemctl >/dev/null 2>&1 && echo yes || echo no";

/// Detect whether the remote uses systemd (vs SysV/macOS launchd). The
/// frontend uses this to decide whether to show the Service manager.
#[tauri::command]
#[instrument(skip(ssh, tools))]
pub async fn service_available(
    session_id: String,
    ssh: State<'_, SshManager>,
    tools: State<'_, Arc<ToolsManager>>,
) -> Result<bool, ToolsError> {
    let key = format!("{session_id}:system:service_available");
    if let Some(v) = tools.cached(&key, 60) {
        return Ok(v.as_bool().unwrap_or(false));
    }
    let handle = ssh.get_handle(&session_id)?;
    let out = exec::ssh_exec_str_checked(handle, SYSTEMCTL_PRESENT_CMD).await?;
    let ok = out.trim() == "yes";
    tools.store(&key, serde_json::Value::Bool(ok));
    Ok(ok)
}

/// List services (systemd units). Returns empty when systemctl is missing.
#[tauri::command]
#[instrument(skip(ssh, tools))]
pub async fn service_list(
    session_id: String,
    refresh: Option<bool>,
    ssh: State<'_, SshManager>,
    tools: State<'_, Arc<ToolsManager>>,
) -> Result<Vec<ServiceInfo>, ToolsError> {
    let key = format!("{session_id}:system:service_list");
    if refresh.is_none() || !refresh.unwrap_or(false) {
        if let Some(v) = tools.cached(&key, 5) {
            if let Ok(sv) = serde_json::from_value(v) {
                return Ok(sv);
            }
        }
    }
    let handle = ssh.get_handle(&session_id)?;
    let avail = exec::ssh_exec_str_checked(handle.clone(), SYSTEMCTL_PRESENT_CMD).await?;
    let services = if avail.trim() == "yes" {
        let out = exec::ssh_exec_str_checked(
            handle,
            "systemctl --no-pager --plain list-units --type=service --all --no-legend 2>/dev/null",
        )
        .await?;
        parse_systemctl_units(&out)
    } else {
        Vec::new()
    };
    tools.store(&key, serde_json::to_value(&services).unwrap_or_default());
    Ok(services)
}

fn parse_systemctl_units(out: &str) -> Vec<ServiceInfo> {
    let mut services = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let name = match parts.next() {
            Some(n) if n.ends_with(".service") => n.trim_end_matches(".service").to_string(),
            _ => continue,
        };
        let load = parts.next().unwrap_or_default().to_string();
        let active = parts.next().unwrap_or_default().to_string();
        let sub = parts.next().unwrap_or_default().to_string();
        services.push(ServiceInfo {
            name,
            load,
            active,
            sub,
        });
    }
    services
}

/// Start / stop / restart / reload / enable / disable a systemctl unit.
#[tauri::command]
#[instrument(skip(ssh))]
pub async fn service_control(
    session_id: String,
    unit: String,
    action: ServiceAction,
    ssh: State<'_, SshManager>,
) -> Result<ServiceResult, ToolsError> {
    if unit.is_empty()
        || unit.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_'))
    {
        return Err(ToolsError::ParseError("invalid unit name".into()));
    }
    let cmd = format!("systemctl {} {unit}", action.as_cmd());
    let handle = ssh.get_handle(&session_id)?;
    let (_, stderr, exit) = exec::ssh_exec(handle, &cmd).await?;
    let stderr = String::from_utf8_lossy(&stderr);
    let needs_sudo = is_permission_stderr(&stderr);
    let msg = if exit == 0 {
        format!("{} {}", action.as_cmd(), unit)
    } else {
        stderr.trim().to_string()
    };
    if exit != 0 && needs_sudo {
        return Ok(ServiceResult {
            unit,
            action,
            ok: false,
            needs_sudo: true,
            message: msg,
        });
    }
    Ok(ServiceResult {
        unit,
        action,
        ok: exit == 0,
        needs_sudo,
        message: msg,
    })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const DISK_LINUX: &str = "\
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1         41284480  21234432  17910496      55% /
devtmpfs          4049216         0   4049216       0% /dev
";

    const DISK_HEADER_NOFS: &str = "\
Name           1024-blocks      Used Available Capacity Mounted on
/dev/sda1         41284480  21234432  17910496      55% /
";

    #[test]
    fn parses_disk_linux() {
        let disks: Vec<DiskInfo> = DISK_LINUX
            .lines()
            .filter(|l| !is_header_line(l))
            .filter_map(parse_disk_line)
            .collect();
        assert_eq!(disks.len(), 2);
        assert_eq!(disks[0].mounted_on, "/");
        assert_eq!(disks[0].size_kb, 41284480);
        assert_eq!(disks[0].use_pct, 55);
    }

    #[test]
    fn parses_disk_macos_ish() {
        let disks: Vec<DiskInfo> = DISK_HEADER_NOFS
            .lines()
            .filter(|l| !is_header_line(l))
            .filter_map(parse_disk_line)
            .collect();
        assert_eq!(disks.len(), 1);
    }

    #[test]
    fn parses_free_bytes_modern() {
        let out = "\
              total        used        free      shared  buff/cache   available
Mem:       16473948    7100496     4494900      227760     4878552     8763636
Swap:      20971516          0    20971516
";
        let (mem, swap) = parse_free_bytes(out);
        assert_eq!(mem.0, 16_473_948);
        assert_eq!(mem.2, 8_763_636);
        assert_eq!(swap.0, 20_971_516);
    }

    #[test]
    fn parses_free_busybox_no_available() {
        let out = "\
              total        used        free     shared       buffers      cached
Mem:          1024        200        824          400          100          500
Swap:          512          0        512
";
        let (mem, _swap) = parse_free_bytes(out);
        assert_eq!(mem.0, 1024);
        // no `available` column → total - free
        assert_eq!(mem.2, 1024 - 824);
    }

    #[test]
    fn parses_uptime() {
        assert_eq!(parse_uptime("1234.56 987.65\n"), 1234);
        assert_eq!(parse_uptime("0"), 0);
    }

    #[test]
    fn parses_loadavg() {
        let (a, b, c) = parse_loadavg("0.42 0.51 0.39 2/410 9876");
        assert_eq!(a, Some(0.42));
        assert_eq!(b, Some(0.51));
        assert_eq!(c, Some(0.39));
    }

    #[test]
    fn cpu_usage_delta() {
        // busy: 150 → 210, total: 1000 → 1100 → 60/100 = 60%
        let s1 = "cpu  100 0 50 850";
        let s2 = "cpu  160 0 50 890";
        let pct = parse_cpu_usage(s1, s2);
        assert_eq!(pct, Some(60.0));
    }

    #[test]
    fn cpu_usage_zero_delta() {
        assert_eq!(parse_cpu_usage("cpu  100 0 50 850", "cpu  100 0 50 850"), Some(0.0));
    }

    #[test]
    fn parses_ps_lines() {
        let out = "  PID   PPID USER   %CPU %MEM  RSS STAT COMMAND\n1     0 root  0.0  0.1  1024 S    init\n";
        let procs = parse_ps(out);
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].pid, 1);
        assert_eq!(procs[0].user, "root");
        assert_eq!(procs[0].rss_kb, 1024);
        assert_eq!(procs[0].state, "S");
    }

    #[test]
    fn header_guard() {
        assert!(is_header_line("Filesystem     1024-blocks      Used Available Capacity Mounted on"));
        // ps header is handled separately in parse_ps (starts_with "PID")
        assert!(!is_header_line("/dev/sda1         41284480  21234432  17910496      55% /"));
        assert!(!is_header_line("1     0 root  0.0  0.1  1024 S    init"));
    }

    #[test]
    fn systemctl_parse() {
        let out = "\
docker.service                loaded active     running     Docker Application
sshd.service                  loaded inactive   dead        OpenBSD Secure Shell
";
        let sv = parse_systemctl_units(out);
        assert_eq!(sv.len(), 2);
        assert_eq!(sv[0].name, "docker");
        assert_eq!(sv[0].active, "active");
        assert_eq!(sv[0].sub, "running");
    }
}