//! Plugin system — Phase A (engine only).
//!
//! anySCP plugins are *JSON manifests*: a plugin declares OS-aware command
//! templates, variables, and an output widget. There is no executable payload,
//! so installing a plugin is safe by construction. The engine here
//!
//! - validates manifests against a strict schema (`deny_unknown_fields`),
//! - detects the remote OS family (`os`),
//! - shell-escapes every variable value before interpolation (`esc`),
//! - runs commands with hard timeout + output caps (`exec`),
//! - parses stdout into a widget-ready result (`parse`),
//! - persists installed plugins in SQLite (`db::plugins`) and exposes
//!   `plugin_run` / `plugin_install` / … (`commands`).
//!
//! Frontend widgets, the marketplace, and a starter plugin pack are later
//! phases and intentionally out of scope here.

pub mod commands;
pub mod esc;
pub mod exec;
pub mod manifest;
pub mod os;
pub mod parse;

use serde::{Deserialize, Serialize};

pub use manifest::{OutputKind, Plugin};

// ─── Policy constants ──────────────────────────────────────────────────────
// Security ceilings. Manifest values are *clamped* to these — a hostile plugin
// can never declare an unbounded timeout, cache, or output size.

/// Hard ceiling for a single exec's timeout (seconds).
pub const MAX_TIMEOUT_SECS: u64 = 120;
/// Default timeout when a command doesn't declare one.
pub const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// Default per-stream output cap.
pub const DEFAULT_MAX_OUTPUT_BYTES: u64 = 2 * 1024 * 1024;
/// Hard ceiling for per-stream output cap.
pub const MAX_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;
/// Hard ceiling for a cache TTL (seconds).
pub const MAX_CACHE_TTL_SECS: u64 = 3600;

// ─── Result types we render ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginTable {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metric {
    pub label: String,
    pub value: f64,
    pub unit: Option<String>,
}

/// Everything [`commands::plugin_run`] hands back to the frontend. Exactly one
/// of `text` / `table` / `metrics` / `json` is populated, matching `output`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRunResult {
    pub output: OutputKind,
    pub text: Option<String>,
    pub table: Option<PluginTable>,
    pub metrics: Option<Vec<Metric>>,
    pub json: Option<serde_json::Value>,
    pub exit_code: i32,
    pub stderr: String,
    pub truncated: bool,
    /// True when served from the TTL cache (never true for dangerous commands).
    pub cached: bool,
    pub os: String,
    /// Populated when `exit_code != 0` reaches the render stage.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    pub enabled: bool,
    pub source: String,
    pub installed_version: String,
    pub installed_at: String,
    pub manifest: Plugin,
}

// ─── Errors ────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
#[allow(dead_code)] // CommandFailed/OutputTooLarge/Cancelled are part of the API surface
pub enum PluginError {
    #[error("Plugin not found: {0}")]
    PluginNotFound(String),
    #[error("Plugin is disabled: {0}")]
    PluginDisabled(String),
    #[error("Command not found in plugin: {0}")]
    CommandNotFound(String),
    #[error("Not supported on this OS: {0}")]
    UnsupportedOs(String),
    #[error("SSH session not found: {0}")]
    SessionNotFound(String),
    #[error("Invalid manifest: {0}")]
    InvalidManifest(String),
    #[error("Invalid value for '{0}': {1}")]
    InvalidVariable(String, String),
    #[error("Command failed (exit={exit_code}): {stderr}")]
    CommandFailed { exit_code: i32, stderr: String },
    #[error("Command timed out after {0}s")]
    Timeout(u64),
    #[error("Output too large")]
    OutputTooLarge,
    #[error("Parse error: {0}")]
    ParseError(String),
    #[error("Operation cancelled")]
    Cancelled,
    #[error("Remote error: {0}")]
    RemoteError(String),
    #[error("IO error: {0}")]
    IoError(String),
    #[error("Fetch error: {0}")]
    FetchError(String),
}

impl Serialize for PluginError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("PluginError", 2)?;
        let kind = match self {
            PluginError::PluginNotFound(_) => "plugin_not_found",
            PluginError::PluginDisabled(_) => "plugin_disabled",
            PluginError::CommandNotFound(_) => "command_not_found",
            PluginError::UnsupportedOs(_) => "unsupported_os",
            PluginError::SessionNotFound(_) => "session_not_found",
            PluginError::InvalidManifest(_) => "invalid_manifest",
            PluginError::InvalidVariable(_, _) => "invalid_variable",
            PluginError::CommandFailed { .. } => "command_failed",
            PluginError::Timeout(_) => "timeout",
            PluginError::OutputTooLarge => "output_too_large",
            PluginError::ParseError(_) => "parse_error",
            PluginError::Cancelled => "cancelled",
            PluginError::RemoteError(_) => "remote_error",
            PluginError::IoError(_) => "io_error",
            PluginError::FetchError(_) => "fetch_error",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<crate::types::SshError> for PluginError {
    fn from(e: crate::types::SshError) -> Self {
        match e {
            crate::types::SshError::SessionNotFound(id) => PluginError::SessionNotFound(id),
            crate::types::SshError::ChannelError(msg) => PluginError::RemoteError(msg),
            _ => PluginError::RemoteError(e.to_string()),
        }
    }
}

impl From<crate::db::DbError> for PluginError {
    fn from(e: crate::db::DbError) -> Self {
        PluginError::IoError(e.to_string())
    }
}