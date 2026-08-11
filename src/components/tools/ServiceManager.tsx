import { useEffect, useState } from "react";
import { RefreshCw, Play, Square, RotateCw, Loader2, ShieldAlert } from "lucide-react";
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
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    void loadServiceAvailability(session.sshSessionId).then((available) => {
      if (available) void refreshServices(session.sshSessionId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sshSessionId]);

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
        // Refresh after a control op lands.
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
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 bg-bg-subtle border-b border-border/60">
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
            {session.services.map((sv) => (
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
                  </span>
                </td>
              </tr>
            ))}
            {session.services.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-text-muted">
                  {session.serviceLoading ? "Loading…" : "No services returned."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}