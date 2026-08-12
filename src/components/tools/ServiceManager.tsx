import { useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  Play,
  Square,
  RotateCw,
  Loader2,
  ShieldAlert,
  FileText,
  X,
  Search,
  Copy,
  Check,
  Download,
  ChevronDown,
  ChevronUp,
  WrapText,
} from "lucide-react";
import type { ServiceAction } from "../../types";
import type { ToolsSession } from "../../stores/tools-store";
import { useToolsStore } from "../../stores/tools-store";

interface Props {
  session: ToolsSession;
}

const ACTIONS: { action: ServiceAction; label: string; icon: React.ElementType }[] = [
  { action: "start", label: "Start", icon: Play },
  { action: "stop", label: "Stop", icon: Square },
  { action: "restart", label: "Restart", icon: RotateCw },
  { action: "reload", label: "Reload", icon: RefreshCw },
];

export function ServiceManager({ session }: Props) {
  const refreshServices = useToolsStore((s) => s.refreshServices);
  const loadServiceAvailability = useToolsStore((s) => s.loadServiceAvailability);
  const serviceControl = useToolsStore((s) => s.serviceControl);
  const fetchServiceLog = useToolsStore((s) => s.fetchServiceLog);
  const clearServiceLog = useToolsStore((s) => s.clearServiceLog);

  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [search, setSearch] = useState("");
  const [logUnit, setLogUnit] = useState<string | null>(null);

  useEffect(() => {
    void loadServiceAvailability(session.sshSessionId).then((available) => {
      if (available) void refreshServices(session.sshSessionId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sshSessionId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? session.services.filter((sv) => sv.name.toLowerCase().includes(q))
      : session.services;
  }, [session.services, search]);

  const run = async (unit: string, action: ServiceAction) => {
    setBusy(`${action}:${unit}`);
    setNotice(null);
    try {
      const res = await serviceControl(session.sshSessionId, unit, action);
      if (!res.ok && res.needs_sudo) {
        setNotice({
          text: `"${res.unit}" needs sudo — re-open this host's terminal with sudo to manage services. (${res.message})`,
          ok: false,
        });
      } else {
        setNotice({
          text: res.ok ? `${action} ${res.unit} OK` : `${action} ${res.unit} failed: ${res.message}`,
          ok: res.ok,
        });
        await refreshServices(session.sshSessionId, true);
      }
    } catch (err) {
      const m =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Command failed";
      setNotice({ text: `${action} ${unit} failed: ${m}`, ok: false });
    } finally {
      setBusy(null);
    }
  };

  const toggleLog = async (unit: string) => {
    if (logUnit === unit) {
      setLogUnit(null);
      clearServiceLog(session.sshSessionId, unit);
      return;
    }
    setLogUnit(unit);
    await fetchServiceLog(session.sshSessionId, unit, 300);
  };

  if (session.serviceAvailable === false) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center px-8">
        <ShieldAlert size={22} strokeWidth={1.6} className="text-text-muted" aria-hidden="true" />
        <p className="text-sm text-text-secondary">
          The remote shell has no <span className="font-mono">systemctl</span>. Service management
          requires a systemd-based host.
        </p>
      </div>
    );
  }

  if (session.serviceAvailable === null && session.serviceLoading) {
    return (
      <div className="p-8 text-center text-text-muted">
        <Loader2 size={20} strokeWidth={1.6} className="animate-spin mx-auto" />
        <p className="mt-3 text-sm">Detecting init system…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 bg-bg-subtle border-b border-border/60">
        <div className="relative flex-1 min-w-0 max-w-xs">
          <Search
            size={13}
            strokeWidth={1.8}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted"
            aria-hidden="true"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter services…"
            className="w-full h-7 pl-7 pr-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <button
          type="button"
          onClick={() => void refreshServices(session.sshSessionId, true)}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-bg-overlay"
        >
          <RefreshCw size={13} strokeWidth={1.8} aria-hidden="true" />
          Refresh
        </button>
        {notice && (
          <span
            className={`ml-auto text-[11px] truncate max-w-[55%] ${notice.ok ? "text-status-connected" : "text-status-error"}`}
            title={notice.text}
          >
            {notice.text}
          </span>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-bg-surface">
            <tr className="text-text-muted">
              <th className="px-3 py-1.5 text-left font-medium">Service</th>
              <th className="px-3 py-1.5 text-left font-medium">Active</th>
              <th className="px-3 py-1.5 text-left font-medium">Sub</th>
              <th className="px-3 py-1.5 text-left font-medium">Loaded</th>
              <th className="px-3 py-1.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((sv) => (
              <tr key={sv.name} className="border-t border-border/40 hover:bg-bg-overlay/60">
                <td className="px-3 py-1 font-mono truncate max-w-[240px]" title={sv.name}>
                  {sv.name}
                </td>
                <td className="px-3 py-1">
                  <span
                    className={`inline-flex items-center gap-1.5 ${
                      sv.active === "active" ? "text-status-connected" : "text-text-muted"
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${sv.active === "active" ? "bg-status-connected" : "bg-bg-muted"}`} />
                    {sv.active || "—"}
                  </span>
                </td>
                <td className="px-3 py-1 text-text-secondary">{sv.sub || "—"}</td>
                <td className="px-3 py-1 text-text-secondary">{sv.load || "—"}</td>
                <td className="px-3 py-1 text-right">
                  <span className="inline-flex items-center gap-1">
                    {ACTIONS.map(({ action, label, icon: Icon }) => (
                      <button
                        key={action}
                        type="button"
                        disabled={busy === `${action}:${sv.name}`}
                        onClick={() => void run(sv.name, action)}
                        title={`${label} ${sv.name}`}
                        className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-overlay disabled:opacity-40"
                      >
                        {busy === `${action}:${sv.name}` ? (
                          <Loader2 size={13} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
                        ) : (
                          <Icon size={13} strokeWidth={1.8} aria-hidden="true" />
                        )}
                      </button>
                    ))}
                    {/* journalctl log button */}
                    <button
                      type="button"
                      onClick={() => void toggleLog(sv.name)}
                      title="View journalctl logs"
                      className={`p-1 rounded hover:bg-bg-overlay ${logUnit === sv.name ? "text-accent" : "text-text-muted hover:text-text-primary"}`}
                    >
                      {session.serviceLogLoading === sv.name ? (
                        <Loader2 size={13} strokeWidth={1.8} className="animate-spin" />
                      ) : (
                        <FileText size={13} strokeWidth={1.8} aria-hidden="true" />
                      )}
                    </button>
                  </span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-text-muted">
                  {session.serviceLoading
                    ? "Loading…"
                    : session.services.length === 0
                      ? "No services returned."
                      : "No services match your filter."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Service log drawer */}
      {logUnit && session.serviceLogs[logUnit] !== undefined && (
        <ServiceLogPane
          unit={logUnit}
          text={session.serviceLogs[logUnit]}
          loading={session.serviceLogLoading === logUnit}
          onClose={() => {
            setLogUnit(null);
            clearServiceLog(session.sshSessionId, logUnit);
          }}
          onRefresh={() => void fetchServiceLog(session.sshSessionId, logUnit, 300)}
        />
      )}
    </div>
  );
}

// ─── ServiceLogPane ───────────────────────────────────────────────────────────

function ServiceLogPane({
  unit,
  text,
  loading,
  onClose,
  onRefresh,
}: {
  unit: string;
  text: string;
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [search, setSearch] = useState("");
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const filtered = useMemo(() => {
    if (!search) return text;
    return text
      .split("\n")
      .filter((l) => l.toLowerCase().includes(search.toLowerCase()))
      .join("\n");
  }, [text, search]);

  const handleCopy = () => {
    void navigator.clipboard.writeText(filtered);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([filtered], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${unit}-${timestamp()}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`shrink-0 flex flex-col bg-bg-base border-t border-border/60 transition-all ${expanded ? "h-96" : "h-52"}`}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-subtle border-b border-border/60 shrink-0">
        <FileText size={13} className="text-accent shrink-0" />
        <span className="text-[11px] font-mono font-semibold text-text-primary">{unit}</span>

        {/* Search */}
        <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-bg-surface border border-border/60 flex-1 min-w-0 max-w-xs">
          <Search size={11} className="text-text-muted shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter lines…"
            spellCheck={false}
            className="flex-1 bg-transparent text-[11px] text-text-primary placeholder:text-text-muted outline-none"
          />
          {search && (
            <button type="button" onClick={() => setSearch("")} className="text-text-muted hover:text-text-primary">
              <X size={10} />
            </button>
          )}
        </div>

        <span className="ml-auto" />

        <button type="button" onClick={onRefresh} title="Reload logs" className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-overlay">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} strokeWidth={1.8} />}
        </button>
        <button type="button" onClick={() => setWrap((v) => !v)} title="Toggle wrap" className={`p-1 rounded ${wrap ? "text-accent" : "text-text-muted hover:text-text-primary"} hover:bg-bg-overlay`}>
          <WrapText size={13} strokeWidth={1.8} />
        </button>
        <button type="button" onClick={handleCopy} title="Copy" className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-overlay">
          {copied ? <Check size={13} className="text-status-connected" /> : <Copy size={13} strokeWidth={1.8} />}
        </button>
        <button type="button" onClick={handleDownload} title="Download" className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-overlay">
          <Download size={13} strokeWidth={1.8} />
        </button>
        <button type="button" onClick={() => setExpanded((v) => !v)} title={expanded ? "Collapse" : "Expand"} className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-overlay">
          {expanded ? <ChevronDown size={13} strokeWidth={1.8} /> : <ChevronUp size={13} strokeWidth={1.8} />}
        </button>
        <button type="button" onClick={onClose} title="Close" className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-overlay">
          <X size={13} strokeWidth={1.8} />
        </button>
      </div>

      <pre
        className={`flex-1 min-h-0 overflow-auto px-3 py-1.5 font-mono text-[11px] leading-relaxed text-text-secondary select-text cursor-text ${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}
      >
        {loading ? "Loading…" : filtered || "(no output)"}
      </pre>
    </div>
  );
}

function timestamp(): string {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
  ].join("");
}