//! Remote management tools (System Overview, Process Manager, Docker, Network,
//! …). Everything runs as short-lived `exec` channels on an *existing* SSH
//! connection — there is never a second connection per tool.
//!
//! Module layout:
//! - [`exec`]: SSH exec primitives (`ssh_exec` / `ssh_exec_ok` / `ssh_exec_str`).
//! - [`commands`]: Tauri commands exposed to the frontend.
//! - [`system`]: System Overview + Process + Service Manager (Phase 1).
//! - [`docker`]: Docker management (Phase 2).
//! - [`network`]: Port scan, ping, traceroute (Phase 3).
//! - [`security`]: stub for Phase 4.

pub mod commands;
pub mod docker;
pub mod exec;
pub mod network;
pub mod system;

#[allow(dead_code)]
pub mod security;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};

/// TTL cache for `tools_exec`-derived reads, keyed per session + tool.
/// Prevents the UI (auto-refresh, tab switches) from spamming the remote with
/// back-to-back identical commands.
#[derive(Default)]
pub struct ToolsManager {
    cache: DashMap<String, CachedResult>,
    /// Cancellation tokens for in-flight streaming commands (`docker logs -f`).
    /// Keyed by stream id so the frontend can stop a follow without a session
    /// teardown. Tokens are created lazily on first use.
    stream_cancel: DashMap<String, tokio_util::sync::CancellationToken>,
}

struct CachedResult {
    payload: serde_json::Value,
    fetched_at: std::time::Instant,
}

impl ToolsManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Read a fresh-enough cached value for `key`. Returns `None` when absent
    /// or older than `ttl_secs` — caller should re-run the command.
    pub fn cached(&self, key: &str, ttl_secs: u64) -> Option<serde_json::Value> {
        let entry = self.cache.get(key)?;
        if entry.fetched_at.elapsed().as_secs() > ttl_secs {
            return None;
        }
        Some(entry.payload.clone())
    }

    /// Store (or refresh) `payload` under `key`.
    pub fn store(&self, key: &str, payload: serde_json::Value) {
        self.cache.insert(
            key.to_string(),
            CachedResult {
                payload,
                fetched_at: std::time::Instant::now(),
            },
        );
    }

    /// Drop every cached entry for `session_id` (used when a session closes so
    /// a reused UUID never serves stale data).
    pub fn invalidate(&self, session_id: &str) {
        let prefix = format!("{session_id}:");
        self.cache
            .retain(|k, _| !k.starts_with(&prefix));
        // Cancel any in-flight `docker logs -f` streams for this session.
        self.stream_cancel.retain(|k, token| {
            if k.starts_with(&format!("{session_id}:")) {
                token.cancel();
                false
            } else {
                true
            }
        });
    }

    /// Get or create the cancellation token for a streaming command.
    pub fn stream_token(&self, stream_id: &str) -> tokio_util::sync::CancellationToken {
        match self.stream_cancel.get(stream_id) {
            Some(t) => t.clone(),
            None => {
                let token = tokio_util::sync::CancellationToken::new();
                self.stream_cancel.insert(stream_id.to_string(), token.clone());
                token
            }
        }
    }

    /// Cancel and forget a streaming command (`docker_logs_stop`).
    pub fn stream_stop(&self, stream_id: &str) {
        if let Some((_, t)) = self.stream_cancel.remove(stream_id) {
            t.cancel();
        }
    }
}

/// Errors surfaced to the frontend as `{ kind, message }` — same convention as
/// `SshError` / `SftpError` / `ScpError`.
#[derive(Debug, thiserror::Error)]
#[allow(dead_code)] // some variants are reserved for later phases (docker/network)
pub enum ToolsError {
    #[error("SSH session not found: {0}")]
    SessionNotFound(String),
    #[error("Channel error: {0}")]
    ChannelError(String),
    #[error("Command failed (exit={exit_code}): {stderr}")]
    CommandFailed { exit_code: i32, stderr: String },
    #[error("Parse error: {0}")]
    ParseError(String),
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
    #[error("Output too large: {0}")]
    OutputTooLarge(String),
    #[error("Operation cancelled")]
    Cancelled,
    #[error("Remote error: {0}")]
    RemoteError(String),
}

impl Serialize for ToolsError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("ToolsError", 2)?;
        let kind = match self {
            ToolsError::SessionNotFound(_) => "session_not_found",
            ToolsError::ChannelError(_) => "channel_error",
            ToolsError::CommandFailed { .. } => "command_failed",
            ToolsError::ParseError(_) => "parse_error",
            ToolsError::PermissionDenied(_) => "permission_denied",
            ToolsError::OutputTooLarge(_) => "output_too_large",
            ToolsError::Cancelled => "cancelled",
            ToolsError::RemoteError(_) => "remote_error",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<crate::types::SshError> for ToolsError {
    fn from(e: crate::types::SshError) -> Self {
        match e {
            crate::types::SshError::SessionNotFound(id) => ToolsError::SessionNotFound(id),
            crate::types::SshError::ChannelError(msg) => ToolsError::ChannelError(msg),
            _ => ToolsError::RemoteError(e.to_string()),
        }
    }
}

/// Output of a single remote `exec`, as returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolsExecOutput {
    /// UTF-8 (lossy) stdout.
    pub stdout: String,
    /// UTF-8 (lossy) stderr.
    pub stderr: String,
    pub exit_code: i32,
    /// True when either stream was truncated at the `max_output_bytes` cap.
    pub truncated: bool,
}

/// Maximum bytes captured per stream in one `exec`. Guards the frontend against
/// runaway output (e.g. a `cat` of a huge file) and keeps the channel short.
pub const MAX_OUTPUT_BYTES: usize = 512 * 1024;
