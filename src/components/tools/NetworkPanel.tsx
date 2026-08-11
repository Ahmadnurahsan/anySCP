import { useEffect, useState } from "react";
import {
  Router,
  Radar,
  ScanSearch,
  Timer,
  Loader2,
  ShieldAlert,
  RefreshCw,
} from "lucide-react";
import { useToolsStore } from "../../stores/tools-store";
import type { ToolsSession } from "../../stores/tools-store";

interface Props {
  session: ToolsSession;
}

const PRESETS: { label: string; value: string }[] = [
  { label: "SSH + web", value: "22,80,443,8080,8443" },
  { label: "Databases", value: "3306,5432,6379,1433,27017,1521" },
  { label: "Mail", value: "25,110,143,465,587,993,995" },
  { label: "Docker / K8s", value: "2375,2376,6443,10250" },
  { label: "Common (top 40)", value: "20,21,22,23,25,53,80,110,111,135,137,139,143,161,389,443,445,465,514,587,636,873,993,995,1433,1521,2049,3000,3306,3389,5432,5900,6379,6443,8080,8443,8888,9090,9200,27017" },
  { label: "Full 1–1024", value: "1-1024" },
];

export function NetworkPanel({ session }: Props) {
  const loadAvailability = useToolsStore((s) => s.loadNetworkAvailability);
  const runPortScan = useToolsStore((s) => s.runPortScan);
  const runPing = useToolsStore((s) => s.runPing);
  const runTraceroute = useToolsStore((s) => s.runTraceroute);

  const defaultTarget = session.hostConfig.host;
  const [scanTarget, setScanTarget] = useState(defaultTarget);
  const [ports, setPorts] = useState(PRESETS[0].value);
  const [strategy, setStrategy] = useState("auto");
  const [scanBusy, setScanBusy] = useState(false);
  const [pingTarget, setPingTarget] = useState(defaultTarget);
  const [pingBusy, setPingBusy] = useState(false);
  const [traceTarget, setTraceTarget] = useState(defaultTarget);
  const [traceBusy, setTraceBusy] = useState(false);

  useEffect(() => {
    void loadAvailability(session.sshSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sshSessionId]);

  if (!session.netAvailable) {
    return (
      <div className="p-8 text-center text-text-muted">
        <Loader2 size={20} strokeWidth={1.6} className="animate-spin mx-auto" />
        <p className="mt-3 text-sm">
          {session.netLoading ? "Probing remote network tools…" : "Checking…"}
        </p>
      </div>
    );
  }

  const av = session.netAvailable;

  const doScan = async () => {
    setScanBusy(true);
    try {
      await runPortScan(session.sshSessionId, scanTarget || defaultTarget, ports, strategy);
    } finally {
      setScanBusy(false);
    }
  };

  const doPing = async () => {
    setPingBusy(true);
    try {
      await runPing(session.sshSessionId, pingTarget || defaultTarget, 4);
    } finally {
      setPingBusy(false);
    }
  };

  const doTrace = async () => {
    setTraceBusy(true);
    try {
      await runTraceroute(session.sshSessionId, traceTarget || defaultTarget);
    } finally {
      setTraceBusy(false);
    }
  };

  const stateColor = (state: string) => {
    if (state === "open") return "text-status-connected";
    if (state === "closed") return "text-text-muted";
    return "text-status-connecting";
  };

  return (
    <div className="flex flex-col h-full overflow-auto">
      {session.netError && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-status-error/10 border-b border-border/60 text-status-error text-[11px]">
          <ShieldAlert size={13} strokeWidth={1.8} aria-hidden="true" />
          {session.netError}
        </div>
      )}

      {/* Port scanner */}
      <section className="p-4 border-b border-border/60">
        <div className="flex items-center gap-2 mb-3">
          <Radar size={14} strokeWidth={1.8} className="text-status-connected" aria-hidden="true" />
          <h3 className="text-xs font-semibold text-text-primary">Port scanner</h3>
          <span className="text-[10px] text-text-muted">
            via {av.nmap ? "nmap" : av.nc ? "nc" : "—"}
          </span>
        </div>

        <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-end max-w-3xl">
          <label className="flex flex-col gap-1 text-[11px] text-text-muted">
            Target
            <input
              type="text"
              value={scanTarget}
              onChange={(e) => setScanTarget(e.target.value)}
              placeholder={defaultTarget}
              spellCheck={false}
              className="h-8 px-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-text-muted">
            Ports
            <div className="relative">
              <input
                type="text"
                list="port-presets"
                value={ports}
                onChange={(e) => setPorts(e.target.value)}
                spellCheck={false}
                className="h-8 w-64 px-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-ring font-mono"
              />
              <datalist id="port-presets">
                {PRESETS.map((p) => (
                  <option key={p.label} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </datalist>
            </div>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-text-muted">
            Strategy
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              className="h-8 px-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="auto">auto</option>
              <option value="nmap" disabled={!av.nmap}>
                nmap{av.nmap ? "" : " (missing)"}
              </option>
              <option value="nc" disabled={!av.nc}>
                nc{av.nc ? "" : " (missing)"}
              </option>
            </select>
          </label>
          <button
            type="button"
            disabled={scanBusy || !av.can_scan}
            onClick={() => void doScan()}
            className="h-8 px-3 rounded-md bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 disabled:opacity-40 flex items-center gap-1.5"
          >
            {scanBusy ? (
              <Loader2 size={13} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
            ) : (
              <ScanSearch size={13} strokeWidth={1.8} aria-hidden="true" />
            )}
            Scan
          </button>
        </div>

        {!av.can_scan && (
          <p className="mt-2 text-[11px] text-status-error">
            Install <span className="font-mono">nmap</span> or{" "}
            <span className="font-mono">nc</span> on the host to scan.
          </p>
        )}

        {session.lastScan && (
          <div className="mt-3">
            <p className="text-[11px] text-text-muted mb-1.5">
              {session.lastScan.ports.length} ports ·{" "}
              {session.lastScan.strategy} · {(session.lastScan.duration_ms / 1000).toFixed(1)}s ·{" "}
              {session.lastScan.target}
            </p>
            <div className="max-h-56 overflow-auto rounded-lg border border-border/60">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 bg-bg-surface">
                  <tr className="text-text-muted">
                    <th className="px-3 py-1.5 text-left font-medium">Port</th>
                    <th className="px-3 py-1.5 text-left font-medium">State</th>
                    <th className="px-3 py-1.5 text-left font-medium">Service</th>
                  </tr>
                </thead>
                <tbody>
                  {session.lastScan.ports.map((p) => (
                    <tr key={p.port} className="border-t border-border/40">
                      <td className="px-3 py-1 font-mono">{p.port}</td>
                      <td className={`px-3 py-1 font-medium ${stateColor(p.state)}`}>{p.state}</td>
                      <td className="px-3 py-1 text-text-secondary">{p.service || "—"}</td>
                    </tr>
                  ))}
                  {session.lastScan.ports.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-3 py-6 text-center text-text-muted">
                        No results — all filtered or nothing matched.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Ping */}
      <section className="p-4 border-b border-border/60">
        <div className="flex items-center gap-2 mb-3">
          <RefreshCw size={14} strokeWidth={1.8} className="text-status-connected" aria-hidden="true" />
          <h3 className="text-xs font-semibold text-text-primary">Ping</h3>
          {av.ping ? null : <span className="text-[10px] text-status-error">ping missing</span>}
        </div>
        <div className="flex items-end gap-2 max-w-3xl">
          <label className="flex flex-col gap-1 text-[11px] text-text-muted flex-1">
            Target
            <input
              type="text"
              value={pingTarget}
              onChange={(e) => setPingTarget(e.target.value)}
              placeholder={defaultTarget}
              spellCheck={false}
              className="h-8 px-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
          </label>
          <button
            type="button"
            disabled={pingBusy || !av.ping}
            onClick={() => void doPing()}
            className="h-8 px-3 rounded-md bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 disabled:opacity-40 flex items-center gap-1.5"
          >
            {pingBusy && <Loader2 size={13} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />}
            Ping
          </button>
        </div>
        {session.lastPing && (
          <div className="mt-3 text-xs space-y-1">
            <p className="text-text-secondary">
              {session.lastPing.transmitted} transmitted, {session.lastPing.received} received,{" "}
              <span className={session.lastPing.loss_pct > 0 ? "text-status-error" : "text-status-connected"}>
                {session.lastPing.loss_pct.toFixed(0)}% loss
              </span>
              {session.lastPing.rtt_avg !== null &&
                ` · avg ${session.lastPing.rtt_avg.toFixed(1)}ms (min ${session.lastPing.rtt_min?.toFixed(1)} / max ${session.lastPing.rtt_max?.toFixed(1)})`}
            </p>
            <div className="flex gap-4 flex-wrap">
              {session.lastPing.replies.map((r) => (
                <span key={r.seq} className="text-text-muted font-mono">
                  seq={r.seq}{" "}
                  <span className={r.time_ms === null ? "text-status-error" : "text-status-connected"}>
                    {r.time_ms === null ? "timeout" : `${r.time_ms.toFixed(1)}ms`}
                  </span>
                  {r.ttl !== null && ` ttl=${r.ttl}`}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Traceroute */}
      <section className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Timer size={14} strokeWidth={1.8} className="text-status-connected" aria-hidden="true" />
          <h3 className="text-xs font-semibold text-text-primary">Traceroute</h3>
          {av.traceroute ? null : (
            <span className="text-[10px] text-status-error">traceroute missing</span>
          )}
        </div>
        <div className="flex items-end gap-2 max-w-3xl">
          <label className="flex flex-col gap-1 text-[11px] text-text-muted flex-1">
            Target
            <input
              type="text"
              value={traceTarget}
              onChange={(e) => setTraceTarget(e.target.value)}
              placeholder={defaultTarget}
              spellCheck={false}
              className="h-8 px-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
          </label>
          <button
            type="button"
            disabled={traceBusy || !av.traceroute}
            onClick={() => void doTrace()}
            className="h-8 px-3 rounded-md bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 disabled:opacity-40 flex items-center gap-1.5"
          >
            {traceBusy && <Loader2 size={13} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />}
            Trace
          </button>
        </div>
        {session.lastTrace && (
          <div className="mt-3 max-h-56 overflow-auto rounded-lg border border-border/60">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-bg-surface">
                <tr className="text-text-muted">
                  <th className="px-3 py-1.5 text-left font-medium">Hop</th>
                  <th className="px-3 py-1.5 text-left font-medium">RTT 1</th>
                  <th className="px-3 py-1.5 text-left font-medium">RTT 2</th>
                  <th className="px-3 py-1.5 text-left font-medium">RTT 3</th>
                </tr>
              </thead>
              <tbody>
                {session.lastTrace.hops.map((h) => (
                  <tr key={h.hop} className="border-t border-border/40">
                    <td className="px-3 py-1 font-mono">{h.hop}</td>
                    {[0, 1, 2].map((i) => {
                      const v = h.rtts[i];
                      return (
                        <td key={i} className="px-3 py-1 font-mono text-text-secondary">
                          {v === null ? "*" : v === undefined ? "·" : `${v.toFixed(1)}ms`}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {session.lastTrace.hops.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-text-muted">
                      {session.lastTrace.error ?? "No output."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Capability footer */}
      <div className="mt-auto px-4 pb-3 flex items-center gap-2 text-[11px] text-text-muted">
        <Router size={12} strokeWidth={1.8} aria-hidden="true" />
        {av.message}
      </div>
    </div>
  );
}