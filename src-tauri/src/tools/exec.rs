//! SSH exec primitives for the tools layer.
//!
//! Mirrors the SCP implementation (`scp::exec`) but returns [`ToolsError`] so
//! the tools layer doesn't depend on the SCP module. Each call opens a fresh
//! short-lived channel on the existing SSH connection: open, exec, drain, close.

use std::sync::Arc;
use tokio::sync::Mutex;

use russh::client::Handle;
use russh::ChannelMsg;

use crate::ssh::handler::SshClientHandler;

use super::{ToolsError, MAX_OUTPUT_BYTES};

pub type SshHandle = Arc<Mutex<Handle<SshClientHandler>>>;

/// Run `command` on the remote. Returns `(stdout, stderr, exit_code)`.
pub async fn ssh_exec(
    handle: SshHandle,
    command: &str,
) -> Result<(Vec<u8>, Vec<u8>, i32), ToolsError> {
    let mut channel = {
        let h = handle.lock().await;
        h.channel_open_session()
            .await
            .map_err(|e| ToolsError::ChannelError(e.to_string()))?
    };

    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| ToolsError::ChannelError(format!("exec failed: {e}")))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code: Option<i32> = None;

    while let Some(msg) = channel.wait().await {
        if fold_exec_msg(msg, &mut stdout, &mut stderr, &mut exit_code) {
            break;
        }
    }

    // Some servers close without sending ExitStatus; treat as 0 then.
    Ok((stdout, stderr, exit_code.unwrap_or(0)))
}

/// Fold one channel message into the running stdout / stderr / exit-code,
/// returning `true` when the read loop should stop.
///
/// `Eof` must NOT stop the loop: a server sends Eof (end of data) BEFORE its
/// `exit-status` request (RFC 4254 §5.3), so stopping there would discard the
/// exit code and report a failed command as success.
fn fold_exec_msg(
    msg: ChannelMsg,
    stdout: &mut Vec<u8>,
    stderr: &mut Vec<u8>,
    exit_code: &mut Option<i32>,
) -> bool {
    match msg {
        ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
        // ext = 1 is stderr per RFC 4254 §5.2.
        ChannelMsg::ExtendedData { data, ext: 1 } => stderr.extend_from_slice(&data),
        ChannelMsg::ExitStatus { exit_status } => *exit_code = Some(exit_status as i32),
        ChannelMsg::Close => return true,
        // Eof (and any other message): keep reading.
        _ => {}
    }
    false
}

#[allow(dead_code)] // used by later phases (docker, network, security)
/// Run `command` and require exit code 0. Returns stdout. Errors include
/// the captured stderr for diagnosis.
pub async fn ssh_exec_ok(handle: SshHandle, command: &str) -> Result<Vec<u8>, ToolsError> {
    let (stdout, stderr, exit) = ssh_exec(handle, command).await?;
    if exit != 0 {
        let stderr_str = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(ToolsError::CommandFailed {
            exit_code: exit,
            stderr: stderr_str,
        });
    }
    Ok(stdout)
}

#[allow(dead_code)] // used by later phases (docker, network, security)
/// As [`ssh_exec_ok`] but expects UTF-8 stdout. Trims the trailing newline.
pub async fn ssh_exec_str(handle: SshHandle, command: &str) -> Result<String, ToolsError> {
    let stdout = ssh_exec_ok(handle, command).await?;
    let mut s = String::from_utf8(stdout).map_err(|e| ToolsError::ParseError(format!("non-UTF-8 stdout: {e}")))?;
    while s.ends_with('\n') || s.ends_with('\r') {
        s.pop();
    }
    Ok(s)
}

/// [`ssh_exec_str`] that tolerates a non-zero exit code — used by probes where a
/// missing binary or file is an expected outcome (e.g. `free`, `systemctl`).
/// The result is the concatenated stdout even when the command failed.
pub async fn ssh_exec_str_checked(handle: SshHandle, command: &str) -> Result<String, ToolsError> {
    let (stdout, _stderr, _exit) = ssh_exec(handle, command).await?;
    let mut s = String::from_utf8(stdout).map_err(|e| ToolsError::ParseError(format!("non-UTF-8 stdout: {e}")))?;
    while s.ends_with('\n') || s.ends_with('\r') {
        s.pop();
    }
    Ok(s)
}

/// Convert captured bytes to a lossy string, truncating past `MAX_OUTPUT_BYTES`.
pub fn cap_output(bytes: Vec<u8>) -> (String, bool) {
    let truncated = bytes.len() > MAX_OUTPUT_BYTES;
    let mut s = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        s.truncate(MAX_OUTPUT_BYTES);
        s.push_str("\n…[output truncated]");
    }
    (s, truncated)
}
