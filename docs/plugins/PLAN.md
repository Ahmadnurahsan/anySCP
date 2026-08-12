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

## Fase B — Generic renderer UI + PluginsPage 🔨 sedang dikerjakan

Checkpoint: kontrak backend sudah final — invoke args: `plugin_run(plugin_id, command_id,
session_id, variables, refresh)`, `plugin_install(source)` dengan `source` enum bertag
`{type:"local"|"url", ...}`, `plugin_uninstall(plugin_id)`, `plugin_enable(plugin_id, enabled)`,
`plugin_list()`. Semua error dikirim sebagai `{kind, message}`.

- [ ] `src/types/plugins.ts` — tipe manifest + hasil run (mirror backend)
- [ ] `src/stores/plugin-store.ts` — list/install/uninstall/enable/run + state
- [ ] `OutputRenderer` — 4 widget generik: `text` / `table` / `metrics` / `json`
- [ ] `PluginsPage` — list installed, detail, form variable (type select/password/boolean), tombol run, hasil
- [ ] Entry point + tab di AppShell
- [ ] Vitest + tsc hijau
- [ ] Push

## Fase C — Marketplace (repo GitHub terpisah)

- [ ] Repo `anyscp-plugins` — struktur folder per plugin + validasi manifest di CI
- [ ] `plugin_marketplace_list` / install dari registry
- [ ] Halaman browse + install di app

## Fase D — Starter pack plugin

- [ ] mysql (install host/docker, status, query singkat)
- [ ] nginx (status, reload, vhost list)
- [ ] node/pm2 (list, restart, log)
- [ ] disk analyzer (du treemap)
- [ ] security audit (password auth, root login, port terbuka)
- [ ] DNS checker (dig/nslookup)
