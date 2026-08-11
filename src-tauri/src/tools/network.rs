//! Phase 3 — Network Tools.
//!
//! Port scanning, service detection, ping, and traceroute over the existing
//! SSH connection. Strategy-aware: prefers `nmap` when the remote has it
//! (fast + service names), falls back to a bounded sequential `nc` probe
//! otherwise. Every probe degrades gracefully — a missing binary reports an
//! error *string* in the result rather than failing the whole tool.
//!
//! Ethics note (see ROADMAP): scanning targets other than the connected host
//! is the user's explicit choice from the UI.

use std::sync::Arc;

use tauri::State;
use tracing::instrument;

use crate::ssh::manager::SshManager;
use crate::tools::exec;

use super::{ToolsError, ToolsManager};

// ─── Data types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NetworkToolsAvailability {
    pub nmap: bool,
    pub nc: bool,
    pub ping: bool,
    pub traceroute: bool,
    pub ss: bool,
    /// True when at least one scanner (`nmap` or `nc`) is available.
    pub can_scan: bool,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PortResult {
    pub port: u16,
    /// `open`, `closed`, `filtered` — best-effort classification.
    pub state: String,
    /// Service name when the scanner reported one (`nmap`), else empty.
    pub service: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PortScanResponse {
    pub target: String,
    pub strategy: String,
    pub ports: Vec<PortResult>,
    pub duration_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PingResult {
    pub seq: u32,
    pub time_ms: Option<f64>,
    pub ttl: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PingResponse {
    pub target: String,
    pub transmitted: u32,
    pub received: u32,
    pub loss_pct: f64,
    pub rtt_min: Option<f64>,
    pub rtt_avg: Option<f64>,
    pub rtt_max: Option<f64>,
    pub replies: Vec<PingResult>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TracerouteHop {
    pub hop: u32,
    pub host: String,
    /// Per-probe RTTs; `None` for `*` (timeout) entries.
    pub rtts: Vec<Option<f64>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TracerouteResponse {
    pub target: String,
    pub hops: Vec<TracerouteHop>,
    pub error: Option<String>,
}

// ─── Availability probe ────────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(ssh, tools))]
pub async fn network_tools_available(
    session_id: String,
    ssh: State<'_, SshManager>,
    tools: State<'_, Arc<ToolsManager>>,
) -> Result<NetworkToolsAvailability, ToolsError> {
    let key = format!("{session_id}:network:available");
    if let Some(v) = tools.cached(&key, 60) {
        if let Ok(a) = serde_json::from_value(v) {
            return Ok(a);
        }
    }
    let handle = ssh.get_handle(&session_id)?;
    let cmd = "echo __NMAP__; command -v nmap || true; \
               echo __NC__; command -v nc || true; \
               echo __PING__; command -v ping || true; \
               echo __TRACEROUTE__; command -v traceroute || true; \
               echo __SS__; command -v ss || true";
    let out = exec::ssh_exec_str_checked(handle, cmd).await?;
    let mut av = NetworkToolsAvailability {
        nmap: false,
        nc: false,
        ping: false,
        traceroute: false,
        ss: false,
        can_scan: false,
        message: String::new(),
    };
    let mut section = "";
    for line in out.lines() {
        let t = line.trim();
        if let Some(s) = line.strip_prefix("__") {
            if s.contains('_') {
                section = s.trim_end_matches("__").trim_end_matches(':');
                continue;
            }
        }
        let present = !t.is_empty();
        match section {
            "NMAP" => av.nmap = present,
            "NC" => av.nc = present,
            "PING" => av.ping = present,
            "TRACEROUTE" => av.traceroute = present,
            "SS" => av.ss = present,
            _ => {}
        }
    }
    av.can_scan = av.nmap || av.nc;
    let mut detail: Vec<String> = Vec::new();
    if av.nmap {
        detail.push("nmap".into());
    }
    if av.nc {
        detail.push("nc".into());
    }
    if av.nmap || av.nc {
        if av.ping {
            detail.push("ping".into());
        }
        if av.traceroute {
            detail.push("traceroute".into());
        }
        av.message = format!("Available: {}", detail.join(", "));
    } else {
        av.message =
            "No scanner found (install nmap or netcat on the host).".to_string();
    }
    tools.store(&key, serde_json::to_value(&av).unwrap_or_default());
    Ok(av)
}

// ─── Port scanner ──────────────────────────────────────────────────────────

/// Parse "22,80,443", "1-1000", space-separated, or a mix. Caps at
/// `max_ports` (governs the sequential `nc` fallback runtime).
fn parse_ports(raw: &str, max_ports: usize) -> Result<Vec<u16>, ToolsError> {
    let mut ports: Vec<u16> = Vec::new();
    for chunk in raw.split(|c: char| c == ',' || c.is_whitespace()) {
        let chunk = chunk.trim();
        if chunk.is_empty() {
            continue;
        }
        if let Some((a, b)) = chunk.split_once('-') {
            let lo: u16 = a
                .trim()
                .parse()
                .map_err(|_| ToolsError::ParseError(format!("bad port range `{chunk}`")))?;
            let hi: u16 = b
                .trim()
                .parse()
                .map_err(|_| ToolsError::ParseError(format!("bad port range `{chunk}`")))?;
            if lo == 0 || hi < lo {
                return Err(ToolsError::ParseError(format!("bad port range `{chunk}`")));
            }
            for p in lo..=hi {
                ports.push(p);
            }
        } else {
            let p: u16 = chunk
                .parse()
                .map_err(|_| ToolsError::ParseError(format!("bad port `{chunk}`")))?;
            if p == 0 {
                return Err(ToolsError::ParseError("port 0 is invalid".into()));
            }
            ports.push(p);
        }
    }
    ports.sort_unstable();
    ports.dedup();
    if ports.is_empty() {
        return Err(ToolsError::ParseError("no ports given".into()));
    }
    if ports.len() > max_ports {
        return Err(ToolsError::ParseError(format!(
            "too many ports for the nc fallback ({}, max {max_ports}) — narrow the range or install nmap",
            ports.len()
        )));
    }
    Ok(ports)
}

#[tauri::command]
#[instrument(skip(ssh))]
pub async fn port_scan(
    session_id: String,
    target: String,
    ports: String,
    strategy: Option<String>,
    ssh: State<'_, SshManager>,
) -> Result<PortScanResponse, ToolsError> {
    if ports.trim().is_empty() {
        return Err(ToolsError::ParseError("no ports given".into()));
    }
    if target.trim().is_empty() || target.len() > 255 {
        return Err(ToolsError::ParseError("invalid target".into()));
    }
    let strategy = strategy.unwrap_or_else(|| "auto".to_string());
    let port_list = parse_ports(&ports, 200)?;

    let handle = ssh.get_handle(&session_id)?;
    let start = std::time::Instant::now();

    // Resolve availability (has nmap / nc).
    let check = exec::ssh_exec_str_checked(
        handle.clone(),
        "command -v nmap || true; command -v nc || true",
    )
    .await?;
    let has_nmap = !check.lines().nth(0).map(|l| l.trim().is_empty()).unwrap_or(true);

    let comma_ports = port_list
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(",");

    let mut response = if (strategy == "auto" && has_nmap) || strategy == "nmap" {
        if !has_nmap {
            return Err(ToolsError::RemoteError(
                "nmap strategy requested but nmap isn't installed on the host".into(),
            ));
        }
        scan_nmap(handle.clone(), &target, &comma_ports).await
    } else {
        if !has_nac(&check) {
            return Err(ToolsError::RemoteError(
                "no scanner available on the host (neither nmap nor nc)".into(),
            ));
        }
        scan_nc(handle, &target, &port_list).await
    }?;
    response.duration_ms = start.elapsed().as_millis() as u64;
    Ok(response)
}

fn has_nac(check: &str) -> bool {
    check
        .lines()
        .nth(1)
        .map(|l| !l.trim().is_empty())
        .unwrap_or(false)
}

async fn scan_nmap(handle: exec::SshHandle, target: &str, ports: &str) -> Result<PortScanResponse, ToolsError> {
    // `-sT` connect scan avoids needing root; `-Pn` skips the ICMP probe so
    // firewalled hosts still get scanned. Keep it quiet and script-friendly.
    let cmd = format!("nmap -sT -Pn --max-retries 2 --host-timeout 60 -p {ports} {target} 2>/dev/null || nmap -sT -Pn -p {ports} {target}");
    let out = exec::ssh_exec_str_checked(handle, &cmd).await?;
    let result = parse_nmap_output(&out);
    Ok(PortScanResponse {
        target: target.to_string(),
        strategy: "nmap".to_string(),
        ports: result,
        duration_ms: 0,
        error: None,
    })
}

fn parse_nmap_output(out: &str) -> Vec<PortResult> {
    let mut result = Vec::new();
    for line in out.lines() {
        let t = line.trim();
        let mut parts = t.split_whitespace();
        let head = parts.next();
        let state = parts.next();
        let service = parts.next();
        if let (Some(head), Some(state)) = (head, state) {
            if let Some(port) = head.split('/').next() {
                if let Ok(p) = port.parse::<u16>() {
                    if state == "open" || state == "closed" || state == "filtered" {
                        result.push(PortResult {
                            port: p,
                            state: state.to_string(),
                            service: service.unwrap_or("").to_string(),
                        });
                    }
                }
            }
        }
    }
    result
}

async fn scan_nc(
    handle: exec::SshHandle,
    target: &str,
    ports: &[u16],
) -> Result<PortScanResponse, ToolsError> {
    // One exec, sequential bounded probes. `||` short-circuits the message on
    // a closed port; the loop's stdout goes through a marker to avoid nc noise.
    let probe = ports
        .iter()
        .map(|p| {
            format!(
                "if echo | nc -z -w 1 {target} {p} >/dev/null 2>&1; then echo \"{p} open\"; else echo \"{p} closed\"; fi"
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    let cmd = format!("{{ {probe}; }} 2>/dev/null");
    let out = exec::ssh_exec_str_checked(handle, &cmd).await?;
    let mut result = Vec::new();
    for line in out.lines() {
        let mut parts = line.split_whitespace();
        if let (Some(port), Some(state)) = (parts.next(), parts.next()) {
            if let Ok(p) = port.parse::<u16>() {
                if state == "open" || state == "closed" {
                    result.push(PortResult {
                        port: p,
                        state: state.to_string(),
                        service: mapped_service(p).to_string(),
                    });
                }
            }
        }
    }
    Ok(PortScanResponse {
        target: target.to_string(),
        strategy: "nc".to_string(),
        ports: result,
        duration_ms: 0,
        error: None,
    })
}

/// Offline port→service map used when the scanner can't name the service.
fn mapped_service(port: u16) -> &'static str {
    match port {
        20 | 21 => "ftp",
        22 => "ssh",
        23 => "telnet",
        25 => "smtp",
        53 => "domain",
        80 => "http",
        110 => "pop3",
        111 => "rpcbind",
        139 | 445 => "microsoft-ds",
        143 => "imap",
        161 => "snmp",
        389 => "ldap",
        443 => "https",
        465 | 587 => "smtp",
        514 => "syslog",
        636 => "ldaps",
        873 => "rsync",
        993 => "imaps",
        995 => "pop3s",
        1433 => "mssql",
        1521 => "oracle",
        2049 => "nfs",
        2375 | 2376 => "docker",
        3000 => "http-alt",
        3306 => "mysql",
        3389 => "ms-wbt-server",
        5432 => "postgresql",
        5900 => "vnc",
        6379 => "redis",
        6443 => "https (k8s)",
        8080 => "http-proxy",
        8443 => "https-alt",
        8888 => "sun-answerbook",
        9090 => "prometheus",
        9200 => "elasticsearch",
        27017 => "mongod",
        _ => "",
    }
}

// ─── Ping ──────────────────────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(ssh))]
pub async fn ping_check(
    session_id: String,
    target: String,
    count: Option<u32>,
    ssh: State<'_, SshManager>,
) -> Result<PingResponse, ToolsError> {
    if target.trim().is_empty() || target.len() > 255 {
        return Err(ToolsError::ParseError("invalid target".into()));
    }
    let count = count.unwrap_or(4).clamp(1, 20);
    // Line-oriented parse with a marker line as a reliable summary source —
    // ping output differs a lot across ping implementations.
    let cmd = format!(
        r#"out=$(ping -c {count} -W 2 {target} 2>&1); echo "$out"; echo "__LOSS__"; echo "$out" | grep -oE "[0-9.]+% packet loss" | head -1; echo "__RTT__"; echo "$out" | grep -oE "= [0-9.]+/[0-9.]+/[0-9.]+" | head -1"#
    );
    let handle = ssh.get_handle(&session_id)?;
    let out = exec::ssh_exec_str_checked(handle, &cmd).await?;
    let mut replies = Vec::new();
    let mut error = None;
    let mut seq = 0u32;
    let mut transmitted = 0u32;
    let mut received = 0u32;
    let mut loss = None;
    let mut rtt = None;

    for line in out.lines() {
        let t = line.trim();
        if t.starts_with("__LOSS__") {
            continue;
        }
        if t.starts_with("__RTT__") {
            continue;
        }
        // Parse replies: "64 bytes from 1.2.3.4: icmp_seq=1 ttl=58 time=12.3 ms"
        if let Some(rest) = t.split("bytes from").nth(1) {
            let mut icmp_time_ms = None;
            let mut ttl = None;
            for part in rest.split_whitespace() {
                if let Some(v) = part.strip_prefix("icmp_seq=") {
                    seq = v.parse().unwrap_or(seq);
                }
                if let Some(v) = part.strip_prefix("time=") {
                    let v = v.trim_end_matches("ms");
                    icmp_time_ms = v.parse::<f64>().ok();
                }
                if let Some(v) = part.strip_prefix("ttl=") {
                    ttl = v.parse::<u32>().ok();
                }
            }
            replies.push(PingResult {
                seq,
                time_ms: icmp_time_ms,
                ttl,
            });
        }
        if t.contains("packets transmitted") {
            if let Some(a) = t.split_whitespace().next() {
                transmitted = a.parse().unwrap_or(0);
            }
            if let Some(b) = t
                .split("received")
                .next()
                .and_then(|s| s.split_whitespace().next_back())
            {
                received = b.trim_end_matches(',').replace("(", "").parse().unwrap_or(received);
            }
        }
        if let Some(v) = t
            .split('%')
            .next()
            .and_then(|s| s.split_whitespace().last())
            .and_then(|s| s.parse::<f64>().ok())
        {
            loss = Some(v);
        }
        if t.starts_with('=') || t.starts_with("rtt") {
            // "rtt min/avg/max/mdev = 12.345/18.901/25.456/4.123 ms"
            if let Some(r) = t.split('=').nth(1) {
                let nums = r.split('/').filter_map(|x| x.trim().parse::<f64>().ok()).collect::<Vec<_>>();
                if nums.len() >= 3 {
                    rtt = Some((nums[0], nums[1], nums[2]));
                    break;
                }
            }
        }
        if t.contains("Destination Host Unreachable")
            || t.contains("100% packet loss")
            || t.contains("network is unreachable")
        {
            error = Some(t.to_string());
        }
    }

    let loss = loss.unwrap_or({
        if transmitted > 0 {
            ((transmitted.saturating_sub(received)) as f64 / transmitted as f64) * 100.0
        } else {
            0.0
        }
    });
    // No summary line on some pings — fall back to counting replies.
    if transmitted == 0 {
        transmitted = count as u32;
        received = replies.len() as u32;
    }
    Ok(PingResponse {
        target: target.to_string(),
        transmitted,
        received,
        loss_pct: loss,
        rtt_min: rtt.map(|r| r.0),
        rtt_avg: rtt.map(|r| r.1),
        rtt_max: rtt.map(|r| r.2),
        replies,
        error,
    })
}

// ─── Traceroute ────────────────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(ssh))]
pub async fn traceroute_check(
    session_id: String,
    target: String,
    ssh: State<'_, SshManager>,
) -> Result<TracerouteResponse, ToolsError> {
    if target.trim().is_empty() || target.len() > 255 {
        return Err(ToolsError::ParseError("invalid target".into()));
    }
    // `-n` no DNS lookups (faster); `-m 15` max hops; `-w 1` per probe window.
    let cmd = format!("traceroute -n -m 15 -w 1 {target} 2>&1");
    let handle = ssh.get_handle(&session_id)?;
    let out = exec::ssh_exec_str_checked(handle, &cmd).await?;
    let mut hops = Vec::new();
    let mut error = None;
    for line in out.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("traceroute to") {
            continue;
        }
        let mut parts = t.split_whitespace();
        let hop = match parts.next().and_then(|h| h.trim_end_matches('.').parse::<u32>().ok()) {
            Some(h) => h,
            None => continue,
        };
        let mut rtts = Vec::new();
        for tok in parts {
            let tok = tok.trim();
            if tok == "*" {
                rtts.push(None);
            } else if let Some(v) = tok.trim_end_matches("ms").parse::<f64>().ok() {
                rtts.push(Some(v));
            } else if tok.contains(':') || tok.split('.').count() == 4 || !tok.is_empty() {
                // host/ip token — record nothing extra
            }
        }
        // A fully-dropped hop is normal in traceroute; nothing to record.
        hops.push(TracerouteHop {
            hop,
            host: "".to_string(),
            rtts,
        });
    }
    if hops.is_empty() {
        error = Some("No traceroute output — is `traceroute` installed?".to_string());
    }
    Ok(TracerouteResponse {
        target: target.to_string(),
        hops,
        error,
    })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_comma_ports() {
        let ports = parse_ports("22,80,443", 200).unwrap();
        assert_eq!(ports, vec![22, 80, 443]);
    }

    #[test]
    fn parses_ranges_and_dedupes() {
        let ports = parse_ports("80,80,81-83", 200).unwrap();
        assert_eq!(ports, vec![80, 81, 82, 83]);
    }

    #[test]
    fn rejects_bad_ports() {
        assert!(parse_ports("22,,443", 200).unwrap().len() == 2);
        assert!(parse_ports("0", 200).is_err());
        assert!(parse_ports("abc", 200).is_err());
        assert!(parse_ports("100-50", 200).is_err());
        assert!(parse_ports("", 200).is_err());
    }

    #[test]
    fn caps_port_count() {
        assert!(parse_ports("1-1000", 200).is_err());
        assert!(parse_ports("1-100", 200).is_ok());
    }

    #[test]
    fn service_map_is_reasonable() {
        assert_eq!(mapped_service(22), "ssh");
        assert_eq!(mapped_service(443), "https");
        assert_eq!(mapped_service(3306), "mysql");
        assert_eq!(mapped_service(12345), "");
    }

    #[test]
    fn parses_nmap_lines() {
        let out = "Starting Nmap 7.94\n80/tcp open  http\n443/tcp open  https\n22/tcp closed ssh\n9999/tcp filtered unknown\n";
        let result = parse_nmap_output(out);
        assert_eq!(result.len(), 4);
        assert_eq!(result[0].port, 80);
        assert_eq!(result[0].state, "open");
        assert_eq!(result[0].service, "http");
        assert_eq!(result[1].port, 443);
        assert_eq!(result[2].state, "closed");
        assert_eq!(result[3].state, "filtered");
    }
}