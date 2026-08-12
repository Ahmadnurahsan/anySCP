//! Remote OS detection for the plugin system.
//!
//! Mirrors the `system_overview` probe in [`crate::tools::system`] (which was
//! never meant to be callable in isolation): `uname -s` first, then
//! `/etc/os-release` on Linux. Windows remote shells (OpenSSH on Windows) don't
//! have `uname`, so a negative result falls through to a `cmd /c echo %OS%`
//! probe. The classifier lives here rather than in `tools::system` so the
//! plugin layer stays independent — everything runs through the same exec
//! primitives though.

use serde::{Deserialize, Serialize};

use super::exec::ssh_exec_limited;
use super::PluginError;

/// Supported remote OS families. `runs` keys in a plugin manifest use these
/// exact snake_case strings, plus the coarse `"linux"` and catch-all `"*"`
/// fallbacks (handled by [`PluginCommand::resolve_run`](super::manifest::PluginCommand::resolve_run)).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OsFamily {
    Debian,
    Rhel,
    Arch,
    Suse,
    Alpine,
    Windows,
    Macos,
    #[serde(rename = "freebsd")]
    FreeBSD,
    /// Linux but not in any known family, or completely undetermined.
    Unknown,
}

impl OsFamily {
    pub fn as_str(&self) -> &'static str {
        match self {
            OsFamily::Debian => "debian",
            OsFamily::Rhel => "rhel",
            OsFamily::Arch => "arch",
            OsFamily::Suse => "suse",
            OsFamily::Alpine => "alpine",
            OsFamily::Windows => "windows",
            OsFamily::Macos => "macos",
            OsFamily::FreeBSD => "freebsd",
            OsFamily::Unknown => "unknown",
        }
    }

    /// Whether the family is a Linux derivative. `Unknown` counts as Linux so
    /// the `"linux"` fallback still applies when classification fails.
    pub fn is_linux(&self) -> bool {
        !matches!(self, OsFamily::Windows | OsFamily::Macos | OsFamily::FreeBSD)
    }

    /// Classify a Linux `/etc/os-release` `ID=...` value into a family.
    pub fn from_os_release_id(id: &str) -> OsFamily {
        match id.trim().trim_matches('"').to_lowercase().as_str() {
            "debian" | "ubuntu" | "pop" | "pop!_os" | "linuxmint" | "raspbian" | "elementary"
            | "kali" | "zorin" | "deepin" => OsFamily::Debian,
            "rhel" | "centos" | "rocky" | "alma" | "fedora" | "amzn" | "amazon" | "ol"
            | "oracle" | "almalinux" | "rockylinux" => OsFamily::Rhel,
            "arch" | "manjaro" | "endeavouros" | "cachyos" | "artix" | "archlinux" => {
                OsFamily::Arch
            }
            "sles" | "suse" | "opensuse" | "opensuse-leap" | "opensuse-tumbleweed" | "sled" => {
                OsFamily::Suse
            }
            "alpine" => OsFamily::Alpine,
            _ => OsFamily::Unknown,
        }
    }
}

/// Detect the remote OS family over an existing SSH handle.
///
/// Runs at most two cheap probes: `uname -s` (3s timeout, 4KiB cap) succeeds
/// on every POSIX host; only when it reports something empty / not-POSIX do we
/// probe Windows. The result is expected to be cached by the caller
/// ([`crate::plugins::commands::plugin_run`]) keyed per session.
pub async fn detect(handle: super::exec::SshHandle) -> Result<OsFamily, PluginError> {
    const SMALL: u64 = 4096;

    let (out, _stderr, exit, _truncated) =
        ssh_exec_limited(handle.clone(), "uname -s", 3, SMALL).await?;
    let kernel = String::from_utf8_lossy(&out).trim().to_string();

    match kernel.as_str() {
        "Linux" => {
            let (osr, _stderr, _exit, _truncated) =
                ssh_exec_limited(handle.clone(), "cat /etc/os-release 2>/dev/null || true", 4, 16384)
                    .await?;
            let os_release = String::from_utf8_lossy(&osr);
            let id = parse_os_release_id(os_release.as_ref());
            Ok(OsFamily::from_os_release_id(&id))
        }
        "Darwin" => Ok(OsFamily::Macos),
        "FreeBSD" => Ok(OsFamily::FreeBSD),
        "" if exit != 0 => {
            // Not a POSIX shell — probe Windows's `%OS%` pseudo-env var, which
            // OpenSSH-on-Windows exposes via cmd.exe.
            let (w, _stderr, _exit, _truncated) =
                ssh_exec_limited(handle, "cmd /c echo %OS%", 3, SMALL).await?;
            if String::from_utf8_lossy(&w).contains("Windows_NT") {
                Ok(OsFamily::Windows)
            } else {
                Ok(OsFamily::Unknown)
            }
        }
        _ => Ok(OsFamily::Unknown),
    }
}

fn parse_os_release_id(os_release: &str) -> String {
    os_release.lines().find_map(|l| {
        if let Some(eq) = l.find('=') {
            let key = l[..eq].trim();
            if key == "ID" {
                return Some(l[eq + 1..].trim().to_string());
            }
        }
        None
    }).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_round_trip_through_snake_case() {
        assert_eq!(OsFamily::Debian.as_str(), "debian");
        assert_eq!(OsFamily::Rhel.as_str(), "rhel");
        assert_eq!(OsFamily::Windows.as_str(), "windows");
        assert_eq!(serde_json::to_value(OsFamily::Macos).unwrap(), "macos");
        assert_eq!(
            serde_json::from_value::<OsFamily>(serde_json::json!("freebsd")).unwrap(),
            OsFamily::FreeBSD
        );
    }

    #[test]
    fn is_linux_includes_debian_and_unknown() {
        assert!(OsFamily::Debian.is_linux());
        assert!(OsFamily::Unknown.is_linux());
        assert!(!OsFamily::Windows.is_linux());
        assert!(!OsFamily::Macos.is_linux());
        assert!(!OsFamily::FreeBSD.is_linux());
    }

    #[test]
    fn classifies_common_ids() {
        assert_eq!(OsFamily::from_os_release_id("ubuntu"), OsFamily::Debian);
        assert_eq!(OsFamily::from_os_release_id("\"pop!_os\""), OsFamily::Debian);
        assert_eq!(OsFamily::from_os_release_id("centos"), OsFamily::Rhel);
        assert_eq!(OsFamily::from_os_release_id("amzn"), OsFamily::Rhel);
        assert_eq!(OsFamily::from_os_release_id("manjaro"), OsFamily::Arch);
        assert_eq!(OsFamily::from_os_release_id("opensuse-leap"), OsFamily::Suse);
        assert_eq!(OsFamily::from_os_release_id("alpine"), OsFamily::Alpine);
        assert_eq!(OsFamily::from_os_release_id("ol"), OsFamily::Rhel);
        assert_eq!(OsFamily::from_os_release_id("void"), OsFamily::Unknown);
    }

    #[test]
    fn parses_quoted_id_line() {
        let src = "NAME=\"Ubuntu 24.04\"\nID=ubuntu\nVERSION_ID=\"24.04\"\n";
        assert_eq!(parse_os_release_id(src), "ubuntu");
        let quoted = "NAME=\"Pop!_OS\"\nID=\"pop!_os\"\n";
        assert_eq!(parse_os_release_id(quoted), "\"pop!_os\"");
    }
}