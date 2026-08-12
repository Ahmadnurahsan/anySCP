# anySCP Plugin System — Plan & Tracking

Plugin = **JSON manifest** (bukan kode) → aman dari arbitrary code execution.
Komunitas cukup menulis JSON; UI generik me-render hasilnya tanpa per-plugin UI.

Branch kerja: `feature/plugin-system` (dari `main`). Setiap fase = 1 commit terpisah.

---

## Fase A — Engine (backend) ✅ selesai — commit `d207b11`

- [x] `plugins/os.rs` — OsFamily + deteksi remote (uname + os-release, fallback Windows), cache 5 menit
- [x] `plugins/manifest.rs` — struct serde `deny_unknown_fields` + validasi strict + clamp keamanan
- [x] `plugins/esc.rs` — shell-escape POSIX & cmd.exe terpisah (anti injection)
- [x] `plugins/exec.rs` — `ssh_exec_limited` (timeout hard + byte cap saat streaming)
- [x] `plugins/parse.rs` — 6 parser (raw/key_value/regex_table/csv/json/lines)
- [x] `plugins/commands.rs` — plugin_run / install(file|url) / uninstall / enable / list
- [x] DB migration 16 `plugins` + CRUD `HostDb`
- [x] Tests +38 (Rust total 257), clippy bersih
- [x] Push ke `feature/plugin-system`

## Fase B — Generic renderer UI + PluginsPage ✅ selesai — commit `a31a530`

Checkpoint: kontrak backend sudah final — invoke args: `plugin_run(plugin_id, command_id,
session_id, variables, refresh)`, `plugin_install(source)` dengan `source` enum bertag
`{type:"local"|"url", ...}`, `plugin_uninstall(plugin_id)`, `plugin_enable(plugin_id, enabled)`,
`plugin_list()`. Semua error dikirim sebagai `{kind, message}`.

- [x] `src/types/plugins.ts` — tipe manifest + hasil run (mirror backend)
- [x] `src/stores/plugin-store.ts` — list/install/uninstall/enable/run + state
- [x] `OutputRenderer` — 4 widget generik: `text` / `table` / `metrics` / `json`
- [x] `PluginsPage` — list installed, detail, form variable (type select/password/boolean), tombol run, hasil
- [x] Entry point + tab di AppShell (sidebar "Plugins" + PAGE_ICONS)
- [x] Vitest + tsc hijau (139 total), OutputRenderer + plugin-store di-test
- [x] Push — commit `a31a530`

## Fase C — Marketplace ✅ selesai — repo `Ahmadnurahsan/anyscp-plugins` + commit `c33d037` (FE) / `54e6757` (BE)

- [x] Repo `anyscp-plugins` (public, MIT) — `plugins/<id>/manifest.json` per plugin + `registry.json` + CI `scripts/validate.py` (validasi mirip manifest.rs)
- [x] `plugin_marketplace_list` — fetch registry dari `MARKETPLACE_REGISTRY_URL` (raw github, timeout 15s, cache TTL 300s via ToolsManager, param `refresh`); validasi entry (id/name/version + url http(s)) sebelum di-cache
- [x] Halaman browse + install di app — tab **Browse** di PluginsPage: list registry, tombol Install (disabled jika sudah terpasang), lazy-load saat pertama dibuka
- [x] Tests +6 (Rust 261 total, FE 141 total), clippy bersih
- [x] Push

## Fase D — Starter pack plugin ✅ selesai — commit `18edd9e` di `anyscp-plugins`

Semua manifest lolos validasi **strict Rust** (`deny_unknown_fields`) + Python CI.

- [x] **system** — overview (metrics tiles: load/mem/swap/disk/uptime), host info, reboot-required
- [x] **services** — systemd: all units table (JSON feed), running, per-unit status, failed
- [x] **mysql** — ping, status (metrics), processlist (table), raw query (dangerous) — variable host/port/user/password
- [x] **nginx** — status, config test, vhosts, reload (dangerous)
- [x] **pm2** — process list (jlist→table), logs, restart (dangerous)
- [x] **disk** — usage by mount (table), top directories (du), inode usage
- [x] **security** — sshd -T (table), listening ports (ss regex_table), shell users, pending updates
- [x] **dns** — resolve A/AAAA, MX, TXT (dig/nslookup fallback)
