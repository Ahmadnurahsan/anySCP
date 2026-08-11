import { useEffect, useMemo, useState } from "react";
import {
  Boxes,
  RefreshCw,
  Search,
  Play,
  Square,
  RotateCw,
  Trash2,
  TerminalSquare,
  FileText,
  X,
  Loader2,
  ShieldAlert,
  Circle,
} from "lucide-react";
import type { DockerContainerAction } from "../../types";
import { useToolsStore } from "../../stores/tools-store";
import type { ToolsSession } from "../../stores/tools-store";

interface Props {
  session: ToolsSession;
}

const ACTIONS: {
  action: DockerContainerAction;
  label: string;
  icon: React.ElementType;
}[] = [
  { action: "start", label: "Start", icon: Play },
  { action: "stop", label: "Stop", icon: Square },
  { action: "restart", label: "Restart", icon: RotateCw },
];

export function DockerPanel({ session }: Props) {
  const refreshContainers = useToolsStore((s) => s.refreshContainers);
  const refreshImages = useToolsStore((s) => s.refreshDockerImages);
  const refreshStats = useToolsStore((s) => s.refreshDockerStats);
  const toggleShowAll = useToolsStore((s) => s.toggleShowAll);
  const containerAction = useToolsStore((s) => s.dockerContainerAction);
  const execShell = useToolsStore((s) => s.dockerExecShell);
  const openLogs = useToolsStore((s) => s.openLogs);
  const closeLogs = useToolsStore((s) => s.closeLogs);

  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  // Load availability then the data lists on first mount.
  useEffect(() => {
    const { loadDockerAvailability } = useToolsStore.getState();
    void loadDockerAvailability(session.sshSessionId).then((a) => {
      if (a?.present) {
        void refreshContainers(session.sshSessionId);
        void refreshImages(session.sshSessionId);
        void refreshStats(session.sshSessionId);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sshSessionId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? session.containers.filter(
          (c) =>
            c.names.toLowerCase().includes(q) ||
            c.image.toLowerCase().includes(q) ||
            c.id.includes(q),
        )
      : session.containers;
    return list;
  }, [session.containers, search]);

  const statusDot = (state: string) => {
    switch (state) {
      case "running":
        return "bg-status-connected";
      case "paused":
        return "bg-status-connecting";
      case "exited":
      case "dead":
        return "bg-bg-muted";
      default:
        return "bg-text-muted/60";
    }
  };

  const run = async (
    container: string,
    action: DockerContainerAction,
    label: string,
  ) => {
    setBusy(`${action}:${container}`);
    setNotice(null);
    try {
      const res = await containerAction(session.sshSessionId, container, action);
      if (!res.ok && res.needs_sudo) {
        setNotice({
          text: `${label} ${res.container} needs sudo — the current user isn't in the docker group.`,
          ok: false,
        });
      } else {
        setNotice({
          text: res.message || `${label} ${res.container}${res.ok ? "" : " failed"}`,
          ok: res.ok,
        });
      }
    } catch (err) {
      const m =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Action failed";
      setNotice({ text: m, ok: false });
    } finally {
      setBusy(null);
      setConfirmRemove(null);
    }
  };

  const runExec = async (container: string) => {
    setBusy(`exec:${container}`);
    setNotice(null);
    try {
      const sid = await execShell(session.sshSessionId, container);
      if (sid) {
        setNotice({ text: "Opened a shell into the container.", ok: true });
      }
    } catch (err) {
      setNotice({
        text: `Couldn't open a shell: ${msg(err)}`,
        ok: false,
      });
    } finally {
      setBusy(null);
    }
  };

  if (!session.docker) {
    if (session.dockerLoading) {
      return (
        <div className="p-8 text-center text-text-muted">
          <Loader2 size={20} strokeWidth={1.6} className="animate-spin mx-auto" />
          <p className="mt-3 text-sm">Detecting Docker…</p>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center px-8">
        <Loader2 size={22} strokeWidth={1.6} className="animate-spin text-text-muted" aria-hidden="true" />
        <p className="text-sm text-text-secondary">Checking for Docker…</p>
      </div>
    );
  }

  if (!session.docker.present) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center px-8">
        <Boxes size={26} strokeWidth={1.5} className="text-text-muted" aria-hidden="true" />
        <p className="text-sm text-text-secondary">
          Docker isn't installed on this host. The remote toolkit can't manage
          containers it can't talk to.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 bg-bg-subtle border-b border-border/60">
        <span
          className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${
            session.docker.daemon
              ? "text-status-connected"
              : session.docker.needs_sudo
                ? "text-status-connecting"
                : "text-status-error"
          }`}
          title={session.docker.message}
        >
          <Circle size={8} fill="currentColor" strokeWidth={0} aria-hidden="true" />
          {session.docker.server_version
            ? `daemon ${session.docker.server_version}`
            : session.docker.needs_sudo
              ? "daemon unreachable (needs sudo)"
              : "daemon unreachable"}
        </span>
        <div className="relative flex-1 min-w-0 max-w-xs ml-2">
          <Search
            size={14}
            strokeWidth={1.8}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted"
            aria-hidden="true"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter containers…"
            className="w-full h-7 pl-7 pr-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-text-secondary select-none">
          <input
            type="checkbox"
            checked={session.showAll}
            onChange={() => toggleShowAll(session.sshSessionId)}
            className="accent-accent"
          />
          All
        </label>
        <button
          type="button"
          onClick={() => {
            void refreshContainers(session.sshSessionId, true);
            void refreshStats(session.sshSessionId, true);
          }}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-bg-overlay"
        >
          <RefreshCw size={13} strokeWidth={1.8} aria-hidden="true" />
          Refresh
        </button>
        {notice && (
          <span
            className={`ml-auto text-[11px] truncate max-w-[45%] ${notice.ok ? "text-status-connected" : "text-status-error"}`}
            title={notice.text}
          >
            {notice.text}
          </span>
        )}
      </div>

      {/* Permission banner */}
      {!session.docker.daemon && session.docker.needs_sudo && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-status-connecting/10 border-b border-border/60 text-status-connecting text-[11px]">
          <ShieldAlert size={13} strokeWidth={1.8} aria-hidden="true" />
          The docker daemon isn't reachable with the current user. Add yourself to the
          <span className="font-mono"> docker </span>
          group (or use sudo) and reconnect.
        </div>
      )}

      {/* Containers */}
      <div className="flex-1 min-h-0 overflow-auto border-b border-border/60">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-bg-surface">
            <tr className="text-text-muted">
              <th className="px-3 py-1.5 text-left font-medium">Container</th>
              <th className="px-3 py-1.5 text-left font-medium">Image</th>
              <th className="px-3 py-1.5 text-left font-medium">Status</th>
              <th className="px-3 py-1.5 text-left font-medium">Ports</th>
              <th className="px-3 py-1.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.id} className="border-t border-border/40 hover:bg-bg-overlay/60">
                <td className="px-3 py-1">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(c.state)}`} />
                    <span className="font-mono truncate max-w-[200px]" title={c.id}>
                      {c.names || c.id}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-1 text-text-secondary truncate max-w-[180px]" title={c.image}>
                  {c.image}
                </td>
                <td className="px-3 py-1">{c.status}</td>
                <td className="px-3 py-1 font-mono text-text-secondary truncate max-w-[180px]" title={c.ports}>
                  {c.ports || "—"}
                </td>
                <td className="px-3 py-1 text-right">
                  <span className="inline-flex items-center gap-1">
                    {ACTIONS.map(({ action, label, icon: Icon }) => (
                      <button
                        key={action}
                        type="button"
                        disabled={busy === `${action}:${c.id}`}
                        onClick={() => void run(c.id, action, label)}
                        title={`${label} ${c.names || c.id}`}
                        className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-overlay disabled:opacity-40"
                      >
                        {busy === `${action}:${c.id}` ? (
                          <Loader2 size={13} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
                        ) : (
                          <Icon size={13} strokeWidth={1.8} aria-hidden="true" />
                        )}
                      </button>
                    ))}
                    <button
                      type="button"
                      disabled={busy === `exec:${c.id}`}
                      onClick={() => void runExec(c.id)}
                      title="Open shell"
                      className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-overlay disabled:opacity-40"
                    >
                      {busy === `exec:${c.id}` ? (
                        <Loader2 size={13} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
                      ) : (
                        <TerminalSquare size={13} strokeWidth={1.8} aria-hidden="true" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => void openLogs(session.sshSessionId, c.id, 300)}
                      title="Follow logs"
                      className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-overlay"
                    >
                      <FileText size={13} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                    {confirmRemove === c.id ? (
                      <button
                        type="button"
                        onClick={() => void run(c.id, "remove", "Remove")}
                        className="px-1.5 py-0.5 rounded bg-status-error/15 text-status-error text-[11px] font-medium hover:bg-status-error/25"
                      >
                        Confirm
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRemove(c.id)}
                        title="Remove (forced)"
                        className="p-1 rounded text-text-muted hover:text-status-error hover:bg-status-error/10"
                      >
                        <Trash2 size={13} strokeWidth={1.8} aria-hidden="true" />
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-text-muted">
                  {session.containersLoading
                    ? "Loading…"
                    : session.containers.length === 0
                      ? "No containers. Start one and hit Refresh."
                      : "No containers match your filter."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Images */}
      <div className="shrink-0 max-h-40 overflow-auto">
        <div className="px-3 py-1.5 bg-bg-subtle border-b border-border/60 text-[10px] uppercase tracking-wider text-text-muted font-medium">
          Images ({session.images.length})
        </div>
        <table className="w-full border-collapse text-xs">
          <tbody>
            {session.images.slice(0, 100).map((img) => (
              <tr key={`${img.repository}:${img.tag}:${img.id}`} className="border-t border-border/40">
                <td className="px-3 py-0.5 font-mono truncate max-w-[260px]" title={`${img.repository}:${img.tag}`}>
                  {img.repository}:{img.tag}
                </td>
                <td className="px-3 py-0.5 font-mono text-text-muted">{img.id || "?"}</td>
                <td className="px-3 py-0.5 text-text-secondary text-right">{img.size}</td>
              </tr>
            ))}
            {session.images.length === 0 && (
              <tr>
                <td className="px-3 py-3 text-center text-text-muted">
                  {session.imagesLoading ? "Loading images…" : "No local images."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Logs viewer */}
      {Object.keys(session.dockerLogs).length > 0 && (
        <div className="shrink-0 h-56 border-t border-border/60 flex flex-col bg-bg-base">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-subtle border-b border-border/60 shrink-0">
            <span className="text-[10px] uppercase tracking-wider text-text-muted font-medium">Logs</span>
            {Object.entries(session.dockerLogs).some(([, v]) => v.live) && (
              <span className="inline-flex items-center gap-1 text-status-connected text-[11px]">
                <span className="w-1.5 h-1.5 rounded-full bg-status-connected animate-pulse" />
                live
              </span>
            )}
            <span className="ml-auto" />
            {Object.keys(session.dockerLogs).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => closeLogs(session.sshSessionId, key)}
                title="Stop following"
                className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-overlay"
              >
                <X size={13} strokeWidth={1.8} aria-hidden="true" />
              </button>
            ))}
          </div>
          {session.dockerLogError && (
            <div className="px-3 py-1 text-status-error text-[11px]">{session.dockerLogError}</div>
          )}
          {Object.entries(session.dockerLogs).map(([key, v]) => (
            <pre
              key={key}
              className="flex-1 min-h-0 overflow-auto px-3 py-1.5 font-mono text-[11px] leading-relaxed text-text-secondary whitespace-pre-wrap break-words"
            >
              {v.lines || "Waiting for logs…"}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}

function msg(err: unknown): string {
  return err && typeof err === "object" && "message" in err
    ? String((err as { message: string }).message)
    : "Action failed";
}