//! Plugin manifest model + validation.
//!
//! A plugin is a JSON document declaring the commands it can run on a remote.
//! Everything is data — there is deliberately no executable payload — so
//! installing a plugin never grants arbitrary code execution on the *client*.
//! All user-supplied variables are validated against `type` / `validation`
//! regex and shell-escaped before reaching the remote ([`super::esc`]).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::os::OsFamily;
use super::{
    DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_SECS, MAX_CACHE_TTL_SECS, MAX_OUTPUT_BYTES,
    MAX_TIMEOUT_SECS, PluginError,
};

// ─── Small enums ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VarType {
    #[default]
    Text,
    Number,
    Select,
    Password,
    Boolean,
}

impl VarType {
    /// Type-level sanity check on a *resolved* (default-applied) value.
    /// `Select` membership and regex validation happen separately.
    pub fn validate(&self, value: &str) -> bool {
        match self {
            VarType::Text | VarType::Password => true,
            VarType::Number => value.parse::<f64>().is_ok(),
            VarType::Select => true,
            VarType::Boolean => matches!(
                value.to_lowercase().as_str(),
                "true" | "false" | "1" | "0" | "yes" | "no"
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputKind {
    #[default]
    Text,
    Table,
    Metrics,
    Json,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParserType {
    #[default]
    Raw,
    KeyValue,
    RegexTable,
    Csv,
    Json,
    Lines,
}

// ─── Manifest structs ──────────────────────────────────────────────────────
// `deny_unknown_fields` is the *import* side of the security contract: a
// manifest with typos, foreign keys, or extra nested fields is rejected at
// install time instead of being silently half-parsed.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Parser {
    pub r#type: ParserType,
    /// Used by `key_value` (default `:`).
    #[serde(default)]
    pub separator: Option<String>,
    /// Used by `regex_table` — a regex with named capture groups that become
    /// the table columns.
    #[serde(default)]
    pub pattern: Option<String>,
}

impl Default for Parser {
    fn default() -> Self {
        Self {
            r#type: ParserType::Raw,
            separator: None,
            pattern: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginVariable {
    pub name: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub r#type: VarType,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub required: bool,
    /// Optional regex the resolved value must match before the command runs.
    #[serde(default)]
    pub validation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginCommand {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    /// `true` ⇒ the frontend must confirm before running AND the result is
    /// never cached (equal to always-refresh).
    #[serde(default)]
    pub dangerous: bool,
    /// Seconds to cache the result (clamped to [`MAX_CACHE_TTL_SECS`]).
    #[serde(default)]
    pub cache_ttl: u64,
    /// Seconds before the exec is killed (clamped to [`MAX_TIMEOUT_SECS`]).
    #[serde(default)]
    pub timeout: u64,
    /// Bytes capped per output stream (clamped, default 2 MiB).
    #[serde(default)]
    pub max_output_bytes: u64,
    /// Hinted columns for `output: "table"` — most parsers derive their own.
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub variables: Vec<PluginVariable>,
    /// OS-family → command lines. Resolution order: exact family → `"linux"`
    /// (Linux families only) → `"*"`.
    pub runs: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub parser: Parser,
    pub output: OutputKind,
}

impl PluginCommand {
    pub fn effective_timeout(&self) -> u64 {
        if self.timeout == 0 {
            DEFAULT_TIMEOUT_SECS
        } else {
            self.timeout.clamp(1, MAX_TIMEOUT_SECS)
        }
    }

    pub fn effective_max_output(&self) -> u64 {
        if self.max_output_bytes == 0 {
            DEFAULT_MAX_OUTPUT_BYTES
        } else {
            self.max_output_bytes.clamp(1024, MAX_OUTPUT_BYTES)
        }
    }

    pub fn effective_cache_ttl(&self) -> u64 {
        self.cache_ttl.clamp(0, MAX_CACHE_TTL_SECS)
    }

    /// Pick the command lines for `os`, in the documented fallback order.
    pub fn resolve_run(&self, os: OsFamily) -> Option<&Vec<String>> {
        if let Some(lines) = self.runs.get(os.as_str()) {
            return if lines.is_empty() { None } else { Some(lines) };
        }
        if os.is_linux() {
            if let Some(lines) = self.runs.get("linux") {
                return if lines.is_empty() { None } else { Some(lines) };
            }
        }
        if let Some(lines) = self.runs.get("*") {
            return if lines.is_empty() { None } else { Some(lines) };
        }
        None
    }

    /// Regex-validate the resolved value for `var` (empty values skip regex).
    fn validate_value(&self, var: &PluginVariable, value: &str) -> Result<(), PluginError> {
        if !var.r#type.validate(value) {
            return Err(PluginError::InvalidVariable(
                var.name.clone(),
                format!("value does not match type {:?}", var.r#type),
            ));
        }
        if var.r#type == VarType::Select
            && !var.options.is_empty()
            && !var.options.iter().any(|o| o == value)
        {
            return Err(PluginError::InvalidVariable(
                var.name.clone(),
                format!("value not among allowed options {:#?}", var.options),
            ));
        }
        if let Some(pattern) = &var.validation {
            if !value.is_empty() {
                let re = regex::Regex::new(pattern).map_err(|e| {
                    PluginError::InvalidManifest(format!("bad validation regex for {}: {e}", var.name))
                })?;
                if !re.is_match(value) {
                    return Err(PluginError::InvalidVariable(
                        var.name.clone(),
                        format!("value does not match validation pattern {pattern:?}"),
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plugin {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    /// Allowed remote families (e.g. `["debian", "rhel"]`, coarse `"linux"`,
    /// or `"*"` for everything). Empty list = no restriction.
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub min_anyscp: Option<String>,
    pub commands: Vec<PluginCommand>,
}

impl Plugin {
    /// Whether this plugin is allowed to run on `os`.
    pub fn supports(&self, os: OsFamily) -> bool {
        if self.platforms.is_empty() {
            return true;
        }
        self.platforms.iter().any(|p| {
            p == os.as_str() || (os.is_linux() && p == "linux") || p == "*" || p == "any"
        })
    }

    /// Find a command by id.
    pub fn command(&self, id: &str) -> Option<&PluginCommand> {
        self.commands.iter().find(|c| c.id == id)
    }

    /// Build the resolved `name → value` map for a command, applying defaults,
    /// then validating type / options / regex for every declared variable.
    /// Unknown caller-supplied keys are ignored.
    pub fn resolve_variables(
        &self,
        command: &PluginCommand,
        provided: &HashMap<String, String>,
    ) -> Result<HashMap<String, String>, PluginError> {
        let mut out = HashMap::with_capacity(command.variables.len());
        for var in &command.variables {
            let raw = provided
                .get(&var.name)
                .filter(|v| !v.is_empty())
                .or(var.default.as_ref());
            match raw {
                Some(value) => {
                    command.validate_value(var, value)?;
                    out.insert(var.name.clone(), value.clone());
                }
                None if var.required => {
                    return Err(PluginError::InvalidVariable(
                        var.name.clone(),
                        "is required".to_string(),
                    ))
                }
                None => {
                    // Optional and unset — substitute an empty literal.
                    out.insert(var.name.clone(), String::new());
                }
            }
        }
        Ok(out)
    }

    // ── Validation ──────────────────────────────────────────────────────────

    #[cfg(test)]
    pub fn validate_for_test(&self) -> Result<(), PluginError> {
        self.validate()
    }

    /// Structural + semantic validation. Called at install time (before a
    /// manifest is persisted) and lazily for pre-installed manifests.
    pub fn validate(&self) -> Result<(), PluginError> {
        let reject = |msg: String| PluginError::InvalidManifest(msg);

        if self.schema_version != 1 {
            return Err(reject(format!(
                "unsupported schema_version {} (expected 1)",
                self.schema_version
            )));
        }
        if self.id.is_empty() || !self.id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
        {
            return Err(reject(format!("plugin id {:?} is invalid", self.id)));
        }
        if self.name.trim().is_empty() || self.version.trim().is_empty() || self.author.trim().is_empty()
        {
            return Err(reject("name/version/author must be non-empty".to_string()));
        }
        if self.commands.is_empty() {
            return Err(reject(format!("plugin {} declares no commands", self.id)));
        }
        for p in &self.platforms {
            if !matches!(
                p.as_str(),
                "debian" | "rhel" | "arch" | "suse" | "alpine" | "linux" | "windows" | "macos"
                    | "freebsd" | "*" | "any"
            ) {
                return Err(reject(format!("unknown platform value {p:?}")));
            }
        }
        for cmd in &self.commands {
            if cmd.id.trim().is_empty() || cmd.title.trim().is_empty() {
                return Err(reject("command id/title must be non-empty".to_string()));
            }
            if cmd.runs.is_empty() {
                return Err(reject(format!(
                    "command {:?} has no 'runs' mapping",
                    cmd.id
                )));
            }
            for (family, lines) in &cmd.runs {
                if !matches!(
                    family.as_str(),
                    "debian" | "rhel" | "arch" | "suse" | "alpine" | "linux" | "windows" | "macos"
                        | "freebsd" | "*"
                ) {
                    return Err(reject(format!(
                        "command {:?} has unknown run family {family:?}",
                        cmd.id
                    )));
                }
                if lines.is_empty() {
                    return Err(reject(format!(
                        "command {:?} run family {family:?} is empty",
                        cmd.id
                    )));
                }
                for line in lines {
                    if line.trim().is_empty() {
                        return Err(reject(format!(
                            "command {:?} run family {family:?} has an empty line",
                            cmd.id
                        )));
                    }
                }
            }
            for var in &cmd.variables {
                if var.name.trim().is_empty() {
                    return Err(reject(format!("command {:?} has a variable without a name", cmd.id)));
                }
                if var.r#type == VarType::Select && var.options.is_empty() {
                    return Err(reject(format!(
                        "command {:?} variable {:?} is a select with no options",
                        cmd.id, var.name
                    )));
                }
                if let Some(validation) = &var.validation {
                    regex::Regex::new(validation).map_err(|e| {
                        reject(format!(
                            "command {:?} variable {:?} has an invalid validation regex: {e}",
                            cmd.id, var.name
                        ))
                    })?;
                }
            }
            if cmd.parser.r#type == ParserType::RegexTable {
                let Some(pattern) = cmd.parser.pattern.as_deref() else {
                    return Err(reject(format!(
                        "command {:?} uses regex_table but has no pattern",
                        cmd.id
                    )));
                };
                let re = regex::Regex::new(pattern)
                    .map_err(|e| reject(format!("command {:?} bad pattern: {e}", cmd.id)))?;
                if re.capture_names().flatten().next().is_none() {
                    return Err(reject(format!(
                        "command {:?} regex_table pattern has no named capture groups",
                        cmd.id
                    )));
                }
            }
        }
        Ok(())
    }
}

/// Parse + validate a manifest JSON string. The single entry point used by
/// install and by lazy re-parse of stored manifests.
pub fn parse_manifest(raw: &str) -> Result<Plugin, PluginError> {
    let plugin: Plugin = serde_json::from_str(raw)
        .map_err(|e| PluginError::InvalidManifest(format!("malformed manifest: {e}")))?;
    plugin.validate()?;
    Ok(plugin)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Plugin {
        serde_json::from_str(r#"{
            "schema_version": 1,
            "id": "mysql",
            "name": "MySQL",
            "version": "1.2.0",
            "author": "community",
            "platforms": ["linux", "windows"],
            "commands": [{
                "id": "status",
                "title": "Cek status MySQL",
                "cache_ttl": 15,
                "variables": [{
                    "name": "port",
                    "label": "Port",
                    "type": "number",
                    "default": "3306",
                    "required": false,
                    "validation": "^[0-9]{1,5}$"
                }],
                "runs": {
                    "debian": ["systemctl is-active mysql"],
                    "linux": ["service mysql status"],
                    "windows": ["sc query mysql"]
                },
                "parser": { "type": "raw" },
                "output": "text"
            }]
        }"#).expect("sample parses")
    }

    #[test]
    fn sample_manifest_validates() {
        sample().validate().expect("valid");
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let raw = r#"{"schema_version":1,"id":"x","name":"X","version":"1","author":"a",
            "commands":[{"id":"c","title":"C","runs":{"*":["true"]},"output":"text"}],
            "bogus":"field"}"#;
        assert!(serde_json::from_str::<Plugin>(raw).is_err());
    }

    #[test]
    fn missing_runs_is_rejected() {
        let raw = r#"{"schema_version":1,"id":"x","name":"X","version":"1","author":"a",
            "commands":[{"id":"c","title":"C","output":"text"}]}"#;
        // `runs` is a required field — a manifest without it is rejected at
        // parse time with an InvalidManifest error.
        assert!(matches!(parse_manifest(raw), Err(PluginError::InvalidManifest(_))));
    }

    #[test]
    fn empty_runs_line_is_rejected() {
        let raw = r#"{"schema_version":1,"id":"x","name":"X","version":"1","author":"a",
            "commands":[{"id":"c","title":"C","runs":{"*":[""]},"output":"text"}]}"#;
        let plugin: Plugin = serde_json::from_str(raw).unwrap();
        assert!(matches!(plugin.validate(), Err(PluginError::InvalidManifest(_))));
    }

    #[test]
    fn parse_manifest_rejects_bad_schema_version() {
        let raw = r#"{"schema_version":2,"id":"x","name":"X","version":"1","author":"a",
            "commands":[{"id":"c","title":"C","runs":{"*":["true"]},"output":"text"}]}"#;
        assert!(matches!(parse_manifest(raw), Err(PluginError::InvalidManifest(_))));
    }

    #[test]
    fn resolve_run_falls_back_linux_then_star() {
        let p = sample();
        let cmd = p.command("status").unwrap();
        assert_eq!(cmd.resolve_run(OsFamily::Debian).unwrap()[0], "systemctl is-active mysql");
        // No "arch" key → falls back to "linux".
        assert_eq!(cmd.resolve_run(OsFamily::Arch).unwrap()[0], "service mysql status");
        // No + no linux + no star → None.
        let stripped: PluginCommand = {
            let mut c = cmd.clone();
            c.runs = [("*".into(), vec!["true".into()])].into_iter().collect();
            c
        };
        assert_eq!(stripped.resolve_run(OsFamily::Windows).unwrap()[0], "true");
        let none_cmd: PluginCommand = {
            let mut c = cmd.clone();
            c.runs = [("debian".into(), vec!["echo hi".into()])].into_iter().collect();
            c
        };
        assert!(none_cmd.resolve_run(OsFamily::Windows).is_none());
    }

    #[test]
    fn supports_linux_via_coarse_key() {
        let mut p = sample();
        p.platforms = vec!["linux".into()];
        assert!(p.supports(OsFamily::Debian));
        assert!(!p.supports(OsFamily::Windows));
        p.platforms = vec!["*".into()];
        assert!(p.supports(OsFamily::Windows));
    }

    #[test]
    fn variable_resolution_validates_and_defaults() {
        let p = sample();
        let cmd = p.command("status").unwrap();
        let vars = p.resolve_variables(cmd, &HashMap::new()).unwrap();
        assert_eq!(vars.get("port").unwrap(), "3306");
        let bad = p.resolve_variables(cmd, &HashMap::from([("port".into(), "abc".into())]));
        assert!(matches!(bad, Err(PluginError::InvalidVariable(_, _))));
        let out_of_range = p.resolve_variables(cmd, &HashMap::from([("port".into(), "99999999".into())]));
        assert!(matches!(out_of_range, Err(PluginError::InvalidVariable(_, _))));
    }

    #[test]
    fn required_variable_missing_is_rejected() {
        // A required variable with no default must fail when not supplied.
        let raw = r#"{"schema_version":1,"id":"x","name":"X","version":"1","author":"a",
            "commands":[{"id":"c","title":"C","runs":{"*":["true"]},"output":"text",
            "variables":[{"name":"rootpass","type":"text","required":true}]}]}"#;
        let p = parse_manifest(raw).expect("valid manifest");
        let err = p
            .resolve_variables(&p.commands[0], &HashMap::new())
            .unwrap_err();
        assert!(matches!(err, PluginError::InvalidVariable(_, _)));
    }

    #[test]
    fn deep_clamps() {
        let mut p = sample();
        p.commands[0].timeout = 9_999_999;
        p.commands[0].max_output_bytes = u64::MAX;
        p.commands[0].cache_ttl = 9_999_999;
        let cmd = &p.commands[0];
        assert_eq!(cmd.effective_timeout(), MAX_TIMEOUT_SECS);
        assert_eq!(cmd.effective_max_output(), MAX_OUTPUT_BYTES);
        assert_eq!(cmd.effective_cache_ttl(), MAX_CACHE_TTL_SECS);
        p.commands[0].timeout = 0;
        assert_eq!(p.commands[0].effective_timeout(), DEFAULT_TIMEOUT_SECS);
    }

    #[test]
    fn select_value_must_be_in_options() {
        let mut p = sample();
        p.commands[0].variables[0].r#type = VarType::Select;
        p.commands[0].variables[0].options = vec!["3306".into(), "3307".into()];
        p.commands[0].variables[0].validation = None;
        assert!(p.resolve_variables(&p.commands[0], &HashMap::new()).is_ok());
        let bad = p.resolve_variables(
            &p.commands[0],
            &HashMap::from([("port".into(), "9999".into())]),
        );
        assert!(matches!(bad, Err(PluginError::InvalidVariable(_, _))));
    }

    #[test]
    fn regex_table_requires_named_groups() {
        let raw = r#"{"schema_version":1,"id":"x","name":"X","version":"1","author":"a",
            "commands":[{"id":"c","title":"C","runs":{"*":["true"]},"output":"table",
            "parser":{"type":"regex_table","pattern":"^(?P<a>\\w+)-(?P<b>\\d+)$"}}]}"#;
        parse_manifest(raw).expect("valid regex_table with named groups");
        // No named capture groups at all — must be rejected by validation.
        let raw2 = r#"{"schema_version":1,"id":"x","name":"X","version":"1","author":"a",
            "commands":[{"id":"c","title":"C","runs":{"*":["true"]},"output":"table",
            "parser":{"type":"regex_table","pattern":"^(\\w+)-(\\d+)$"}}]}"#;
        let plugin: Plugin = serde_json::from_str(raw2).unwrap();
        assert!(matches!(plugin.validate(), Err(PluginError::InvalidManifest(_))));
    }
}