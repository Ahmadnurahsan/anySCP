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

## Phase 2 — Docker Tools ✅ (implemented)

> `src-tauri/src/tools/docker.rs` + frontend `DockerPanel`.

### Milestone 2.1 — Docker detect & list ✅
- `docker_available()`: `docker version --format '{{.Server.Version}}'`; deteksi permission error.
- `docker_containers(all?) -> Vec<DockerContainer>`: `docker ps -a --format json` (line-per-container, parse JSON).
- `docker_images()`: `docker images --format json`.

### Milestone 2.2 — Resource usage & actions ✅
- `docker_stats()`: `docker stats --no-stream --format json`.
- `docker_container_action(id, action: start|stop|restart|remove)`.
- Handle permission + feedback jelas.

### Milestone 2.3 — Logs viewer (follow mode) ✅
- `docker_logs_follow(container, tail)` → streaming event `tools:docker-log`, cancel via `docker_logs_stop`; channel closes with the SSH session.

### Milestone 2.4 — Exec shell ke container ✅
- `ssh_split_exec` membuka PTY baru pada session yang sama untuk `docker exec -it <id> sh` → tab terminal baru.

---

## Phase 3 — Network Tools ✅ (implemented)

> `src-tauri/src/tools/network.rs` + frontend `NetworkPanel`.

### Milestone 3.1 — Port Scanner ✅
- Deteksi `nmap` di remote; kalau ada pakai `nmap -sT -Pn -p <range> host` (connect scan, tanpa root); fallback `nc -z -w 1` per port (sequential, bounded ≤200 port).
- Opsi scan: common ports preset + custom range (parsing `22,80,443` / `1-1000`).
- `port_scan(target, range, strategy) -> Vec<PortResult>`.

### Milestone 3.2 — Service Detection ✅
- Nama service dari kolom nmap, atau map offline port→service untuk fallback `nc`.

### Milestone 3.3 — Ping / Traceroute ✅
- `ping_check(target)` `ping -c N -W 2` → loss%, RTT min/avg/max, reply list.
- `traceroute_check(target)` `traceroute -n -m 15 -w 1` → hop table.

> SQLite persistence of scan results (`tool_scan_results`) ditunda — in-memory hasil scan terakhir di store.

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
---

## Plugin System (Phase A) ✅ (engine — backend only)

> `src-tauri/src/plugins/`. Plugin = **JSON manifest** (bukan kode) → aman dari arbitrary code execution; komunitas cukup menulis JSON, tanpa menyentuh Rust.
>
> Branch: `feature/plugin-system` (dibuat dari `main` setelah Phase 1–3 di-merge).

### Yang selesai (Phase A — engine)
- **`os.rs`** — `OsFamily` enum (debian/rhel/arch/suse/alpine/windows/macos/freebsd/unknown) + deteksi via `uname -s` + `/etc/os-release` (fallback `cmd /c echo %OS%` untuk Windows). Hasil di-cache per session (5 menit).
- **`manifest.rs`** — struct serde dengan `deny_unknown_fields` (field asing/typo = reject), validasi: schema_version, id/name/version/author, platform, runs (keluarga + `"linux"` fallback + `"*"`), variable type/select/regex, regex_table wajib named groups. Clamp keamanan: timeout ≤ 120s, output ≤ 16 MiB, cache TTL ≤ 3600s.
- **`esc.rs`** — shell-escape POSIX (`'...'`) & cmd.exe (`"..."`), dipisah dua fungsi — anti command injection.
- **`exec.rs`** — `ssh_exec_limited`: timeout hard + `max_output_bytes` di-enforce saat streaming (bukan truncate setelahnya).
- **`parse.rs`** — 6 parser (raw/key_value/regex_table/csv/json/lines) → 4 widget output (text/table/metrics/json). Ini kunci "control panel tanpa UI per plugin".
- **`commands.rs`** — `plugin_run`, `plugin_install` (file lokal ATAU URL raw), `plugin_uninstall`, `plugin_enable`, `plugin_list`. Interpolasi `{{variable}}` + hash cache per command/variable. Dangerous command: tidak pernah di-cache.
- **DB** — migration 16 `plugins` (id, manifest_json, enabled, source, installed_version, local_override_path, installed_at) + CRUD di `HostDb`.
- Tests: **+38** (Rust total 257). Clippy bersih untuk kode baru.

## Plugin System (Phase B) ✅ (generic renderer UI + PluginsPage)
- `src/types/plugins.ts` — tipe FE mirror backend (Plugin/PluginCommand/PluginVariable/Parser/PluginRunResult/…). `src/types/index.ts` re-export.
- `src/stores/plugin-store.ts` — list/install/uninstall/enable/run; state per `plugin:command:session`, cache-bypass + error `{kind,message}` di-surface langsung.
- `OutputRenderer` — 4 widget generik: `text` (monospace), `table` (sticky header, zebra), `metrics` (tile dengan unit), `json` (pretty-print). + badge exit code / cached / truncated.
- `PluginsPage` — install via URL atau file picker, list installed (toggle enable + uninstall confirm), per-command form variable (text/number/password/select/boolean), pemilih session terkoneksi, konfirmasi dangerous command, hasil widget.
- Entry: PageId `plugins`, sidebar nav, `PAGE_ICONS`, render di AppShell.
- Tests: **+14** (8 plugin-store + 6 OutputRenderer), FE total 139. `vitest` + `tsc` hijau.

## Plugin System (Phase C) ✅ (marketplace)
- Repo **`Ahmadnurahsan/anyscp-plugins`** (public, MIT): `registry.json` (index) + `plugins/<id>/manifest.json` + CI `scripts/validate.py` (validasi mirip manifest.rs; jalan di tiap push/PR).
- **`plugin_marketplace_list`** (BE) — fetch `MARKETPLACE_REGISTRY_URL` (raw githubusercontent) dengan timeout 15s, cache TTL 300s via `ToolsManager`, param `refresh`. `validate_registry` (id/name/version + url http(s)) dijalankan sebelum di-cache.
- **Browse** (FE) — tab di PluginsPage: list registry, tombol Install (disabled kalau sudah terpasang), lazy-load saat tab dibuka pertama kali, tombol Refresh.
- Install marketplace = `plugin_install` URL yang sudah ada (marketplace cuma index, bukan jalur baru).
- Tests: **+6** (Rust 261 total, FE 141 total). Clippy bersih untuk kode baru.

## Plugin System (Phase D) ✅ (starter pack — 8 plugin)
- Semua lolos validasi **strict Rust** (`deny_unknown_fields`) + CI Python.
- **system** — metrics overview (load/mem/swap/disk/uptime), host info, reboot-required.
- **services** — systemd: all units (table JSON), running, per-unit status, failed.
- **mysql** — ping, status (metrics), processlist (table CSV), raw query (dangerous); variable host/port/user/password.
- **nginx** — status, config test, vhosts, reload (dangerous).
- **pm2** — process list (jlist→table via node), logs, restart (dangerous).
- **disk** — usage by mount (table), top directories (du), inode usage.
- **security** — sshd -T (key/value), listening ports (ss regex_table), shell users, pending updates.
- **dns** — resolve A/AAAA, MX, TXT (dig + nslookup fallback).
- Repo: `anyscp-plugins`, commit `18edd9e`.

### Alur `plugin_run` (ringkas)
1. Load manifest dari SQLite → cek enabled.
2. Deteksi OS family (cache 5 menit) → cek `supports()`.
3. Resolve `runs` (family → linux → `*`); kosong = "not supported on this OS".
4. Validasi variable (type/select/regex) → clamp timeout/output → interpolate dengan shell-escape per OS.
5. Cek TTL cache (skipped untuk dangerous / `refresh`).
6. Exec dengan timeout + output cap → parse sesuai parser → render ke widget.
