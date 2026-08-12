import { useMemo, useState } from "react";
import { Search, RefreshCw, Trash2, Loader2 } from "lucide-react";
import type { ProcessInfo } from "../../types";
import type { ToolsSession } from "../../stores/tools-store";
import { useToolsStore } from "../../stores/tools-store";
import { formatBytes } from "../../utils/format";

interface Props {
  session: ToolsSession;
}

type SortKey = "pid" | "cpu_pct" | "mem_pct" | "rss_kb" | "name";
type SortDir = "asc" | "desc";

export function ProcessManager({ session }: Props) {
  const refreshProcesses = useToolsStore((s) => s.refreshProcesses);
  const killProcess = useToolsStore((s) => s.killProcess);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("cpu_pct");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [confirmPid, setConfirmPid] = useState<number | null>(null);
  const [busyPid, setBusyPid] = useState<number | null>(null);
  const [signal, setSignal] = useState<string>("TERM");
  const [notice, setNotice] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (q
      ? session.processes.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.user.toLowerCase().includes(q) ||
            String(p.pid).includes(q),
        )
      : session.processes
    ).slice();
    list.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "pid":
          cmp = a.pid - b.pid;
          break;
        case "cpu_pct":
          cmp = a.cpu_pct - b.cpu_pct;
          break;
        case "mem_pct":
          cmp = a.mem_pct - b.mem_pct;
          break;
        case "rss_kb":
          cmp = a.rss_kb - b.rss_kb;
          break;
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [session.processes, search, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const doKill = async (proc: ProcessInfo) => {
    setBusyPid(proc.pid);
    setNotice(null);
    try {
      const res = await killProcess(session.sshSessionId, proc.pid, signal);
      setNotice(
        res.ok
          ? `Sent SIG${signal} to ${proc.name} (${proc.pid})`
          : `Failed: ${res.message}`,
      );
      // Refresh so the row disappears (or stays) truthfully.
      await refreshProcesses(session.sshSessionId, true);
    } catch (err) {
      const m =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Kill failed";
      setNotice(`Failed: ${m}`);
    } finally {
      setBusyPid(null);
      setConfirmPid(null);
    }
  };

  if (session.processes.length === 0 && session.processesLoading) {
    return (
      <div className="p-8 text-center text-text-muted">
        <Loader2 size={20} strokeWidth={1.6} className="animate-spin mx-auto" />
        <p className="mt-3 text-sm">Loading processes…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 bg-bg-subtle border-b border-border/60">
        <div className="relative flex-1 min-w-0 max-w-xs">
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
            placeholder="Filter by name, user, or PID…"
            className="w-full h-7 pl-7 pr-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <button
          type="button"
          onClick={() => void refreshProcesses(session.sshSessionId, true)}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-bg-overlay"
        >
          <RefreshCw size={13} strokeWidth={1.8} aria-hidden="true" />
          Refresh
        </button>
        {notice && (
          <span className="ml-auto text-[11px] text-text-muted truncate max-w-[40%]" title={notice}>
            {notice}
          </span>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-bg-surface">
            <tr className="text-text-muted">
              <Th label="PID" active={sortKey === "pid"} dir={sortDir} onClick={() => toggleSort("pid")} />
              <Th label="Name" active={sortKey === "name"} dir={sortDir} onClick={() => toggleSort("name")} />
              <Th label="User" />
              <Th label="CPU%" active={sortKey === "cpu_pct"} dir={sortDir} onClick={() => toggleSort("cpu_pct")} />
              <Th label="MEM%" active={sortKey === "mem_pct"} dir={sortDir} onClick={() => toggleSort("mem_pct")} />
              <Th label="RSS" active={sortKey === "rss_kb"} dir={sortDir} onClick={() => toggleSort("rss_kb")} />
              <Th label="State" />
              <Th label="" />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr
                key={p.pid}
                className="border-t border-border/40 hover:bg-bg-overlay/60 data-[zooming=true]:bg-amber-400/5"
              >
                <td className="px-3 py-1 font-mono tabular-nums">{p.pid}</td>
                <td className="px-3 py-1 truncate max-w-[220px]" title={p.name}>
                  {p.name}
                </td>
                <td className="px-3 py-1 text-text-secondary">{p.user}</td>
                <td className="px-3 py-1 tabular-nums">{p.cpu_pct.toFixed(1)}</td>
                <td className="px-3 py-1 tabular-nums">{p.mem_pct.toFixed(1)}</td>
                <td className="px-3 py-1 tabular-nums text-text-secondary">
                  {formatBytes(p.rss_kb * 1024)}
                </td>
                <td className="px-3 py-1 font-mono text-text-secondary">{p.state}</td>
                <td className="px-3 py-1 text-right">
                  {busyPid === p.pid ? (
                    <Loader2 size={14} strokeWidth={1.8} className="animate-spin mx-auto" aria-hidden="true" />
                  ) : confirmPid === p.pid ? (
                    <span className="inline-flex items-center gap-1.5">
                      {/* Signal selector */}
                      <select
                        value={signal}
                        onChange={(e) => setSignal(e.target.value)}
                        className="h-5 px-1 rounded bg-bg-surface border border-border/60 text-[11px] text-text-primary focus:outline-none"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <option value="TERM">SIGTERM (15)</option>
                        <option value="KILL">SIGKILL (9)</option>
                        <option value="HUP">SIGHUP (1)</option>
                        <option value="INT">SIGINT (2)</option>
                        <option value="STOP">SIGSTOP (19)</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => void doKill(p)}
                        className="px-2 py-0.5 rounded bg-status-error/15 text-status-error text-[11px] font-medium hover:bg-status-error/25"
                      >
                        Send
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmPid(null)}
                        className="px-2 py-0.5 rounded text-[11px] text-text-muted hover:text-text-primary"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmPid(p.pid)}
                      title={`Kill ${p.pid} (TERM)`}
                      className="p-1 rounded text-text-muted hover:text-status-error hover:bg-status-error/10"
                    >
                      <Trash2 size={13} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-text-muted">
                  {session.processes.length === 0
                    ? "No processes returned by the remote."
                    : "No processes match your filter."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active?: boolean;
  dir?: SortDir;
  onClick?: () => void;
}) {
  const cls = onClick
    ? "cursor-pointer select-none hover:text-text-primary"
    : "";
  return (
    <th
      className={`px-3 py-1.5 text-left font-medium ${cls} ${active ? "text-text-primary" : ""}`}
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && dir === "asc" ? "↑" : active && dir === "desc" ? "↓" : null}
      </span>
    </th>
  );
}