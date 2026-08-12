import { useEffect, useState, useMemo } from "react";
import {
  Router,
  Radar,
  ScanSearch,
  Timer,
  Loader2,
  ShieldAlert,
  RefreshCw,
  Globe,
  Radio,
  Search,
  Activity,
} from "lucide-react";
import { useToolsStore } from "../../stores/tools-store";
import type { ToolsSession } from "../../stores/tools-store";

interface Props {
  session: ToolsSession;
}

const RECORD_TYPES = ["A", "AAAA", "MX", "TXT", "CNAME", "NS"];

const PRESETS: { label: string; value: string }[] = [
  { label: "SSH + web", value: "22,80,443,8080,8443" },
  { label: "Databases", value: "3306,5432,6379,1433,27017,1521" },
  { label: "Mail", value: "25,110,143,465,587,993,995" },
  { label: "Docker / K8s", value: "2375,2376,6443,10250" },
  { label: "Common (top 40)", value: "20,21,22,23,25,53,80,110,111,135,137,139,143,161,389,443,445,465,514,587,636,873,993,995,1433,1521,2049,3000,3306,3389,5432,5900,6379,6443,8080,8443,8888,9090,9200,27017" },
  { label: "Full 1–1024", value: "1-1024" },
];

type NetSubTab = "ports" | "scanner" | "ping" | "dns";

export function NetworkPanel({ session }: Props) {
  const loadAvailability = useToolsStore((s) => s.loadNetworkAvailability);
  const fetchListeningPorts = useToolsStore((s) => s.fetchListeningPorts);
  const runPortScan = useToolsStore((s) => s.runPortScan);
  const runPing = useToolsStore((s) => s.runPing);
  const runTraceroute = useToolsStore((s) => s.runTraceroute);
  const runDnsLookup = useToolsStore((s) => s.runDnsLookup);

  const defaultTarget = session.hostConfig.host;
  const [subTab, setSubTab] = useState<NetSubTab>("ports");

  // Scanner state
  const [scanTarget, setScanTarget] = useState(defaultTarget);
  const [ports, setPorts] = useState(PRESETS[0].value);
  const [strategy, setStrategy] = useState("auto");
  const [scanBusy, setScanBusy] = useState(false);

  // Ping state
  const [pingTarget, setPingTarget] = useState(defaultTarget);
  const [pingBusy, setPingBusy] = useState(false);
  const [traceTarget, setTraceTarget] = useState(defaultTarget);
  const [traceBusy, setTraceBusy] = useState(false);

  // DNS state
  const [dnsTarget, setDnsTarget] = useState("google.com");
  const [dnsRecord, setDnsRecord] = useState("A");
  const [dnsBusy, setDnsBusy] = useState(false);

  // Ports filter
  const [portFilter, setPortFilter] = useState("");

  useEffect(() => {
    void loadAvailability(session.sshSessionId).then(() => {
      void fetchListeningPorts(session.sshSessionId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sshSessionId]);

  const filteredListening = useMemo(() => {
    const q = portFilter.trim().toLowerCase();
    if (!q) return session.listeningPorts;
    return session.listeningPorts.filter(
      (p) =>
        p.process.toLowerCase().includes(q) ||
        p.proto.toLowerCase().includes(q) ||
        p.address.toLowerCase().includes(q) ||
        String(p.port).includes(q) ||
        (p.pid && String(p.pid).includes(q)),
    );
  }, [session.listeningPorts, portFilter]);

  if (!session.netAvailable && session.netLoading) {
    return (
      <div className="p-8 text-center text-text-muted">
        <Loader2 size={20} strokeWidth={1.6} className="animate-spin mx-auto" />
        <p className="mt-3 text-sm">Probing remote network capabilities…</p>
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

  const doDns = async () => {
    setDnsBusy(true);
    try {
      await runDnsLookup(session.sshSessionId, dnsTarget, dnsRecord);
    } finally {
      setDnsBusy(false);
    }
  };

  const stateColor = (state: string) => {
    if (state === "open") return "text-status-connected";
    if (state === "closed") return "text-text-muted";
    return "text-status-connecting";
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg-base">
      {session.netError && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-status-error/10 border-b border-border/60 text-status-error text-[11px] shrink-0">
          <ShieldAlert size={13} strokeWidth={1.8} aria-hidden="true" />
          {session.netError}
        </div>
      )}

      {/* Module selector bar */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-bg-subtle border-b border-border/60 shrink-0">
        <button
          type="button"
          onClick={() => setSubTab("ports")}
          className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium transition-colors ${subTab === "ports" ? "bg-accent/15 text-accent" : "text-text-secondary hover:text-text-primary hover:bg-bg-overlay"}`}
        >
          <Radio size={13} />
          Listening Ports ({session.listeningPorts.length})
        </button>
        <button
          type="button"
          onClick={() => setSubTab("scanner")}
          className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium transition-colors ${subTab === "scanner" ? "bg-accent/15 text-accent" : "text-text-secondary hover:text-text-primary hover:bg-bg-overlay"}`}
        >
          <Radar size={13} />
          Port Scanner
        </button>
        <button
          type="button"
          onClick={() => setSubTab("ping")}
          className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium transition-colors ${subTab === "ping" ? "bg-accent/15 text-accent" : "text-text-secondary hover:text-text-primary hover:bg-bg-overlay"}`}
        >
          <Activity size={13} />
          Ping & Trace
        </button>
        <button
          type="button"
          onClick={() => setSubTab("dns")}
          className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium transition-colors ${subTab === "dns" ? "bg-accent/15 text-accent" : "text-text-secondary hover:text-text-primary hover:bg-bg-overlay"}`}
        >
          <Globe size={13} />
          DNS Lookup
        </button>

        <span className="ml-auto" />

        {subTab === "ports" && (
          <button
            type="button"
            onClick={() => void fetchListeningPorts(session.sshSessionId)}
            className="flex items-center gap-1 h-7 px-2 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-bg-overlay"
          >
            <RefreshCw size={12} className={session.listeningPortsLoading ? "animate-spin" : ""} />
            Refresh
          </button>
        )}
      </div>

      {/* Main Body */}
      <div className="flex-1 min-h-0 overflow-auto p-3">
        {/* Module 1: Listening Ports */}
        {subTab === "ports" && (
          <div className="space-y-3 h-full flex flex-col">
            <div className="flex items-center gap-2 shrink-0">
              <div className="relative flex-1 min-w-0 max-w-xs">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
                <input
                  type="text"
                  value={portFilter}
                  onChange={(e) => setPortFilter(e.target.value)}
                  placeholder="Filter by port, process, or address…"
                  className="w-full h-7 pl-8 pr-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary placeholder:text-text-muted outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              <span className="text-[11px] text-text-muted">
                Source: <span className="font-mono">ss -tulpn</span>
              </span>
            </div>

            <div className="flex-1 min-h-0 overflow-auto border border-border/60 rounded-lg bg-bg-surface">
              <table className="w-full text-xs font-mono border-collapse">
                <thead className="sticky top-0 bg-bg-subtle border-b border-border/60">
                  <tr className="text-text-muted text-left">
                    <th className="px-3 py-1.5">Proto</th>
                    <th className="px-3 py-1.5">Port</th>
                    <th className="px-3 py-1.5">Bind Address</th>
                    <th className="px-3 py-1.5">PID</th>
                    <th className="px-3 py-1.5">Process Name</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredListening.map((p, i) => (
                    <tr key={`${p.proto}-${p.address}-${p.port}-${i}`} className="border-t border-border/40 hover:bg-bg-overlay/50">
                      <td className="px-3 py-1 text-text-muted uppercase text-[10px]">{p.proto}</td>
                      <td className="px-3 py-1 font-semibold text-accent">{p.port}</td>
                      <td className="px-3 py-1 text-text-secondary">{p.address}</td>
                      <td className="px-3 py-1 text-text-muted">{p.pid ?? "—"}</td>
                      <td className="px-3 py-1 text-text-primary font-medium">{p.process || "—"}</td>
                    </tr>
                  ))}
                  {filteredListening.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-text-muted">
                        {session.listeningPortsLoading
                          ? "Probing listening ports…"
                          : session.listeningPorts.length === 0
                            ? "No listening sockets detected."
                            : "No ports match your filter."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Module 2: Scanner */}
        {subTab === "scanner" && (
          <div className="space-y-4 max-w-4xl">
            <div className="flex items-center gap-2">
              <Radar size={15} className="text-status-connected" />
              <h3 className="text-xs font-semibold text-text-primary">Port scanner</h3>
              {av && (
                <span className="text-[10px] text-text-muted">
                  via {av.nmap ? "nmap" : av.nc ? "nc" : "—"}
                </span>
              )}
            </div>

            <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-end">
              <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                Target
                <input
                  type="text"
                  value={scanTarget}
                  onChange={(e) => setScanTarget(e.target.value)}
                  placeholder={defaultTarget}
                  spellCheck={false}
                  className="h-8 px-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary placeholder:text-text-muted outline-none focus:ring-1 focus:ring-ring font-mono"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                Ports
                <input
                  type="text"
                  list="port-presets"
                  value={ports}
                  onChange={(e) => setPorts(e.target.value)}
                  spellCheck={false}
                  className="h-8 w-64 px-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary outline-none focus:ring-1 focus:ring-ring font-mono"
                />
                <datalist id="port-presets">
                  {PRESETS.map((p) => (
                    <option key={p.label} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </datalist>
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                Strategy
                <select
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value)}
                  className="h-8 px-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="auto">auto</option>
                  <option value="nmap" disabled={!av?.nmap}>
                    nmap{av?.nmap ? "" : " (missing)"}
                  </option>
                  <option value="nc" disabled={!av?.nc}>
                    nc{av?.nc ? "" : " (missing)"}
                  </option>
                </select>
              </label>
              <button
                type="button"
                disabled={scanBusy || !av?.can_scan}
                onClick={() => void doScan()}
                className="h-8 px-4 rounded-md bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 disabled:opacity-40 flex items-center gap-1.5"
              >
                {scanBusy ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <ScanSearch size={13} />
                )}
                Scan Target
              </button>
            </div>

            {session.lastScan && (
              <div className="space-y-2">
                <p className="text-[11px] text-text-muted">
                  {session.lastScan.ports.length} ports · {session.lastScan.strategy} · {(session.lastScan.duration_ms / 1000).toFixed(1)}s · {session.lastScan.target}
                </p>
                <div className="rounded-lg border border-border/60 overflow-auto max-h-72">
                  <table className="w-full border-collapse text-xs">
                    <thead className="sticky top-0 bg-bg-surface">
                      <tr className="text-text-muted text-left">
                        <th className="px-3 py-1.5 font-medium">Port</th>
                        <th className="px-3 py-1.5 font-medium">State</th>
                        <th className="px-3 py-1.5 font-medium">Service</th>
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
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Module 3: Ping & Traceroute */}
        {subTab === "ping" && (
          <div className="space-y-6 max-w-4xl">
            {/* Ping */}
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Activity size={15} className="text-status-connected" />
                <h3 className="text-xs font-semibold text-text-primary">Ping ICMP Probe</h3>
              </div>
              <div className="flex items-end gap-2">
                <label className="flex flex-col gap-1 text-[11px] text-text-muted flex-1">
                  Target IP / Host
                  <input
                    type="text"
                    value={pingTarget}
                    onChange={(e) => setPingTarget(e.target.value)}
                    placeholder={defaultTarget}
                    spellCheck={false}
                    className="h-8 px-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary font-mono outline-none focus:ring-1 focus:ring-ring"
                  />
                </label>
                <button
                  type="button"
                  disabled={pingBusy || !av?.ping}
                  onClick={() => void doPing()}
                  className="h-8 px-4 rounded-md bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 disabled:opacity-40 flex items-center gap-1.5"
                >
                  {pingBusy && <Loader2 size={13} className="animate-spin" />}
                  Ping
                </button>
              </div>

              {session.lastPing && (
                <div className="p-3 rounded-lg border border-border/60 bg-bg-subtle text-xs space-y-2">
                  <p className="text-text-secondary">
                    {session.lastPing.transmitted} sent, {session.lastPing.received} rcvd,{" "}
                    <span className={session.lastPing.loss_pct > 0 ? "text-status-error font-semibold" : "text-status-connected font-semibold"}>
                      {session.lastPing.loss_pct.toFixed(0)}% loss
                    </span>
                    {session.lastPing.rtt_avg !== null &&
                      ` · avg ${session.lastPing.rtt_avg.toFixed(1)}ms (min ${session.lastPing.rtt_min?.toFixed(1)} / max ${session.lastPing.rtt_max?.toFixed(1)})`}
                  </p>
                  <div className="flex gap-4 flex-wrap">
                    {session.lastPing.replies.map((r) => (
                      <span key={r.seq} className="text-text-muted font-mono text-[11px]">
                        seq={r.seq}{" "}
                        <span className={r.time_ms === null ? "text-status-error" : "text-status-connected font-semibold"}>
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
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Timer size={15} className="text-status-connected" />
                <h3 className="text-xs font-semibold text-text-primary">Traceroute</h3>
              </div>
              <div className="flex items-end gap-2">
                <label className="flex flex-col gap-1 text-[11px] text-text-muted flex-1">
                  Target Host
                  <input
                    type="text"
                    value={traceTarget}
                    onChange={(e) => setTraceTarget(e.target.value)}
                    placeholder={defaultTarget}
                    spellCheck={false}
                    className="h-8 px-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary font-mono outline-none focus:ring-1 focus:ring-ring"
                  />
                </label>
                <button
                  type="button"
                  disabled={traceBusy || !av?.traceroute}
                  onClick={() => void doTrace()}
                  className="h-8 px-4 rounded-md bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 disabled:opacity-40 flex items-center gap-1.5"
                >
                  {traceBusy && <Loader2 size={13} className="animate-spin" />}
                  Trace Hops
                </button>
              </div>

              {session.lastTrace && (
                <div className="rounded-lg border border-border/60 overflow-auto max-h-60">
                  <table className="w-full text-xs font-mono border-collapse">
                    <thead className="sticky top-0 bg-bg-surface">
                      <tr className="text-text-muted text-left">
                        <th className="px-3 py-1.5 font-medium">Hop</th>
                        <th className="px-3 py-1.5 font-medium">RTT 1</th>
                        <th className="px-3 py-1.5 font-medium">RTT 2</th>
                        <th className="px-3 py-1.5 font-medium">RTT 3</th>
                      </tr>
                    </thead>
                    <tbody>
                      {session.lastTrace.hops.map((h) => (
                        <tr key={h.hop} className="border-t border-border/40">
                          <td className="px-3 py-1">{h.hop}</td>
                          {[0, 1, 2].map((i) => {
                            const v = h.rtts[i];
                            return (
                              <td key={i} className="px-3 py-1 text-text-secondary">
                                {v === null ? "*" : v === undefined ? "·" : `${v.toFixed(1)}ms`}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}

        {/* Module 4: DNS Lookup */}
        {subTab === "dns" && (
          <div className="space-y-4 max-w-3xl">
            <div className="flex items-center gap-2">
              <Globe size={15} className="text-status-connected" />
              <h3 className="text-xs font-semibold text-text-primary">DNS Record Lookup</h3>
            </div>

            <div className="flex items-end gap-2">
              <label className="flex flex-col gap-1 text-[11px] text-text-muted flex-1">
                Domain Name
                <input
                  type="text"
                  value={dnsTarget}
                  onChange={(e) => setDnsTarget(e.target.value)}
                  placeholder="e.g. google.com"
                  spellCheck={false}
                  className="h-8 px-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary font-mono outline-none focus:ring-1 focus:ring-ring"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-text-muted">
                Record Type
                <select
                  value={dnsRecord}
                  onChange={(e) => setDnsRecord(e.target.value)}
                  className="h-8 px-2 rounded-md bg-bg-surface border border-border/60 text-xs text-text-primary font-mono outline-none focus:ring-1 focus:ring-ring"
                >
                  {RECORD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={dnsBusy}
                onClick={() => void doDns()}
                className="h-8 px-4 rounded-md bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 disabled:opacity-40 flex items-center gap-1.5"
              >
                {dnsBusy && <Loader2 size={13} className="animate-spin" />}
                Lookup
              </button>
            </div>

            {session.lastDns && (
              <div className="p-3 rounded-lg border border-border/60 bg-bg-subtle space-y-2 select-text">
                <div className="flex items-center justify-between text-[11px] text-text-muted border-b border-border/40 pb-1.5">
                  <span>Query: <strong className="text-text-primary font-mono">{session.lastDns.query}</strong> ({session.lastDns.record_type})</span>
                </div>
                <pre className="text-xs font-mono whitespace-pre-wrap break-words text-text-primary selection:bg-accent/30">
                  {session.lastDns.result || "(no record returned)"}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 bg-bg-subtle border-t border-border/60 text-[10px] text-text-muted flex items-center gap-2 shrink-0">
        <Router size={11} />
        <span>{av?.message || "Remote Network Management Toolkit"}</span>
      </div>
    </div>
  );
}