//! Phase 2 — Docker Tools.
//!
//! Container / image / stats / logs management through the *existing* SSH
//! connection, following the same exec + cache + permission conventions as
//! [`super::system`]. Every command degrades gracefully: a host without the
//! docker CLI reports `available: false` instead of erroring, and permission
//! failures (user not in the `docker` group) become a friendly
//! `needs_sudo`-style response.
//!
//! Container exec shells use a real PTY on the same connection via
//! `ssh_split_exec` ([`crate::ssh::commands::ssh_split_exec`]).

use std::sync::Arc;

use serde_json::Value;
use tauri::{Emitter, State};
use tracing::instrument;

use crate::ssh::manager::SshManager;
use crate::tools::exec;

use super::{ToolsError, ToolsManager};

// ─── Data types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DockerAvailability {
    /// Docker CLI present on the remote.
    pub present: bool,
    /// Docker daemon reachable by the current user (version string).
    pub daemon: bool,
    pub client_version: Option<String>,
    pub server_version: Option<String>,
    /// True when the CLI exists but the daemon needs root/docker-group.
    pub needs_sudo: bool,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DockerContainer {
    pub id: String,
    /// Container names joined by ", " (a container can have aliases).
    pub names: String,
    pub image: String,
    pub status: String,
    /// `running`, `exited`, `paused`, `created`, …
    pub state: String,
    pub ports: String,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DockerImage {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: String,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DockerStat {
    pub container: String,
    pub name: String,
    pub cpu_pct: f64,
    pub mem_use: String,
    pub mem_pct: f64,
    pub net_io: String,
    pub block_io: String,
    pub pid_count: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DockerContainerAction {
    Start,
    Stop,
    Restart,
    Remove,
}

impl DockerContainerAction {
    fn as_cmd(&self) -> &'static str {
        match self {
            DockerContainerAction::Start => "start",
            DockerContainerAction::Stop => "stop",
            DockerContainerAction::Restart => "restart",
            DockerContainerAction::Remove => "rm --force",
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DockerActionResponse {
    pub container: String,
    pub action: DockerContainerAction,
    pub ok: bool,
    pub needs_sudo: bool,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DockerLogFrame {
    pub stream_id: String,
    pub data: String,
    /// Final frame for a stream that ended naturally.
    pub done: bool,
    pub error: Option<String>,
}

// ─── Remote commands ───────────────────────────────────────────────────────

const VERSION_CMD: &str =
    "docker version --format '{{json .}}' 2>/dev/null";

const PS_CMD: &str = "docker ps --no-trunc --format '{{json .}}' 2>/dev/null";

const PS_ALL_CMD: &str = "docker ps -a --no-trunc --format '{{json .}}' 2>/dev/null";

const IMAGES_CMD: &str = "docker images --no-trunc --format '{{json .}}' 2>/dev/null";

const STATS_CMD: &str =
    "docker stats --no-stream --no-trunc --format '{{json .}}' 2>/dev/null";

fn is_permission_stderr(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("permission denied")
        || lower.contains("requires root")
        || lower.contains("cannot connect to the docker daemon")
        || lower.contains("is the docker daemon running")
        || lower.contains("error during connect")
        || lower.contains("root privileges")
}

/// Detect whether docker works for the current user. Never errors — it exists
/// to *probe* capability, so a missing CLI or daemon is an early return, not
/// a failure.
#[tauri::command]
#[instrument(skip(ssh, tools))]
pub async fn docker_available(
    session_id: String,
    ssh: State<'_, SshManager>,
    tools: State<'_, Arc<ToolsManager>>,
) -> Result<DockerAvailability, ToolsError> {
    let key = format!("{session_id}:docker:available");
    if let Some(v) = tools.cached(&key, 30) {
        if let Ok(a) = serde_json::from_value(v) {
            return Ok(a);
        }
    }
    let handle = ssh.get_handle(&session_id)?;
    let out = exec::ssh_exec_str_checked(handle.clone(), "command -v docker").await?;
    if out.trim().is_empty() {
        let availability = DockerAvailability {
            present: false,
            daemon: false,
            client_version: None,
            server_version: None,
            needs_sudo: false,
            message: "Docker is not installed on this host.".to_string(),
        };
        tools.store(&key, serde_json::to_value(&availability).unwrap_or_default());
        return Ok(availability);
    }
    // Present — check the daemon + permissions via `docker version`.
    let (stdout, stderr, exit) = exec::ssh_exec(handle.clone(), VERSION_CMD).await?;
    let stdout_str = String::from_utf8_lossy(&stdout);
    let stderr_str = String::from_utf8_lossy(&stderr);
    let needs_sudo = exit != 0 && is_permission_stderr(&stderr_str) || stderr_str.contains("error during connect");

    let (client_version, server_version) = if exit == 0 {
        match serde_json::from_str::<serde_json::Value>(stdout_str.trim()) {
            Ok(v) => (
                v.get("Client").and_then(|c| c.get("Version")).and_then(Value::as_str).map(str::to_string),
                v.get("Server").and_then(|s| s.get("Version")).and_then(Value::as_str).map(str::to_string),
            ),
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };

    let message = if exit == 0 {
        format!(
            "OK — client {}{}",
            client_version.clone().unwrap_or_else(|| "?".into()),
            server_version
                .as_ref()
                .map(|s| format!(", server {s}"))
                .unwrap_or_default()
        )
    } else if needs_sudo {
        "Docker daemon isn't reachable — the current user needs `sudo` or membership "
            .to_string()
            + "in the `docker` group."
    } else {
        stderr_str.trim().to_string()
    };

    let availability = DockerAvailability {
        present: true,
        daemon: exit == 0,
        client_version,
        server_version,
        needs_sudo,
        message,
    };
    tools.store(&key, serde_json::to_value(&availability).unwrap_or_default());
    Ok(availability)
}

/// List containers. `all` toggles `docker ps -a`. Empty containers are
/// reported as `[]` (never an error) so the frontend doesn't need retry logic
/// for hosts that have no containers.
#[tauri::command]
#[instrument(skip(ssh, tools))]
pub async fn docker_containers(
    session_id: String,
    all: Option<bool>,
    refresh: Option<bool>,
    ssh: State<'_, SshManager>,
    tools: State<'_, Arc<ToolsManager>>,
) -> Result<Vec<DockerContainer>, ToolsError> {
    let key = format!("{session_id}:docker:containers:{}", all.unwrap_or(false));
    if refresh.is_none() || !refresh.unwrap_or(false) {
        if let Some(v) = tools.cached(&key, 5) {
            if let Ok(c) = serde_json::from_value(v) {
                return Ok(c);
            }
        }
    }
    let handle = ssh.get_handle(&session_id)?;
    let cmd = if all.unwrap_or(false) { PS_ALL_CMD } else { PS_CMD };
    let out = exec::ssh_exec_str_checked(handle, cmd).await?;
    let containers = parse_container_lines(&out);
    tools.store(&key, serde_json::to_value(&containers).unwrap_or_default());
    Ok(containers)
}

/// List local images.
#[tauri::command]
#[instrument(skip(ssh, tools))]
pub async fn docker_images(
    session_id: String,
    refresh: Option<bool>,
    ssh: State<'_, SshManager>,
    tools: State<'_, Arc<ToolsManager>>,
) -> Result<Vec<DockerImage>, ToolsError> {
    let key = format!("{session_id}:docker:images");
    if refresh.is_none() || !refresh.unwrap_or(false) {
        if let Some(v) = tools.cached(&key, 5) {
            if let Ok(i) = serde_json::from_value(v) {
                return Ok(i);
            }
        }
    }
    let handle = ssh.get_handle(&session_id)?;
    let out = exec::ssh_exec_str_checked(handle, IMAGES_CMD).await?;
    let images = parse_image_lines(&out);
    tools.store(&key, serde_json::to_value(&images).unwrap_or_default());
    Ok(images)
}

/// Live (snapshot) resource usage for running containers via `docker stats`.
#[tauri::command]
#[instrument(skip(ssh, tools))]
pub async fn docker_stats(
    session_id: String,
    refresh: Option<bool>,
    ssh: State<'_, SshManager>,
    tools: State<'_, Arc<ToolsManager>>,
) -> Result<Vec<DockerStat>, ToolsError> {
    let key = format!("{session_id}:docker:stats");
    if refresh.is_none() || !refresh.unwrap_or(false) {
        if let Some(v) = tools.cached(&key, 3) {
            if let Ok(s) = serde_json::from_value(v) {
                return Ok(s);
            }
        }
    }
    let handle = ssh.get_handle(&session_id)?;
    let out = exec::ssh_exec_str_checked(handle, STATS_CMD).await?;
    let stats = parse_stat_lines(&out);
    tools.store(&key, serde_json::to_value(&stats).unwrap_or_default());
    Ok(stats)
}

/// start / stop / restart / rm a container. Reports a friendly
/// `needs_sudo: true` when the daemon rejects the non-root user.
#[tauri::command]
#[instrument(skip(ssh))]
pub async fn docker_container_action(
    session_id: String,
    container: String,
    action: DockerContainerAction,
    ssh: State<'_, SshManager>,
) -> Result<DockerActionResponse, ToolsError> {
    if container.is_empty()
        || container
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return Err(ToolsError::ParseError("invalid container id".into()));
    }
    let cmd = format!("docker {} {container} 2>&1", action.as_cmd());
    let handle = ssh.get_handle(&session_id)?;
    let (stdout, stderr, exit) = exec::ssh_exec(handle, &cmd).await?;
    let stderr = String::from_utf8_lossy(&stderr);
    // `docker rm` prints the container id to stdout on success.
    let grouped = format!(
        "{} {}",
        String::from_utf8_lossy(&stdout).trim(),
        stderr.trim()
    );
    let needs_sudo = exit != 0 && is_permission_stderr(&grouped);
    Ok(DockerActionResponse {
        container,
        action,
        ok: exit == 0,
        needs_sudo,
        message: if exit == 0 {
            let out = String::from_utf8_lossy(&stdout).trim().to_string();
            if !out.is_empty() {
                out
            } else if !stderr.trim().is_empty() {
                format!("ok — {}", stderr.trim())
            } else {
                "ok".to_string()
            }
        } else if needs_sudo {
            "Permission denied — the current user needs `sudo` or `docker` group "
                .to_string()
                + &"membership."
        } else {
            stderr.trim().to_string()
        },
    })
}

/// Return full (non-follow) container logs.
#[tauri::command]
#[instrument(skip(ssh))]
pub async fn docker_logs(
    session_id: String,
    container: String,
    tail: Option<u32>,
    ssh: State<'_, SshManager>,
) -> Result<String, ToolsError> {
    if container.is_empty()
        || container
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return Err(ToolsError::ParseError("invalid container id".into()));
    }
    let n = tail.unwrap_or(200).clamp(1, 20_000);
    let cmd = format!("docker logs --timestamps --tail {n} {container} 2>&1");
    let handle = ssh.get_handle(&session_id)?;
    let out = exec::ssh_exec_str_checked(handle, &cmd).await?;
    Ok(out)
}

/// Stop a `docker logs -f` stream started with [`docker_logs_follow`].
#[tauri::command]
pub fn docker_logs_stop(stream_id: String, tools: State<'_, Arc<ToolsManager>>) {
    tools.stream_stop(&stream_id);
}

/// Follow a container's logs, streaming `docker_logs` events to the frontend
/// (`tools:docker-log`) as they come back. Returns immediately — the frontend
/// accumulates frames keyed by `stream_id` and calls [`docker_logs_stop`] when
/// the user toggles the viewer closed. The stream also dies with the SSH
/// session (the channel closes), so nothing leaks on disconnect.
#[tauri::command]
#[instrument(skip(ssh, tools, app), fields(session_id))]
pub async fn docker_logs_follow(
    session_id: String,
    container: String,
    tail: Option<u32>,
    ssh: State<'_, SshManager>,
    tools: State<'_, Arc<ToolsManager>>,
    app: tauri::AppHandle,
) -> Result<String, ToolsError> {
    if container.is_empty()
        || container
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return Err(ToolsError::ParseError("invalid container id".into()));
    }
    let n = tail.unwrap_or(100).clamp(1, 2000);
    let stream_id = format!("{session_id}:{container}");
    let cancel = tools.stream_token(&stream_id);

    let handle = ssh.get_handle(&session_id)?;
    let mut channel = {
        handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|e| ToolsError::ChannelError(e.to_string()))?
    };
    let cmd = format!("docker logs --timestamps --tail {n} --follow {container} 2>&1");
    channel
        .exec(true, cmd.as_bytes())
        .await
        .map_err(|e| ToolsError::ChannelError(format!("exec failed: {e}")))?;

    // Own the channel so no other tool shares this handle while following.
    let emit_app = app.clone();
    let emit_stream_id = stream_id.clone();
    let max_frame: usize = 64 * 1024;
    let stop = tokio::spawn(async move {
        let mut buf: Vec<u8> = Vec::new();
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = emit_app.emit(
                        "tools:docker-log",
                        &DockerLogFrame {
                            stream_id: emit_stream_id.clone(),
                            data: String::new(),
                            done: true,
                            error: None,
                        },
                    );
                    break;
                }
                msg = channel.wait() => {
                    match msg {
                        Some(russh::ChannelMsg::Data { data }) => buf.extend_from_slice(&data),
                        Some(russh::ChannelMsg::ExtendedData { data, .. }) => buf.extend_from_slice(&data),
                        Some(russh::ChannelMsg::Close) | Some(russh::ChannelMsg::Eof) | None => {
                            if !buf.is_empty() {
                                let _ = emit_app.emit("tools:docker-log", &DockerLogFrame {
                                    stream_id: emit_stream_id.clone(),
                                    data: String::from_utf8_lossy(&buf).into_owned(),
                                    done: false,
                                    error: None,
                                });
                                buf.clear();
                            }
                            let _ = emit_app.emit("tools:docker-log", &DockerLogFrame {
                                stream_id: emit_stream_id.clone(),
                                data: String::new(),
                                done: true,
                                error: None,
                            });
                            break;
                        }
                        _ => {}
                    }
                    // Flush in bounded chunks so the webview never receives a
                    // single unwieldy frame.
                    if buf.len() >= max_frame {
                        let chunk = buf.split_off(0);
                        let _ = emit_app.emit("tools:docker-log", &DockerLogFrame {
                            stream_id: emit_stream_id.clone(),
                            data: String::from_utf8_lossy(&chunk).into_owned(),
                            done: false,
                            error: None,
                        });
                    }
                }
            }
        }
        // Close the channel cleanly so the server knows we're done.
        let _ = channel.close().await;
    });

    drop(stop); // fire-and-forget; the token + channel close end it.
    Ok(stream_id)
}

fn parse_container_lines(out: &str) -> Vec<DockerContainer> {
    let mut containers = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            let id = v
                .get("Id")
                .or_else(|| v.get("ID"))
                .and_then(Value::as_str)
                .unwrap_or("?")
                .trim_start_matches("sha256:")
                .chars()
                .take(12)
                .collect::<String>();
            let names = v.get("Names").and_then(Value::as_array).map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(|s| s.trim_start_matches('/').to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            }).unwrap_or_default();
            let image = v.get("Image").and_then(Value::as_str).unwrap_or("?").to_string();
            let status = v.get("Status").and_then(Value::as_str).unwrap_or("?").to_string();
            let state = v.get("State").and_then(Value::as_str).unwrap_or("?").to_string();
            let ports = v.get("Ports").and_then(Value::as_str).unwrap_or("").to_string();
            let created_at = v.get("CreatedAt").and_then(Value::as_str).unwrap_or("").to_string();
            containers.push(DockerContainer {
                id,
                names,
                image,
                status,
                state,
                ports,
                created_at,
            });
        }
    }
    containers
}

fn parse_image_lines(out: &str) -> Vec<DockerImage> {
    let mut images = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            let repo = v.get("Repository").and_then(Value::as_str).unwrap_or("<none>");
            let tag = v.get("Tag").and_then(Value::as_str).unwrap_or("latest");
            // Skip the <none>:<none> dangled intermediate layers for brevity.
            if repo == "<none>" && tag == "<none>" {
                continue;
            }
            let id = v.get("ID").and_then(Value::as_str).unwrap_or("?")
                .trim_start_matches("sha256:")
                .chars().take(12).collect::<String>();
            let size = v.get("Size").and_then(Value::as_str).unwrap_or("?").to_string();
            let created_at = v.get("CreatedAt").and_then(Value::as_str).unwrap_or("").to_string();
            let full = format!("{repo}:{tag}");
            images.push(DockerImage {
                id,
                repository: repo.to_string(),
                tag: tag.to_string(),
                size: if full.ends_with(":") { "??".into() } else { size },
                created_at,
            });
        }
    }
    images
}

fn parse_stat_lines(out: &str) -> Vec<DockerStat> {
    let mut stats = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            let mem_pct = parse_pct(v.get("MemPerc"));
            let cpu_pct = parse_pct(v.get("CPUPerc"));
            let pid_count = v.get("PIDs").and_then(Value::as_str).and_then(|s| s.parse().ok()).unwrap_or(0);
            stats.push(DockerStat {
                container: v.get("Container").and_then(Value::as_str).unwrap_or("?").to_string(),
                name: v.get("Name").and_then(Value::as_str).unwrap_or("?").trim_start_matches('/').to_string(),
                cpu_pct,
                mem_pct,
                mem_use: v.get("MemUsage").and_then(Value::as_str).unwrap_or("?").to_string(),
                net_io: v.get("NetIO").and_then(Value::as_str).unwrap_or("?") .to_string(),
                block_io: v.get("BlockIO").and_then(Value::as_str).unwrap_or("?").to_string(),
                pid_count,
            });
        }
    }
    stats
}

fn parse_pct(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_str)
        .and_then(|s| s.trim_end_matches('%').parse().ok())
        .unwrap_or(0.0)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_container_line() {
        let out = r#"{"Command":"","CreatedAt":"2026-08-10 10:00:00","Id":"0123456789abcdef0123456789abcdef0deadbeef","Image":"nginx:alpine","Labels":"","LocalVolumes":"0","Mounts":"","Names":["web_1"],"Networks":"bridge","Ports":"0.0.0.0:8080->80/tcp","RunningFor":"3 hours ago","Size":"0B","State":"running","Status":"Up 3 hours"}"#;
        let parsed = parse_container_lines(out);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "0123456789ab");
        assert_eq!(parsed[0].names, "web_1");
        assert_eq!(parsed[0].image, "nginx:alpine");
        assert_eq!(parsed[0].state, "running");
        assert_eq!(parsed[0].ports, "0.0.0.0:8080->80/tcp");
    }

    #[test]
    fn parse_handles_empty_and_garbage() {
        assert!(parse_container_lines("").is_empty());
        assert!(parse_container_lines("\n\n  \n").is_empty());
        assert!(parse_container_lines("not json at all").is_empty());
    }

    #[test]
    fn parses_multiple_containers_per_line() {
        let out = "line1\nline2";
        // Each line must be valid JSON; garbage lines are skipped.
        let valid = r#"{"Id":"aabbccddeeff001122334455","Names":["x"],"Image":"i","Status":"s","State":"running","Ports":"","CreatedAt":"c"}"#;
        let parsed = parse_container_lines(&format!("{out}\n{valid}"));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "aabbccddeeff");
    }

    #[test]
    fn parses_image_skips_dangling() {
        let dangling = r#"{"ID":"sha256:1111111111112222222222223333333333334444444444445555555555556666","Repository":"<none>","Tag":"<none>","Size":"0B","CreatedAt":"c"}"#;
        let real = r#"{"ID":"sha256:9999999999998888888888887777777777776666666666665555555555554444","Repository":"nginx","Tag":"1.27","Size":"43MB","CreatedAt":"c"}"#;
        let parsed = parse_image_lines(&format!("{dangling}\n{real}"));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].repository, "nginx");
        assert_eq!(parsed[0].tag, "1.27");
        assert_eq!(parsed[0].id, "999999999999");
    }

    #[test]
    fn parses_stats() {
        let out = r#"{"BlockIO":"0B / 0B","CPUPerc":"0.13%","Container":"ab12cd34ef56","ID":"ab12cd34ef56","MemPerc":"0.21%","MemUsage":"4.051MiB / 1.941GiB","Name":"zen_hopper","NetIO":"1.2kB / 0B","PIDs":"3"}"#;
        let parsed = parse_stat_lines(out);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].container, "ab12cd34ef56");
        assert_eq!(parsed[0].name, "zen_hopper");
        assert!((parsed[0].cpu_pct - 0.13).abs() < 1e-9);
        assert!((parsed[0].mem_pct - 0.21).abs() < 1e-9);
        assert_eq!(parsed[0].pid_count, 3);
    }

    #[test]
    fn actions_map_to_cli_flags() {
        assert_eq!(DockerContainerAction::Start.as_cmd(), "start");
        assert_eq!(DockerContainerAction::Stop.as_cmd(), "stop");
        assert_eq!(DockerContainerAction::Restart.as_cmd(), "restart");
        assert_eq!(DockerContainerAction::Remove.as_cmd(), "rm --force");
    }

    #[test]
    fn permission_detection() {
        assert!(is_permission_stderr("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"));
        assert!(is_permission_stderr("Got permission denied while trying to connect to the Docker daemon socket"));
        assert!(is_permission_stderr("error during connect: This error may indicate that the docker daemon is not running"));
        assert!(!is_permission_stderr("no such container: abc"));
    }
}