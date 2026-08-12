//! Tauri commands for the plugin system (Phase A).
//!
//! Storage lives in the `plugins` SQLite table; execution borrows the existing
//! SSH connection exactly like the tools layer. No second connection is ever
//! opened per plugin run.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::State;
use tokio::task;
use tracing::instrument;

use crate::db::{HostDb, PluginRecord};
use crate::ssh::manager::SshManager;
use crate::tools::exec::SshHandle;
use crate::tools::ToolsManager;

use super::esc;
use super::exec;
use super::manifest::{parse_manifest, Plugin};
use super::os::{self, OsFamily};
use super::{
    parse, PluginError, PluginInfo, PluginRunResult,
};

/// How install receives a manifest: a local file path or a raw URL.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PluginSource {
    Local { path: String },
    Url { url: String },
}

/// Run one plugin command against an existing SSH session.
///
/// Guards applied, in order:
/// 1. plugin must exist and be enabled,
/// 2. command must exist,
/// 3. plugin must declare support for the detected OS family,
/// 4. a run mapping must resolve (family → `linux` → `*`),
/// 5. every variable is validated (type / select options / validation regex),
/// 6. each value is shell-escaped per OS before interpolation,
/// 7. TTL cache is consulted (skipped for dangerous commands or `refresh`).
///
/// The exec itself enforces the command's clamped timeout and output cap.
#[tauri::command]
#[instrument(skip(ssh, tools, db), fields(session_id = %session_id, plugin = %plugin_id, command = %command_id))]
#[allow(clippy::too_many_arguments)] // Tauri command signatures combine all State injections
pub async fn plugin_run(
    plugin_id: String,
    command_id: String,
    session_id: String,
    variables: HashMap<String, String>,
    refresh: Option<bool>,
    ssh: State<'_, SshManager>,
    tools: State<'_, Arc<ToolsManager>>,
    db: State<'_, Arc<HostDb>>,
) -> Result<PluginRunResult, PluginError> {
    let record = load_record(&db, &plugin_id).await?;
    if !record.enabled {
        return Err(PluginError::PluginDisabled(plugin_id));
    }
    let manifest = parse_manifest(&record.manifest_json)?;
    let command = manifest
        .command(&command_id)
        .ok_or_else(|| PluginError::CommandNotFound(command_id.clone()))?;

    let handle = ssh.get_handle(&session_id)?;
    let family = detect_os_cached(&tools, &session_id, handle.clone()).await?;

    if !manifest.supports(family) {
        return Err(PluginError::UnsupportedOs(format!(
            "plugin '{}' is not supported on {}",
            manifest.id,
            family.as_str()
        )));
    }
    let Some(lines) = command.resolve_run(family) else {
        return Err(PluginError::UnsupportedOs(format!(
            "command '{}' has no run for {}",
            command.id,
            family.as_str()
        )));
    };

    let resolved = manifest.resolve_variables(command, &variables)?;

    // Cache (TTL-clamped) — never for dangerous commands, bypassed by `refresh`.
    let cache_key = format!(
        "{session_id}:plugins:{}:{}:{}",
        manifest.id,
        command.id,
        var_hash(&resolved)
    );
    let force_refresh = refresh.unwrap_or(false);
    if !command.dangerous && !force_refresh {
        if let Some(v) = tools.cached(&cache_key, command.effective_cache_ttl()) {
            if let Ok(result) = serde_json::from_value::<PluginRunResult>(v) {
                return Ok(result);
            }
        }
    }

    // One exec per resolved run mapping; lines are chained with `&&`.
    let script = interpolate(lines, family, &resolved).join(" && ");
    let (stdout, stderr, exit, truncated) = exec::ssh_exec_limited(
        handle,
        &script,
        command.effective_timeout(),
        command.effective_max_output(),
    )
    .await?;

    let stderr_str = String::from_utf8_lossy(&stderr).trim_end().to_string();
    let stdout_str = String::from_utf8_lossy(&stdout).into_owned();

    let parsed = parse::parse_stdout(stdout_str.trim_end(), &command.parser)?;
    let mut result = parse::render(
        parsed,
        command.output,
        &command.columns,
        exit,
        stderr_str.clone(),
        truncated,
        false,
        family.as_str().to_string(),
    );
    if exit != 0 {
        result.error = Some(if stderr_str.is_empty() {
            format!("exit code {exit}")
        } else {
            stderr_str
        });
    }

    if !command.dangerous && result.error.is_none() {
        if let Ok(v) = serde_json::to_value(&result) {
            tools.store(&cache_key, v);
        }
    }

    Ok(result)
}

/// Load a plugin record from the DB.
async fn load_record(db: &Arc<HostDb>, plugin_id: &str) -> Result<PluginRecord, PluginError> {
    let db = Arc::clone(db);
    let id = plugin_id.to_string();
    let record = task::spawn_blocking(move || db.get_plugin(&id))
        .await
        .map_err(|e| PluginError::IoError(format!("task panicked: {e}")))??;
    record.ok_or_else(|| PluginError::PluginNotFound(plugin_id.to_string()))
}

/// Detect the remote OS family, cached per session for 5 minutes. Re-detection
/// only happens when the cache is empty; a session is one machine, one OS.
async fn detect_os_cached(
    tools: &ToolsManager,
    session_id: &str,
    handle: SshHandle,
) -> Result<OsFamily, PluginError> {
    const TTL: u64 = 300;
    let key = format!("{session_id}:plugins:os");
    if let Some(v) = tools.cached(&key, TTL) {
        if let Ok(s) = serde_json::from_value::<String>(v) {
            if let Ok(family) = OsFamily::from_str(&s) {
                return Ok(family);
            }
        }
    }
    let family = os::detect(handle).await?;
    tools.store(&key, serde_json::to_value(family.as_str()).unwrap_or_default());
    Ok(family)
}

impl OsFamily {
    fn from_str(s: &str) -> Result<OsFamily, PluginError> {
        serde_json::from_value(serde_json::Value::String(s.to_string()))
            .map_err(|e| PluginError::ParseError(format!("bad os family {s:?}: {e}")))
    }
}

/// Replace every `{{name}}` placeholder in a command line with the OS-escaped
/// variable value. Inserted values are never re-scanned for further `{{…}}`.
fn interpolate(lines: &[String], os: OsFamily, vars: &HashMap<String, String>) -> Vec<String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}").unwrap());
    lines
        .iter()
        .map(|line| {
            re.replace_all(line, |caps: &regex::Captures<'_>| {
                let name = &caps[1];
                let value = vars.get(name).map(String::as_str).unwrap_or("");
                esc::escape_for(os, value)
            })
            .into_owned()
        })
        .collect()
}

/// Deterministic short hash of a resolved variable map, used in cache keys.
fn var_hash(vars: &HashMap<String, String>) -> String {
    let mut entries: Vec<(&String, &String)> = vars.iter().collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for (k, v) in entries {
        k.hash(&mut hasher);
        v.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

/// Install a plugin from a local file or raw URL. The manifest is parsed and
/// strictly validated against the schema *before* anything is persisted.
#[tauri::command]
#[instrument(skip(db))]
pub async fn plugin_install(
    source: PluginSource,
    db: State<'_, Arc<HostDb>>,
) -> Result<PluginInfo, PluginError> {
    let (raw, source_name) = fetch_source(source).await?;
    let manifest = parse_manifest(&raw)?;

    let record = PluginRecord {
        id: manifest.id.clone(),
        manifest_json: raw,
        enabled: true,
        source: source_name.clone(),
        installed_version: manifest.version.clone(),
        local_override_path: None,
        installed_at: String::new(), // SQLite default datetime('now')
    };

    let db_inner = Arc::clone(&db);
    task::spawn_blocking(move || db_inner.upsert_plugin(&record))
        .await
        .map_err(|e| PluginError::IoError(format!("task panicked: {e}")))??;

    // Re-read to surface the persisted installed_at timestamp.
    let stored = load_record(&db, &manifest.id).await?;
    Ok(PluginInfo {
        enabled: stored.enabled,
        source: stored.source,
        installed_version: stored.installed_version,
        installed_at: stored.installed_at,
        manifest,
    })
}

async fn fetch_source(source: PluginSource) -> Result<(String, String), PluginError> {
    match source {
        PluginSource::Local { path } => {
            let raw = tokio::fs::read_to_string(&path)
                .await
                .map_err(|e| PluginError::IoError(format!("read {path}: {e}")))?;
            Ok((raw, "local".to_string()))
        }
        PluginSource::Url { url } => {
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err(PluginError::InvalidManifest(
                    "install URL must start with http(s)://".to_string(),
                ));
            }
            let resp = tokio::time::timeout(Duration::from_secs(20), reqwest::get(&url))
                .await
                .map_err(|_| PluginError::FetchError("download timed out".into()))?
                .map_err(|e| PluginError::FetchError(e.to_string()))?;
            if !resp.status().is_success() {
                return Err(PluginError::FetchError(format!(
                    "HTTP {} while fetching {url}",
                    resp.status()
                )));
            }
            let raw = resp
                .text()
                .await
                .map_err(|e| PluginError::FetchError(e.to_string()))?;
            Ok((raw, "url".to_string()))
        }
    }
}

/// Uninstall a plugin (removes it from the database entirely).
#[tauri::command]
#[instrument(skip(db), fields(id = %plugin_id))]
pub async fn plugin_uninstall(
    plugin_id: String,
    db: State<'_, Arc<HostDb>>,
) -> Result<(), PluginError> {
    let db_inner = Arc::clone(&db);
    task::spawn_blocking(move || {
        db_inner
            .delete_plugin(&plugin_id)
            .map_err(PluginError::from)
    })
    .await
    .map_err(|e| PluginError::IoError(format!("task panicked: {e}")))?
}

/// Enable or disable a plugin. Disabled plugins stay installed but every
/// `plugin_run` is refused.
#[tauri::command]
#[instrument(skip(db), fields(id = %plugin_id, enabled = enabled))]
pub async fn plugin_enable(
    plugin_id: String,
    enabled: bool,
    db: State<'_, Arc<HostDb>>,
) -> Result<(), PluginError> {
    let db_inner = Arc::clone(&db);
    task::spawn_blocking(move || {
        db_inner
            .set_plugin_enabled(&plugin_id, enabled)
            .map_err(PluginError::from)
    })
    .await
    .map_err(|e| PluginError::IoError(format!("task panicked: {e}")))?
}

/// List installed plugins with their decoded manifests.
#[tauri::command]
#[instrument(skip(db))]
pub async fn plugin_list(db: State<'_, Arc<HostDb>>) -> Result<Vec<PluginInfo>, PluginError> {
    let db_inner = Arc::clone(&db);
    let rows = task::spawn_blocking(move || db_inner.list_plugins())
        .await
        .map_err(|e| PluginError::IoError(format!("task panicked: {e}")))??;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        match parse_manifest(&row.manifest_json) {
            Ok(manifest) => out.push(PluginInfo {
                enabled: row.enabled,
                source: row.source,
                installed_version: row.installed_version,
                installed_at: row.installed_at,
                manifest,
            }),
            Err(e) => tracing::warn!(plugin = %row.id, "skipping broken manifest: {e}"),
        }
    }
    Ok(out)
}

impl From<Plugin> for PluginInfo {
    fn from(manifest: Plugin) -> Self {
        PluginInfo {
            enabled: true,
            source: "local".into(),
            installed_version: manifest.version.clone(),
            installed_at: String::new(),
            manifest,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolation_escapes_and_rescopes_nothing() {
        let vars = HashMap::from([
            ("user".to_string(), "root".to_string()),
            ("pass".to_string(), "p';rm -rf /".to_string()),
        ]);
        let out = interpolate(
            &["user={{user}} pass={{pass}} dropped={{missing}}".to_string()],
            OsFamily::Debian,
            &vars,
        );
        assert_eq!(
            out[0],
            "user='root' pass='p'\\'';rm -rf /' dropped=''".to_string()
        );
    }

    #[test]
    fn interpolation_uses_windows_quoting() {
        let vars = HashMap::from([("name".to_string(), "a & b".to_string())]);
        let out = interpolate(&["echo {{name}}".to_string()], OsFamily::Windows, &vars);
        assert_eq!(out[0], "echo \"a & b\"");
    }

    #[test]
    fn var_hash_is_deterministic_and_order_independent() {
        let a = var_hash(&HashMap::from([("x".into(), "1".into()), ("y".into(), "2".into())]));
        let b = var_hash(&HashMap::from([("y".into(), "2".into()), ("x".into(), "1".into())]));
        assert_eq!(a, b);
        let c = var_hash(&HashMap::from([("x".into(), "1".into()), ("y".into(), "3".into())]));
        assert_ne!(a, c);
    }

    #[test]
    fn os_family_round_trip_via_string() {
        for s in ["debian", "windows", "macos", "freebsd", "unknown"] {
            let f = OsFamily::from_str(s).unwrap();
            assert_eq!(f.as_str(), s);
        }
        assert!(OsFamily::from_str("not-a-family").is_err());
    }
}