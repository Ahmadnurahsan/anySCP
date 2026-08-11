# anySCP Tools — Roadmap & Milestones

Fitur Tools untuk anySCP: System Overview, Process Manager, Service Manager, Docker Tools, Port Scanner, dan fitur lanjutan. Tujuannya menjadikan anySCP bukan cuma SSH + SFTP + S3 client, tapi all-in-one remote management toolkit.

Semua tools berjalan **melalui existing SSH session** — tidak ada koneksi baru untuk tiap tool.

---

## Gol per fase

| Fase | Nama | Fokus Utama | Estimasi | Prioritas |
|------|------|-------------|----------|-----------|
| 1 | Foundation | System Overview + Process Manager + Service Manager | 1.5–2 minggu | Sangat Tinggi |
| 2 | Docker Tools | Docker Panel + Logs + Actions + Exec shell | 2–3 minggu | Tinggi |
| 3 | Network Tools | Port Scanner + Service Detection + Ping/TR | 2 minggu | Tinggi |
| 4 | Polish & Advanced | Vuln check, Disk visualizer, SSL checker, dsb | 2+ minggu | Sedang |

---

## Phase 1 — Foundation

> `src-tauri/src/tools/system.rs` + frontend `src/components/tools/`. Semua command via `tools_exec` dalam satu SSH session.

### Milestone 1.1 — Exec infra + modul `tools/`
**Tujuan:** Fondasi eksekusi command + registrasi Tauri.
- Task:
  - Buat modul `src-tauri/src/tools/mod.rs` dengan `ToolsError` (Serialize `{kind, message}` konvensi codebase cukup).
  - Buat `src-tauri/src/tools/exec.rs` berisi `ssh_exec` / `ssh_exec_ok` / `ssh_exec_str` (kopi dari `scp/exec.rs`) yang mengembalikan `ToolsError`.
  - Buat command `tools_exec(session_id, command) -> ToolsExecOutput {stdout, stderr, exit_code}`.
  - Registrasi di `lib.rs` `invoke_handler`.
  - Tipe Rust: `ToolsExecOutput` (Serialize/Deserialize).
- Acceptance: `pnpm tauri dev` ter-compile; `tools_exec` bisa dipanggil dari frontend (sementara dari console/Tauri invoke).

### Milestone 1.2 — Tools tab UI scaffolding
**Tujuan:** Tab "Tools" di dalam koneksi; panel kosong ber-sub-tab.
- Task:
  - TS types: `SystemOverview`, `ProcessInfo`, `ServiceInfo`, `ToolsExecOutput` di `src/types/tools.ts`.
  - Zustand store `src/stores/tools-store.ts` (state: `sshSessionId`, `hostConfig`, `label`, data per tool, loading/error).
  - Instrumen `UnifiedTab` type baru atau pendekatan sub-tab di `ExplorerPage`? **Keputusan desain:** tambahkan `type: "tools"` → `UnifiedTab`, dengan `id = sshSessionId`. Wire di `tab-store.ts` (addTab), `UnifiedTabBar` (ikon+gaya), `AppShell.tsx` (render komponen), `syncDomainStores`.
  - Entry point: tombol "Tools" di `HostsDashboard` `exploreHost`-style: `connect_saved_host_no_pty` atau reuse existing session.
- Acceptance: Tools tab terbuka, menampilkan placeholder; close tab membersihkan store.

### Milestone 1.3 — System Overview
**Tujuan:** CPU, RAM, Disk, Load, Uptime, OS.
- Task:
  - `tools/system.rs`: `system_overview(session_id) -> SystemOverview`.
  - Jalankan batch command: `cat /proc/loadavg`, `nproc`, `free -b`, `df -kP`, `cat /proc/uptime`, `cat /etc/os-release`, `uname -a`.
  - Parser robust: toleran baris parsial → `Option` fields.
  - Frontend: `SystemOverviewCard` (gauge CPU/RAM, daftar disk, load, uptime).
- Acceptance: Overview menampilkan data host target; error handling untuk baremetal tanpa /proc.

### Milestone 1.4 — Process Manager
**Tujuan:** list, search, sort, kill proses.
- Task:
  - `process_list(session_id, filter?) -> Vec<ProcessInfo>`: `ps -eo pid,ppid,user,%cpu,%mem,rss,stat,comm --sort=-%cpu`.
  - `process_kill(session_id, pid, signal?) -> KillResult`: `kill -TERM` dengan pilihan signal.
  - Frontend: tabel sortable (kolom klik), search, tombol kill dengan konfirmasi.
- Acceptance: bisa lihat proses, sort CPU/RAM, cari, kill PID.

### Milestone 1.5 — Service Manager
**Tujuan:** `systemctl status/start/stop/restart`, fallback `service`.
- Task:
  - Deteksi systemd: `command -v systemctl`.
  - `service_list`, `service_control(unit, action)`.
  - Handle permission: cek exit code + stderr (`systemctl` butuh sudo) → `ToolsError::PermissionDenied` dengan pesan jelas.
- Acceptance: list service, start/stop/restart dengan feedback.

### Milestone 1.6 — Cache & anti-spam
**Tujuan:** Hindari spam command di tiap render.
- Task:
  - Cache in-memory `DashMap<String, CachedResult>` + TTL per tool-key di `ToolsManager` (mis. overview 5s, process 2s).
  - Coalesce: saat ada request berjalan, request baru menunggu hasil yang sama (dedup via `Arc<tokio::sync::Mutex<Option<...>>>`).
- Acceptance: polling tiap 2s tidak menghasilkan >1 exec per detik.

---

## Phase 2 — Docker Tools

> `src-tauri/src/tools/docker.rs` + frontend `DockerPanel`.

### Milestone 2.1 — Docker detect & list
- `docker_available()`: `docker version --format '{{.Server.Version}}'`; deteksi permission error.
- `docker_containers(all?) -> Vec<DockerContainer>`: `docker ps -a --format json` (line-per-container, parse JSON).
- `docker_images()`: `docker images --format json`.

### Milestone 2.2 — Resource usage & actions
- `docker_stats()`: `docker stats --no-stream --format json`.
- `docker_container_action(id, action: start|stop|restart|remove)`.
- Handle permission + feedback jelas.

### Milestone 2.3 — Logs viewer (follow mode)
- `docker_logs(container, follow, tail)` → streaming event `tools:log-output` (pola `ssh:output`), atau non-follow return penuh.
- Frontend: LogViewer dengan follow toggle + stop.

### Milestone 2.4 — Exec shell ke container
- Buka tab terminal baru dengan `docker exec -it <id> sh` memakai open PTY baru pada session yang sama (pola `split_session`).

---

## Phase 3 — Network Tools

> `src-tauri/src/tools/network.rs` + frontend `NetworkPanel`.

### Milestone 3.1 — Port Scanner
- Deteksi `nmap` di remote; kalau ada pakai `nmap -sS -p <range> host`; fallback `nc -zvw` per port / `ss -tuln` untuk listening lokal.
- Opsi scan: common ports preset + custom range.
- `port_scan(target, range, strategy) -> Vec<PortResult>`.
- Hasil bisa disimpan per host (SQLite `tool_scan_results` table migration).

### Milestone 3.2 — Service Detection
- Identifikasi service dari port: `ss -tulpn` / `lsof -i` (kalau priv), banner grab `nc -w 2` bila aman.
- Map port→service umum. Balance antara akurasi & jumlah command.

### Milestone 3.3 — Ping / Traceroute
- `ping_check(target)` `ping -c 4`, `traceroute`.

---

## Phase 4 — Polish & Advanced

| Milestone | Fitur | Catatan |
|-----------|-------|---------|
| 4.1 | Disk Usage Visualizer | `du -h --max-depth=2` → treemap sederhana. |
| 4.2 | SSL Certificate Checker | `openssl s_client -connect host:port` → expiry, issuer. |
| 4.3 | Security Checklist | cek password auth SSH, root login, port berbahaya, versi paket lama. |
| 4.4 | Vuln-ish quick check | bukan vulnerability scanner penuh; hanya heuristik & banner match. |

---

## Urutan kerja yang disarankan

1. **M1.1 + M1.2** (exec infra + tab) → fondasi.
2. **M1.3 + M1.4** (Overview + Process) → windfall utama.
3. **M1.5 + M1.6** (Service + cache).
4. **Phase 2** (Docker) → paling sering diminta setelah overview.
5. **Phase 3** (Network) → port scanner.
6. Phase 4 sisanya.

---

## Risiko & Catatan

- **Permission issue** (Docker, systemctl) → intercept stderr + exit code, tampilkan `kind: "permission_denied"` + saran perbaikan.
- **Output beda-beda antar distro** → parser toleran, gunakan `command -v` untuk capability probe, jangan hardcode path.
- **Command berat / output besar** → TTL cache, truncate output, `max_output_bytes` guard.
- **Session SCP-only** (tanpa SFTP) tetap bisa dipakai tools karena berbasis exec, bukan SFTP — tapi perlu `sudo -n true` preflight bila user memakai sudo.
- **Scan etika** → port scan target default adalah host yang sedang dikonek; tambah konfirmasi untuk target lain.