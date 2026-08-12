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

/// Default registry feed for the plugin marketplace (Fase C). `registry.json`
/// in the `anyscp-plugins` repo lists every plugin and where its manifest
/// lives; raw.githubusercontent serves it as plain text (no CORS for reqwest).
pub const MARKETPLACE_REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/Ahmadnurahsan/anyscp-plugins/main/registry.json";

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

/// One row of the marketplace registry (`registry.json`). Render-only metadata
/// plus the raw manifest `url` that `plugin_install` already knows how to
/// fetch — the marketplace is just a curated index of install URLs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginMarketplaceEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub platforms: Vec<String>,
    /// Raw URL of the plugin manifest (http/https).
    pub url: String,
}

/// Minimal sanity checks for a freshly-fetched registry. Rejected blobs never
/// reach the frontend and are not cached.
pub fn validate_registry(list: &[PluginMarketplaceEntry]) -> Result<(), PluginError> {
    for e in list {
        if e.id.trim().is_empty() || e.name.trim().is_empty() || e.version.trim().is_empty() {
            return Err(PluginError::InvalidManifest(format!(
                "registry entry {:?} is missing id/name/version",
                e.id
            )));
        }
        if !(e.url.starts_with("https://") || e.url.starts_with("http://")) {
            return Err(PluginError::InvalidManifest(format!(
                "registry entry {:?} has a non-http url",
                e.id
            )));
        }
    }
    Ok(())
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
#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, url: &str) -> PluginMarketplaceEntry {
        PluginMarketplaceEntry {
            id: id.to_string(),
            name: id.to_string(),
            version: "1.0.0".to_string(),
            author: "anySCP".to_string(),
            description: None,
            icon: None,
            platforms: vec![],
            url: url.to_string(),
        }
    }

    #[test]
    fn registry_accepts_valid_entries() {
        let list = vec![
            entry("system", "https://raw.githubusercontent.com/x/y/main/plugins/system/manifest.json"),
            entry("mysql", "http://example.com/mysql.json"),
        ];
        assert!(validate_registry(&list).is_ok());
    }

    #[test]
    fn registry_rejects_empty_id() {
        let list = vec![entry("", "https://example.com/m.json")];
        assert!(matches!(
            validate_registry(&list),
            Err(PluginError::InvalidManifest(_))
        ));
    }

    #[test]
    fn registry_rejects_non_http_url() {
        let list = vec![entry("x", "file:///tmp/m.json")];
        assert!(matches!(
            validate_registry(&list),
            Err(PluginError::InvalidManifest(_))
        ));
    }

    #[test]
    fn marketplace_registry_url_is_https() {
        assert!(MARKETPLACE_REGISTRY_URL.starts_with("https://"));
    }
}
