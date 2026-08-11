//! Tauri commands for the tools layer.

use tauri::State;
use tracing::instrument;

use crate::ssh::manager::SshManager;

use super::exec;
use super::{ToolsError, ToolsExecOutput};

/// Run a single shell command on the remote over the existing SSH session
/// `session_id` and return its captured output.
///
/// The command is executed on a short-lived channel (no PTY). Both streams are
/// truncated at [`MAX_OUTPUT_BYTES`](super::MAX_OUTPUT_BYTES).
#[tauri::command]
#[instrument(skip(ssh), fields(session_id = %session_id))]
pub async fn tools_exec(
    session_id: String,
    command: String,
    ssh: State<'_, SshManager>,
) -> Result<ToolsExecOutput, ToolsError> {
    let handle = ssh.get_handle(&session_id)?;
    let result = exec::ssh_exec(handle, &command).await?;
    Ok(to_output(result))
}

/// Run several commands on the remote, sequentially on their own channels, and
/// return their outputs in order. Useful for batch reads (e.g. System Overview)
/// where one round-trip worth of latency matters.
#[tauri::command]
#[instrument(skip(ssh), fields(session_id = %session_id))]
pub async fn tools_exec_batch(
    session_id: String,
    commands: Vec<String>,
    ssh: State<'_, SshManager>,
) -> Result<Vec<ToolsExecOutput>, ToolsError> {
    let handle = ssh.get_handle(&session_id)?;
    let mut outputs = Vec::with_capacity(commands.len());
    for cmd in commands {
        let result = exec::ssh_exec(handle.clone(), &cmd).await?;
        outputs.push(to_output(result));
    }
    Ok(outputs)
}

fn to_output((stdout, stderr, exit_code): (Vec<u8>, Vec<u8>, i32)) -> ToolsExecOutput {
    let (stdout, stdout_truncated) = exec::cap_output(stdout);
    let (stderr, stderr_truncated) = exec::cap_output(stderr);
    ToolsExecOutput {
        stdout,
        stderr,
        exit_code,
        truncated: stdout_truncated || stderr_truncated,
    }
}