# Tools — Technical Specification

> Ditujukan: implementer Phase 1. Berisi arsitektur, struktur data (Rust + TS), command yang dipakai, dan panduan integrasi. Berdasarkan eksplorasi codebase anySCP.

## 1. Arsitektur umum

```
Frontend (React)                 Rust (Tauri)
────────────────────             ──────────────────────────
useToolsStore ──invoke──▶  tools::commands (tools_*)
useToolsEvents ◀──emit────  tools::events  (tools:log-output dll)
                              │
                              ▼
                     tools::exec::ssh_exec(session_id handle)
                              │ get_handle(session_id)
                              ▼
                     SshManager (existing SSH connection)
```

- **Prinsip:** semua fitur tools berjalan lewat `SshManager::get_handle(session_id)` yang mengembalikan `Arc<Mutex<Handle>>` → buka channel baru per command → exec → drain. Persis pola `scp/exec.rs:27` dan `sftp/commands.rs`.
- **Kenapa bukan sesi baru:** hemat resource, cepat, dan kredensial tidak pernah keluar dari Rust (konsisten dgn arsitektur existing: Credentials never cross IPC).

## 2. Struktur file

```
src-tauri/src/tools/
  ├── mod.rs          # pub mod exec/commands/system/docker/network/security; struct ToolsManager; ToolsError
  ├── exec.rs         # ssh_exec primitive (dipindahkan/tiruan dari scp/exec.rs) + ToolsExecOutput
  ├── commands.rs     # #[tauri::command] tools_exec, tools_exec_batch
  ├── system.rs       # M1.3–M1.6: overview, process, service, cache
  ├── docker.rs       # Phase 2 (placeholder #[allow(dead_code)])
  ├── network.rs      # Phase 3 (placeholder)
  └── security.rs     # Phase 4 (placeholder)

src/
  ├── types/tools.ts
  ├── stores/tools-store.ts
  ├── hooks/use-tools-events.ts
  └── components/tools/
      ├── ToolsPage.tsx        # container tab, sub-tab navigasi
      ├── SystemOverview.tsx
      ├── ProcessManager.tsx
      ├── ServiceManager.tsx
      ├── DockerPanel.tsx      # Phase 2
      └── NetworkPanel.tsx     # Phase 3
```

## 3. Rust: exec primitive & ToolsError

`ToolsError` mengikuti konvensi `SshError/SftpError`: serde serialize `{ kind, message }`.

```rust
#[derive(Debug, thiserror::Error)]
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
}
```

`exec.rs` primitive (kopi dari `scp/exec.rs`, bedanya error type):

```rust
pub async fn ssh_exec(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    command: &str,
) -> Result<(Vec<u8>, Vec<u8>, i32), ToolsError> { ... }
```

Output struct Tauri:

```rust
#[derive(Serialize, Deserialize)]
pub struct ToolsExecOutput {
    pub stdout: String,      // lossy UTF-8
    pub stderr: String,
    pub exit_code: i32,
    pub truncated: bool,     // true bila stdout/stderr dipotong max_output_bytes
}
```

Guard: `max_output_bytes = 512 * 1024` default, truncate + set `truncated=true`.

## 4. Rust: Tauri commands

`commands.rs`:

```rust
#[tauri::command]
pub async fn tools_exec(
    session_id: String,
    command: String,
    ssh: State<'_, SshManager>,
) -> Result<ToolsExecOutput, ToolsError> {
    let handle = ssh.get_handle(&session_id).map_err(ToolsError::from)?;
    let (stdout, stderr, exit) = exec::ssh_exec(handle, &command).await?;
    Ok(ToolsExecOutput { /* truncate + convert */ })
}

#[tauri::command]
pub async fn tools_exec_batch(
    session_id: String,
    commands: Vec<String>,
    ssh: State<'_, SshManager>,
) -> Result<Vec<ToolsExecOutput>, ToolsError> { ... }
```

Registrasi di `lib.rs`:
- `mod tools;`
- `app.manage(ToolsManager::new());` di setup
- handler: `tools::commands::tools_exec, tools::commands::tools_exec_batch,`
- (M1.6) `tools::commands::tools_cache_clear,`

## 5. Data structures per feature

### 5.1 System Overview (M1.3)

Command batch (Linux):
```
cat /proc/loadavg
nproc
free -b
df -kP
cat /proc/uptime
cat /etc/os-release
uname -a
```
macOS fallback: `sysctl -n hw.ncpu`, `vm_stat`, `df -kP`, `uptime`, `sw_vers`.

```rust
#[derive(Serialize, Deserialize)]
pub struct SystemOverview {
    pub hostname: String,
    pub os_name: String,           // PRETTY_NAME os-release
    pub kernel: String,            // uname -r (fallback uname -a)
    pub load_1: f64,               // fallback 0 jika tidak tersedia
    pub load_5: f64,
    pub load_15: f64,
    pub cpu_cores: u32,
    pub cpu_model: String,
    pub mem_total_bytes: u64,
    pub mem_used_bytes: u64,
    pub mem_available_bytes: u64,
    pub swap_total_bytes: u64,
    pub swap_used_bytes: u64,
    pub uptime_secs: u64,
    pub disks: Vec<DiskInfo>,
}
#[derive(Serialize, Deserialize)]
pub struct DiskInfo {
    pub filesystem: String,
    pub size_kb: u64,
    pub used_kb: u64,
    pub avail_kb: u64,
    pub use_pct: u8,
    pub mounted_on: String,
}
```

Parsing RAM:
- `free -b`: `Mem:` line → `total used free shared buff/cache available` (kolom available bila ada, fallback `total - used`).
- mac: `vm_stat` page size × pages (free = free+inactive; used = active+occupied).

Parsing disk: `df -kP` kolom `Filesystem 1024-blocks Used Available Capacity Mounted on` → validasi header dynamic (tabel bisa bergeser), parse nomor kolom via header.

Cache key: `system:overview` TTL 5s (M1.6).

### 5.2 Process Manager (M1.4)

Command list:
```
ps -eo pid,ppid,user,%cpu,%mem,rss,stat,comm --sort=-%cpu
```
(macOS: kolom sama; `ps -axo ...`). Parser: whitespace-split → kejadian `pid,ppid,user,%cpu,%mem,rss,stat,comm`.

```rust
#[derive(Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub user: String,
    pub cpu_pct: f64,
    pub mem_pct: f64,
    pub rss_kb: u64,
    pub state: String,
    pub name: String,
}
```

Filter+sort dilakukan **di frontend** (data kecil) — backend hanya `process_list(session_id) -> Vec<ProcessInfo>`. Kalau >2000 proses baru fallback ke db (tidak perlu sekarang).

Kill:
```rust
#[tauri::command]
pub async fn process_kill(
    session_id: String, pid: u32, signal: Option<String>,
) -> Result<KillResult, ToolsError>
// cmd: kills -'TERM' <pid>  → pakai 'kill' name (daripada variabel) + quotes
pub struct KillResult { pid: u32, signal: String, ok: bool, message: String }
```

Cache: `system:process` TTL 2s.

### 5.3 Service Manager (M1.5)

Deteksi: `command -v systemctl` exit 0 → systemd else fallback `service`.

List:
```
systemctl --no-pager --plain list-units --type=service --all --no-legend
```
(parse: `name.service  load  active  sub` — gabung state `active+sub`). Fallback: `service --status-all` TBD.

```rust
#[derive(Serialize, Deserialize)]
pub struct ServiceInfo {
    pub name: String,        // docker.service
    pub load: String,
    pub active: String,      // active
    pub sub: String,         // running
}
pub enum ServiceAction { Start, Stop, Restart, Reload, Enable, Disable }
pub struct ServiceResult { pub ok: bool, pub message: String, pub needs_sudo: bool }
```

Control cmd:
```
systemctl start docker.service
systemctl restart docker.service
systemctl -s TERM stop docker.service   # atau systemctl stop
systemctl disable --now docker.service
```
stderr berisi `... Requires root / Access denied` → `ToolsError::PermissionDenied` (+ flag `needs_sudo`).

### 5.4 Docker (Phase 2 — placeholder di spek ini)

Command utama:
- detect: `docker version --format '{{.Server.Version}}'`
- list containers: `docker ps -a --format '{{json .}}'`
- images: `docker images --format '{{json .}}'`
- stats: `docker stats --no-stream --format '{{json .}}'`
- action: `docker start|stop|restart|rm <id>`
- logs follow: via streaming event `tools:log-output` (lihat §6 Events)

## 6. Streaming events (Docker logs follow, M2.3)

Pola meniru `ssh:output`:

```rust
#[derive(Clone, Serialize, Deserialize)]
pub struct ToolsLogPayload {
    pub session_id: String,
    pub channel: String,     // "docker:logs"
    pub data: Vec<u8>,
}
```

Streaming command dijalankan di `tokio::spawn`, hasil `ChannelMsg::Data` di-`emit("tools:log-output", payload)`. Stop → `ssh.close()`. 

Frontend hook:
```ts
// use-tools-events.ts — pola use-ssh-events.ts
export function useToolsLogOutput(handler: (channel: string, data: number[]) => void) { ... }
```

## 7. Frontend integration

### 7.1 Type helpers

```rust
// halaman kunci:
ssh_manager.get_handle()           // src-tauri/src/ssh/manager.rs:374
scp/exec.rs ssh_exec primitive     // src-tauri/src/scp/exec.rs:27
lib.rs invoke_handler              // src-tauri/src/lib.rs:180
SshSession split/open_pty          // src-tauri/src/ssh/session.rs:53,183
```

### 7.2 Tab type baru (M1.2)

`src/stores/tab-store.ts`:
- tambah union member: `| { type: "tools"; id: string; label: string }` → `UnifiedTab`.
- `getTabType`, `syncDomainStores` → `useToolsStore.getState().setActiveToolsSession(tab.id)`.

`src/components/layout/UnifiedTabBar.tsx`: tambah ikon (mis. `Wrench`/`Activity` dari lucide-react — sudah ada dep `lucide-react`).

`src/components/layout/AppShell.tsx`: blok render tools tab memanggil `<ToolsPage sessionId={tab.id} hostConfig={session.hostConfig} />`.

`src/components/dashboard/HostsDashboard.tsx`: fungsi `openTools(host)` — kalau session sudah ada → buka tab tools; kalau belum → `connect_saved_host_no_pty` lalu tambah tab & store. (Pola `exploreHost` line 307.)

### 7.3 Tools store (`src/stores/tools-store.ts`)

```ts
export interface ToolsSession {
  sshSessionId: string;
  label: string;
  hostConfig: HostConfig;
  activeTool: "overview" | "processes" | "services" | "docker" | "network";
  overview: SystemOverview | null;
  processes: ProcessInfo[];
  processSearch: string;
  processSort: { by: "cpu_pct" | "mem_pct" | "pid" | "name"; asc: boolean };
  services: ServiceInfo[];
  loading: boolean;
  error: string | null;
}
```
Actions: `openToolsConnection`, `closeSession`, `setActiveTool`, `refreshOverview`, `refreshProcesses`, `refreshServices`, `killProcess`, `serviceControl`.

### 7.4 Commands call (pola)

```ts
const over = await invoke<SystemOverview>("tools_exec", {
  sessionId, command,
});
```
Kelak: functional parser di backend dalam `system.rs`.

## 8. Tests

- **Rust unit tests** (inline `#[cfg(test)]`): parser `df`, `free -b`, `ps` dari fixture string (pola `scp/exec.rs:585`). Tidak perlu SSH betulan.
- **Vitest** (`src/**/*.{test,spec}.ts(x)`): mock `invoke` (pola `hosts-store.test.ts:7`), test store logic & sort/filter proses.
- **E2E** (Makefile `e2e`, `tests/e2e/`): spec tools baru menyambungkan ke sshd-pass, verify `system_overview` memunculkan disk & RAM; process list >=1 baris.

## 9. Risiko implementasi (spesifik kode)

| Risiko | Mitigasi |
|--------|----------|
| `ps` header berubah antar distro | parse berdasarkan header; sanitize whitespace |
| `free` kolom available tidak ada (BusyBox/mac) | fallback `used = total - free` |
| systemctl perlu sudo | deteksi stderr `root`/`denied` → `PermissionDenied` |
| output besar | truncate + flag `truncated` |
| session di-close saat tools jalan | setiap command re-resolve handle; return `SessionNotFound` |
| `get_handle` lock analisa | lock hanya saat `channel_open_session` (pola existing), drop before drain |