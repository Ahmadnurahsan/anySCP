import { useEffect, useMemo, useState } from "react";
import {
  Blocks,
  PackagePlus,
  Play,
  Power,
  RefreshCw,
  Trash2,
  FolderOpen,
  Link2,
  Loader2,
  Terminal,
  AlertTriangle,
  ShieldAlert,
  Store,
} from "lucide-react";
import { usePluginStore, runKey } from "../../stores/plugin-store";
import { useSessionStore } from "../../stores/session-store";
import type {
  PluginInfo,
  PluginCommand,
  PluginVariable,
  PluginMarketplaceEntry,
} from "../../types";
import { OutputRenderer } from "./OutputRenderer";

const BTN_PRIMARY =
  "flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium bg-accent/15 text-accent " +
  "hover:bg-accent/25 transition-colors duration-[var(--duration-fast)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:pointer-events-none";
const BTN_GHOST =
  "flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-text-secondary " +
  "hover:text-text-primary hover:bg-bg-overlay transition-colors duration-[var(--duration-fast)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:pointer-events-none";
const INPUT_CLASS =
  "w-full h-7 px-2 rounded-md bg-bg-subtle border border-border/60 text-xs text-text-primary " +
  "focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-text-muted";

export function PluginsPage() {
  const installed = usePluginStore((s) => s.installed);
  const loading = usePluginStore((s) => s.loading);
  const error = usePluginStore((s) => s.error);
  const installing = usePluginStore((s) => s.installing);
  const list = usePluginStore((s) => s.list);
  const clearError = usePluginStore((s) => s.clearError);
  const marketplace = usePluginStore((s) => s.marketplace);
  const marketLoading = usePluginStore((s) => s.marketLoading);
  const marketError = usePluginStore((s) => s.marketError);
  const loadMarketplace = usePluginStore((s) => s.loadMarketplace);

  const [view, setView] = useState<"installed" | "marketplace">("installed");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState("");

  useEffect(() => {
    void list();
  }, [list]);

  // Load the registry the first time Browse is opened.
  useEffect(() => {
    if (view === "marketplace" && marketplace === null && !marketLoading) {
      void loadMarketplace();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const selected = installed?.find((p) => p.manifest.id === selectedId) ?? null;

  return (
    <div className="flex flex-col h-full p-2">
      <div className="flex flex-col flex-1 min-h-0 rounded-lg overflow-hidden border border-border/60">
        {/* Header */}
        <div className="flex items-center h-8 px-2.5 gap-2.5 shrink-0 no-select bg-bg-surface/80 border-b border-border/60">
          <Blocks size={14} strokeWidth={1.8} className="shrink-0 text-accent" aria-hidden="true" />
          <span className="text-[11px] font-mono truncate flex-1 min-w-0 text-text-primary leading-none">
            Plugins
          </span>
          <span className="text-[10px] uppercase tracking-wider text-text-muted font-medium shrink-0">
            JSON manifests
          </span>
        </div>

        {/* Sub-tab strip */}
        <div className="flex items-center gap-1 px-2 py-1.5 shrink-0 bg-bg-subtle border-b border-border/60 no-select">
          <SubTab
            label="Installed"
            icon={<Blocks size={13} strokeWidth={1.8} aria-hidden="true" />}
            active={view === "installed"}
            onClick={() => setView("installed")}
          />
          <SubTab
            label="Browse"
            icon={<Store size={13} strokeWidth={1.8} aria-hidden="true" />}
            active={view === "marketplace"}
            onClick={() => setView("marketplace")}
          />
          {view === "marketplace" && (
            <button
              type="button"
              onClick={() => void loadMarketplace(true)}
              disabled={marketLoading}
              className={BTN_GHOST + " ml-auto"}
              title="Refresh marketplace registry"
            >
              <RefreshCw size={13} strokeWidth={1.8} className={marketLoading ? "animate-spin" : ""} aria-hidden="true" />
              Refresh
            </button>
          )}
        </div>

        {view === "marketplace" ? (
          <MarketplaceView
            marketplace={marketplace}
            loading={marketLoading}
            error={marketError}
            installedIds={new Set((installed ?? []).map((p) => p.manifest.id))}
          />
        ) : (
          <>
            {/* Install bar */}
            <div className="flex items-center gap-2 px-2 py-1.5 shrink-0 bg-bg-subtle border-b border-border/60 no-select">
              <Link2 size={13} strokeWidth={1.8} className="shrink-0 text-text-muted" aria-hidden="true" />
              <input
                value={installUrl}
                onChange={(e) => setInstallUrl(e.target.value)}
                placeholder="https://raw.githubusercontent.com/…/manifest.json"
                spellCheck={false}
                className={INPUT_CLASS}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && installUrl.trim()) void installFromUrl(installUrl);
                }}
              />
              <button
                type="button"
                onClick={pickLocalFile}
                className={BTN_GHOST}
                title="Install from a local JSON manifest"
              >
                <FolderOpen size={13} strokeWidth={1.8} aria-hidden="true" />
                File…
              </button>
              <button
                type="button"
                onClick={() => void installFromUrl(installUrl)}
                disabled={installing || !installUrl.trim()}
                className={BTN_PRIMARY}
              >
                {installing ? (
                  <Loader2 size={13} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
                ) : (
                  <PackagePlus size={13} strokeWidth={1.8} aria-hidden="true" />
                )}
                Install
              </button>
              <button
                type="button"
                onClick={() => void list()}
                disabled={loading}
                className={BTN_GHOST}
                title="Refresh installed plugins"
              >
                <RefreshCw size={13} strokeWidth={1.8} className={loading ? "animate-spin" : ""} aria-hidden="true" />
              </button>
            </div>

            {error && (
              <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-status-error bg-status-error/10 border-b border-border/60">
                <AlertTriangle size={13} strokeWidth={1.8} aria-hidden="true" />
                <span className="flex-1 truncate" title={error}>{error}</span>
                <button type="button" onClick={clearError} className="text-text-muted hover:text-text-primary">✕</button>
              </div>
            )}

            {/* Body */}
            <div className="flex flex-1 min-h-0">
              {/* Installed list */}
              <div className="w-64 shrink-0 border-r border-border/60 overflow-y-auto bg-bg-base">
                {installed === null ? (
                  <EmptyHint text={loading ? "Loading…" : "No plugins installed yet."} />
                ) : installed.length === 0 ? (
                  <EmptyHint text="No plugins installed yet." />
                ) : (
                  installed.map((p) => (
                    <PluginCard
                      key={p.manifest.id}
                      info={p}
                      active={p.manifest.id === selectedId}
                      onClick={() => setSelectedId(p.manifest.id)}
                    />
                  ))
                )}
              </div>

              {/* Detail */}
              <div className="flex-1 min-w-0 overflow-y-auto bg-bg-base">
                {selected ? (
                  <PluginDetail info={selected} />
                ) : (
                  <EmptyHint text="Select a plugin to see its commands." />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SubTab({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[length:var(--text-xs)] font-medium transition-colors",
        "duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-accent/15 text-accent" : "text-text-secondary hover:text-text-primary hover:bg-bg-overlay",
      ].join(" ")}
    >
      {icon}
      {label}
    </button>
  );
}

function MarketplaceView({
  marketplace,
  loading,
  error,
  installedIds,
}: {
  marketplace: PluginMarketplaceEntry[] | null;
  loading: boolean;
  error: string | null;
  installedIds: Set<string>;
}) {
  const installing = usePluginStore((s) => s.installing);

  if (loading && marketplace === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-xs gap-2">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        Loading registry…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyHint text={error} />
      </div>
    );
  }
  if (!marketplace || marketplace.length === 0) {
    return <EmptyHint text="Registry kosong." />;
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-bg-base">
      <div className="p-3 space-y-2">
        {marketplace.map((m) => {
          const isInstalled = installedIds.has(m.id);
          return (
            <div
              key={m.id}
              className="flex items-center gap-3 rounded-lg border border-border/60 bg-bg-subtle p-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-medium text-text-primary">{m.name}</span>
                  <span className="text-[10px] font-mono text-text-muted">v{m.version}</span>
                  <span className="text-[10px] text-text-muted">{m.author}</span>
                  {m.platforms.length > 0 ? (
                    <span className="text-[10px] text-text-muted">{m.platforms.join(", ")}</span>
                  ) : null}
                </div>
                {m.description ? (
                  <p className="text-[11px] text-text-muted mt-0.5 truncate" title={m.description}>
                    {m.description}
                  </p>
                ) : null}
                <p className="text-[10px] font-mono text-text-muted/70 mt-0.5 truncate" title={m.url}>
                  {m.id}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void usePluginStore.getState().install({ type: "url", url: m.url })}
                disabled={isInstalled || installing}
                className={isInstalled ? BTN_GHOST : BTN_PRIMARY}
              >
                {isInstalled ? (
                  "Installed"
                ) : (
                  <>
                    <PackagePlus size={13} strokeWidth={1.8} aria-hidden="true" />
                    Install
                  </>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

async function installFromUrl(url: string) {
  const clean = url.trim();
  if (!clean) return;
  await usePluginStore.getState().install({ type: "url", url: clean });
}

async function pickLocalFile() {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      directory: false,
      title: "Select plugin manifest",
      filters: [{ name: "Plugin manifest", extensions: ["json"] }],
    });
    if (typeof picked === "string") {
      await usePluginStore.getState().install({ type: "local", path: picked });
    }
  } catch {
    /* dialog cancelled / unavailable */
  }
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="p-8 text-center text-text-muted text-xs">
      <p>{text}</p>
    </div>
  );
}

function PluginCard({
  info,
  active,
  onClick,
}: {
  info: PluginInfo;
  active: boolean;
  onClick: () => void;
}) {
  const { manifest } = info;
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "w-full text-left px-3 py-2.5 border-b border-border/40 transition-colors duration-[var(--duration-fast)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-accent/10" : "hover:bg-bg-overlay",
      ].join(" ")}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[13px] font-medium text-text-primary truncate flex-1">{manifest.name}</span>
        <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full ${info.enabled ? "bg-accent/15 text-accent" : "bg-bg-overlay text-text-muted"}`}>
          {info.enabled ? "ON" : "OFF"}
        </span>
      </div>
      <div className="text-[10px] text-text-muted mt-0.5 truncate">
        {manifest.id} · v{manifest.version}
      </div>
    </button>
  );
}

function PluginDetail({ info }: { info: PluginInfo }) {
  const { manifest } = info;
  const uninstall = usePluginStore((s) => s.uninstall);
  const setEnabled = usePluginStore((s) => s.setEnabled);
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [commandId, setCommandId] = useState<string | null>(
    manifest.commands[0]?.id ?? null,
  );

  const command =
    manifest.commands.find((c) => c.id === commandId) ??
    manifest.commands[0] ??
    null;

  return (
    <div className="p-4 space-y-4 max-w-3xl">
      {/* Plugin header */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-text-primary">{manifest.name}</h2>
            <span className="text-[10px] font-mono text-text-muted">v{manifest.version}</span>
            {manifest.description ? (
              <span className="text-[11px] text-text-muted" title={manifest.description}>
                — {manifest.description}
              </span>
            ) : null}
          </div>
          <div className="text-[11px] text-text-muted mt-1">
            {manifest.author}
            {manifest.platforms.length > 0 ? ` · ${manifest.platforms.join(", ")}` : " · all platforms"}
            {info.source ? ` · ${info.source}` : ""}
            {info.installed_at ? ` · installed ${info.installed_at}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => void setEnabled(manifest.id, !info.enabled)}
            className={info.enabled ? BTN_PRIMARY : BTN_GHOST}
            title={info.enabled ? "Disable plugin" : "Enable plugin"}
          >
            <Power size={13} strokeWidth={1.8} aria-hidden="true" />
            {info.enabled ? "Enabled" : "Disabled"}
          </button>
          {confirmingUninstall ? (
            <button
              type="button"
              onClick={() => {
                void uninstall(manifest.id);
                setConfirmingUninstall(false);
              }}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium bg-status-error/15 text-status-error hover:bg-status-error/25"
            >
              <AlertTriangle size={13} strokeWidth={1.8} aria-hidden="true" />
              Confirm
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingUninstall(true)}
              className={BTN_GHOST}
              title="Uninstall plugin"
            >
              <Trash2 size={13} strokeWidth={1.8} aria-hidden="true" />
              Uninstall
            </button>
          )}
        </div>
      </div>

      {/* Commands */}
      <div>
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-text-muted mb-2">
          Commands
        </h3>
        {manifest.commands.length === 0 ? (
          <p className="text-xs text-text-muted">This plugin declares no commands.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {manifest.commands.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCommandId(c.id)}
                className={[
                  "flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium transition-colors duration-[var(--duration-fast)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  command?.id === c.id
                    ? "bg-accent/15 text-accent"
                    : "text-text-secondary hover:text-text-primary hover:bg-bg-overlay border border-border/60",
                ].join(" ")}
              >
                <Terminal size={12} strokeWidth={1.8} aria-hidden="true" />
                {c.title}
                {c.dangerous ? (
                  <ShieldAlert size={11} strokeWidth={1.8} className="text-status-connecting" aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Selected command */}
      {command ? (
        <CommandDetail info={info} command={command} />
      ) : null}
    </div>
  );
}

function CommandDetail({
  info,
  command,
}: {
  info: PluginInfo;
  command: PluginCommand;
}) {
  const run = usePluginStore((s) => s.run);
  const runs = usePluginStore((s) => s.runs);
  const sessions = useSessionStore((s) => s.sessions);

  const connectedSessions = useMemo(
    () => Array.from(sessions.values()).filter((s) => s.status === "Connected"),
    [sessions],
  );

  const [sessionId, setSessionId] = useState<string | null>(
    connectedSessions[0]?.id ?? null,
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    defaultsFor(command),
  );
  const [confirming, setConfirming] = useState(false);
  const [refresh, setRefresh] = useState(false);

  // Reset the form whenever the command (or the plugin) changes.
  useEffect(() => {
    setValues(defaultsFor(command));
    setConfirming(false);
    setSessionId((prev) =>
      connectedSessions.some((s) => s.id === prev)
        ? prev
        : (connectedSessions[0]?.id ?? null),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.manifest.id, command.id]);

  const selectedSessionId =
    sessionId ??
    (connectedSessions[0]?.id ?? null);
  const key = runKey(info.manifest.id, command.id, selectedSessionId ?? "__none");
  const runState = runs[key] ?? { running: false, result: null, error: null };

  const setValue = (name: string, value: string) =>
    setValues((v) => ({ ...v, [name]: value }));

  const doRun = async () => {
    if (!selectedSessionId) return;
    if (command.dangerous && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    await run(
      info.manifest.id,
      command.id,
      selectedSessionId,
      values,
      refresh,
    );
  };

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-xs font-semibold text-text-primary">{command.title}</h4>
        {command.description ? (
          <p className="text-[11px] text-text-muted mt-0.5">{command.description}</p>
        ) : null}
        {command.dangerous ? (
          <p className="flex items-center gap-1.5 text-[11px] text-status-connecting mt-1">
            <ShieldAlert size={12} strokeWidth={1.8} aria-hidden="true" />
            Dangerous command — result is never cached.
          </p>
        ) : null}
      </div>

      {/* Session picker */}
      <div>
        <label className="block text-[11px] font-medium text-text-muted mb-1">Target session</label>
        {connectedSessions.length === 0 ? (
          <p className="text-xs text-status-connecting">
            No connected sessions. Open a terminal tab first, then run this command.
          </p>
        ) : (
          <select
            value={selectedSessionId ?? ""}
            onChange={(e) => setSessionId(e.target.value || null)}
            className={INPUT_CLASS + " appearance-none"}
          >
            {connectedSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Variables */}
      {command.variables.length > 0 && (
        <div className="space-y-2.5">
          <label className="block text-[11px] font-medium text-text-muted">Variables</label>
          {command.variables.map((v) => (
            <VariableField
              key={v.name}
              variable={v}
              value={values[v.name] ?? ""}
              onChange={(val) => setValue(v.name, val)}
            />
          ))}
        </div>
      )}

      {/* Run controls */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void doRun()}
          disabled={runState.running || !selectedSessionId}
          className={command.dangerous ? "flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium bg-status-connecting/15 text-status-connecting hover:bg-status-connecting/25" : BTN_PRIMARY}
        >
          {runState.running ? (
            <Loader2 size={13} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
          ) : (
            <Play size={13} strokeWidth={1.8} aria-hidden="true" />
          )}
          {command.dangerous && !confirming ? "Run…" : "Run"}
        </button>
        {!command.dangerous && (
          <label className="flex items-center gap-1.5 text-[11px] text-text-muted cursor-pointer no-select">
            <input
              type="checkbox"
              checked={refresh}
              onChange={(e) => setRefresh(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            bypass cache
          </label>
        )}
        {runState.running ? (
          <span className="text-[11px] text-text-muted animate-pulse">Running on remote…</span>
        ) : null}
      </div>

      {confirming && command.dangerous ? (
        <div className="flex items-center gap-2 rounded-lg border border-status-connecting/40 bg-status-connecting/10 px-3 py-2">
          <ShieldAlert size={14} strokeWidth={1.8} className="text-status-connecting shrink-0" aria-hidden="true" />
          <span className="text-[11px] text-text-primary flex-1">
            This command is flagged as dangerous. Run it anyway?
          </span>
          <button type="button" onClick={() => void doRun()} className={BTN_PRIMARY}>
            Yes, run
          </button>
          <button type="button" onClick={() => setConfirming(false)} className={BTN_GHOST}>
            Cancel
          </button>
        </div>
      ) : null}

      {/* Result */}
      {runState.error ? (
        <div className="rounded-lg border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">
          {runState.error}
        </div>
      ) : null}
      {runState.result ? (
        <OutputRenderer result={runState.result} />
      ) : null}
    </div>
  );
}

function defaultsFor(command: PluginCommand): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of command.variables) {
    out[v.name] = v.default ?? "";
  }
  return out;
}

function VariableField({
  variable,
  value,
  onChange,
}: {
  variable: PluginVariable;
  value: string;
  onChange: (value: string) => void;
}) {
  const label = variable.label ?? variable.name;
  const required = variable.required;
  if (variable.type === "select") {
    return (
      <label className="block">
        <span className="block text-[11px] text-text-muted mb-1">
          {label} {required ? <span className="text-status-error">*</span> : null}
        </span>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT_CLASS + " appearance-none"}
        >
          {variable.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (variable.type === "boolean") {
    const checked = value === "true";
    return (
      <label className="flex items-center gap-2 text-[11px] text-text-primary cursor-pointer no-select">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          className="accent-[var(--color-accent)]"
        />
        <span>
          {label} {required ? <span className="text-status-error">*</span> : null}
        </span>
      </label>
    );
  }
  return (
    <label className="block">
      <span className="block text-[11px] text-text-muted mb-1">
        {label} {required ? <span className="text-status-error">*</span> : null}
      </span>
      <input
        type={variable.type === "password" ? "password" : "text"}
        inputMode={variable.type === "number" ? "numeric" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={variable.validation ? `must match ${variable.validation}` : undefined}
        spellCheck={false}
        className={INPUT_CLASS}
      />
    </label>
  );
}
