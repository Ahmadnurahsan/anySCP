//! Runtime-limited SSH exec for the plugin system.
//!
//! A stricter sibling of [`crate::tools::exec::ssh_exec`]: adds a wall-clock
//! timeout (killing the channel) and enforces `max_output_bytes` *during* the
//! read loop rather than truncating after the fact. Cap bytes only stop being
//! *stored*; the channel is still drained to its EOF so the exit status is not
//! lost, and the timeout guards against a command that never terminates.

use std::time::Duration;

use russh::ChannelMsg;

pub use crate::tools::exec::SshHandle;

use super::PluginError;

/// Run `command` and return `(stdout, stderr, exit_code, truncated)`.
///
/// - `timeout_secs`: hard wall-clock cap; on expiry the channel is dropped and
///   [`PluginError::Timeout`] returned.
/// - `max_output_bytes`: per-stream storage cap. Once exceeded, further bytes
///   are discarded and `truncated` is set true.
pub async fn ssh_exec_limited(
    handle: SshHandle,
    command: &str,
    timeout_secs: u64,
    max_output_bytes: u64,
) -> Result<(Vec<u8>, Vec<u8>, i32, bool), PluginError> {
    let mut channel = {
        let h = handle.lock().await;
        h.channel_open_session()
            .await
            .map_err(|e| PluginError::RemoteError(format!("channel open failed: {e}")))?
    };

    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| PluginError::RemoteError(format!("exec failed: {e}")))?;

    let cap = max_output_bytes as usize;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code: Option<i32> = None;
    let mut truncated = false;

    let drain = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => append_capped(&mut stdout, cap, &data, &mut truncated),
                // ext = 1 is stderr per RFC 4254 §5.2.
                ChannelMsg::ExtendedData { data, ext: 1 } => {
                    append_capped(&mut stderr, cap, &data, &mut truncated)
                }
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status as i32),
                // Eof must NOT stop the loop (exit-status follows Eof).
                ChannelMsg::Close => break,
                _ => {}
            }
        }
    };

    tokio::time::timeout(Duration::from_secs(timeout_secs), drain)
        .await
        .map_err(|_| PluginError::Timeout(timeout_secs))?;

    Ok((stdout, stderr, exit_code.unwrap_or(0), truncated))
}

fn append_capped(buf: &mut Vec<u8>, cap: usize, data: &[u8], truncated: &mut bool) {
    if buf.len() >= cap {
        *truncated = true;
        return;
    }
    let room = cap - buf.len();
    if data.len() > room {
        buf.extend_from_slice(&data[..room]);
        *truncated = true;
    } else {
        buf.extend_from_slice(data);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_streams_and_flags_truncation() {
        let mut buf = Vec::new();
        let mut truncated = false;
        append_capped(&mut buf, 8, b"hello", &mut truncated);
        assert_eq!(buf, b"hello");
        assert!(!truncated);
        append_capped(&mut buf, 8, b" world!!!", &mut truncated);
        assert_eq!(buf, b"hello wo");
        assert!(truncated);
        // Already at cap — drain keeps working, nothing stored.
        append_capped(&mut buf, 8, b"more", &mut truncated);
        assert_eq!(buf.len(), 8);
        assert!(truncated);
    }

    #[test]
    fn exact_budget_does_not_truncate() {
        let mut buf = Vec::new();
        let mut truncated = false;
        append_capped(&mut buf, 5, b"hello", &mut truncated);
        assert_eq!(buf, b"hello");
        assert!(!truncated);
    }
}