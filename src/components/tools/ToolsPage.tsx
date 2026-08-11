import { useEffect, useRef } from "react";
import {
  Activity,
  Cpu,
  RefreshCw,
  TerminalSquare,
  Server,
  Boxes,
} from "lucide-react";
import { useToolsStore, type ToolsSession } from "../../stores/tools-store";
import type { ToolsToolId } from "../../types";
import { SystemOverview } from "./SystemOverview";
import { ProcessManager } from "./ProcessManager";
import { ServiceManager } from "./ServiceManager";
import { DockerPanel } from "./DockerPanel";
import { NetworkPanel } from "./NetworkPanel";

interface ToolsPageProps {
  /** The Tools session id (== the underlying SSH session id). */
  sessionId: string;
  label?: string;
  isActive?: boolean;
}

const TOOLS: { id: ToolsToolId; label: string; icon: React.ElementType }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "processes", label: "Processes", icon: Cpu },
  { id: "services", label: "Services", icon: Server },
  { id: "docker", label: "Docker", icon: Boxes },
  { id: "network", label: "Network", icon: TerminalSquare },
];

export function ToolsPage({ sessionId, label, isActive = true }: ToolsPageProps) {
  const session = useToolsStore((s) => s.sessions.get(sessionId));
  const refreshOverview = useToolsStore((s) => s.refreshOverview);
  const refreshProcesses = useToolsStore((s) => s.refreshProcesses);

  // Load overview on first mount and refresh every 6s while focused.
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!session) return;
    void refreshOverview(sessionId);
    if (!isActive) return;
    timerRef.current = window.setInterval(
      () => void refreshOverview(sessionId),
      6000,
    );
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, isActive]);

  // Auto-refresh process list every 5s while focused.
  useEffect(() => {
    if (!session) return;
    void refreshProcesses(sessionId);
    if (!isActive) return;
    const iv = window.setInterval(() => void refreshProcesses(sessionId), 5000);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, isActive]);

  const activeTool = session?.activeTool ?? "overview";
  const hostLabel = session?.label ?? label ?? sessionId;

  return (
    <div className="flex flex-col h-full p-2">
      <div className="flex flex-col flex-1 min-h-0 rounded-lg overflow-hidden border border-border/60">
        {/* Header */}
        <div className="flex items-center h-8 px-2.5 gap-2.5 shrink-0 no-select bg-bg-surface/80 border-b border-border/60">
          <Activity size={14} strokeWidth={1.8} className="shrink-0 text-status-connected" aria-hidden="true" />
          <span className="text-[11px] font-mono truncate flex-1 min-w-0 text-text-primary leading-none" title={hostLabel}>
            {hostLabel}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-text-muted font-medium shrink-0">
            Tools
          </span>
        </div>

        {/* Sub-tab strip */}
        <div className="flex items-center gap-1 px-2 py-1.5 shrink-0 bg-bg-subtle border-b border-border/60 no-select">
          {TOOLS.map((t) => {
            const Icon = t.icon;
            const isActiveTool = activeTool === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => useToolsStore.getState().setActiveTool(sessionId, t.id)}
                data-testid={`tools-${sessionId}-${t.id}`}
                className={[
                  "flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[length:var(--text-xs)] font-medium transition-colors",
                  "duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActiveTool
                    ? "bg-accent/15 text-accent"
                    : "text-text-secondary hover:text-text-primary hover:bg-bg-overlay",
                ].join(" ")}
              >
                <Icon size={13} strokeWidth={1.8} aria-hidden="true" />
                {t.label}
              </button>
            );
          })}
          {session?.error && (
            <span className="ml-auto max-w-[40%] truncate text-status-error text-[11px]" title={session.error}>
              {session.error}
            </span>
          )}
        </div>

        {/* Tool body */}
        <div className="flex-1 min-h-0 overflow-auto bg-bg-base">
          {session ? renderTool(session) : <MissingSession sessionId={sessionId} />}
        </div>
      </div>
    </div>
  );
}

function renderTool(session: ToolsSession) {
  switch (session.activeTool) {
    case "overview":
      return <SystemOverview session={session} />;
    case "processes":
      return <ProcessManager session={session} />;
    case "services":
      return <ServiceManager session={session} />;
    case "docker":
      return <DockerPanel session={session} />;
    case "network":
      return <NetworkPanel session={session} />;
  }
}

function MissingSession({ sessionId }: { sessionId: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-text-muted">
      <RefreshCw size={24} strokeWidth={1.6} aria-hidden="true" />
      <p className="text-sm">No tools session for {sessionId}. Reconnect then reopen Tools.</p>
    </div>
  );
}