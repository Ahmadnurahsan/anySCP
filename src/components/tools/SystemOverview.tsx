import { Activity, Cpu, MemoryStick, HardDrive, Clock } from "lucide-react";
import type { ToolsSession } from "../../stores/tools-store";
import { useToolsStore } from "../../stores/tools-store";
import { formatBytes, formatDuration, formatPct } from "../../utils/format";

interface Props {
  session: ToolsSession;
}

export function SystemOverview({ session }: Props) {
  const refreshOverview = useToolsStore((s) => s.refreshOverview);
  const ov = session.overview;

  if (!ov) {
    if (session.overviewLoading) {
      return <Loading />;
    }
    return (
      <div className="p-8 text-center text-text-muted">
        <p>No system data yet.</p>
        <button
          type="button"
          onClick={() => void refreshOverview(session.sshSessionId)}
          className="mt-3 px-3 py-1.5 rounded-md bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25"
        >
          Refresh
        </button>
      </div>
    );
  }

  const memUsedPct =
    ov.mem_total_bytes > 0
      ? (ov.mem_used_bytes / ov.mem_total_bytes) * 100
      : 0;

  return (
    <div className="p-4 space-y-4">
      {/* Host summary */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <Activity size={15} strokeWidth={1.8} className="text-status-connected" aria-hidden="true" />
          <span className="text-sm font-medium">{ov.hostname}</span>
        </div>
        {ov.os_name && <span className="text-xs text-text-muted">{ov.os_name} · {ov.kernel}</span>}
        <span className="flex items-center gap-1.5 text-xs text-text-muted">
          <Clock size={13} strokeWidth={1.8} aria-hidden="true" />
          up {formatDuration(ov.uptime_secs)}
        </span>
        {session.error && (
          <span className="text-[11px] text-status-error truncate" title={session.error}>
            {session.error}
          </span>
        )}
      </div>

      {/* Metric tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile
          icon={Cpu}
          label="CPU"
          value={
            ov.cpu_usage_pct != null
              ? `${formatPct(ov.cpu_usage_pct)}%`
              : "—"
          }
          sub={`${ov.cpu_cores ?? "?"} cores`}
        />
        <Tile
          icon={MemoryStick}
          label="Memory"
          value={`${formatPct(memUsedPct)}%`}
          sub={`${formatBytes(ov.mem_used_bytes)} / ${formatBytes(ov.mem_total_bytes)}`}
        />
        <Tile
          icon={HardDrive}
          label="Swap"
          value={
            ov.swap_total_bytes > 0
              ? `${formatPct((ov.swap_used_bytes / ov.swap_total_bytes) * 100)}%`
              : "off"
          }
          sub={`${formatBytes(ov.swap_used_bytes)} / ${formatBytes(ov.swap_total_bytes)}`}
        />
        <Tile
          icon={Activity}
          label="Load"
          value={ov.load_15 != null ? formatPct(ov.load_15) : "—"}
          sub={
            ov.load_1 != null && ov.load_5 != null
              ? `${formatPct(ov.load_1)} / ${formatPct(ov.load_5)} / ${formatPct(ov.load_15 ?? 0)} (1/5/15)`
              : "—"
          }
        />
      </div>

      {/* CPU bar */}
      {ov.cpu_usage_pct != null && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span>CPU</span>
            <span>{formatPct(ov.cpu_usage_pct)}%</span>
          </div>
          <div className="h-2 rounded-full bg-bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                ov.cpu_usage_pct >= 90
                  ? "bg-status-error"
                  : ov.cpu_usage_pct >= 70
                    ? "bg-status-connecting"
                    : "bg-accent/80"
              }`}
              style={{ width: `${Math.min(100, ov.cpu_usage_pct)}%` }}
            />
          </div>
        </div>
      )}

      {/* Memory bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-text-muted">
          <span>Memory</span>
          <span>
            {formatBytes(ov.mem_available_bytes)} available
          </span>
        </div>
        <div className="h-2 rounded-full bg-bg-muted overflow-hidden">
          <div
            className="h-full bg-accent/80 rounded-full"
            style={{ width: `${Math.min(100, memUsedPct)}%` }}
          />
        </div>
      </div>

      {/* Disks */}
      <div className="space-y-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-muted">Disks</h3>
        {ov.disks.length === 0 ? (
          <p className="text-xs text-text-muted">No disk information available.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {ov.disks.map((d, i) => (
              <div
                key={`${d.mounted_on}-${i}`}
                className="rounded-lg border border-border/60 bg-bg-subtle p-3 space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium truncate" title={d.mounted_on}>
                    {d.mounted_on}
                  </span>
                  <span className="text-[11px] text-text-muted truncate" title={d.filesystem}>
                    {d.filesystem}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-text-muted">
                  <span>
                    {formatBytes(d.avail_kb * 1024)} free
                  </span>
                  <span>{d.use_pct}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full ${d.use_pct >= 90 ? "bg-status-error" : d.use_pct >= 70 ? "bg-status-connecting" : "bg-accent/80"}`}
                    style={{ width: `${Math.min(100, d.use_pct)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-bg-subtle p-3 space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted">
        <Icon size={13} strokeWidth={1.8} aria-hidden="true" />
        {label}
      </div>
      <div className="text-lg font-semibold leading-tight">{value}</div>
      <div className="text-[11px] text-text-muted truncate" title={sub}>
        {sub}
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="p-8 text-center text-text-muted">
      <div className="inline-block animate-spin rounded-full h-6 w-6 border-2 border-border border-t-accent" />
      <p className="mt-3 text-sm">Loading system overview…</p>
    </div>
  );
}