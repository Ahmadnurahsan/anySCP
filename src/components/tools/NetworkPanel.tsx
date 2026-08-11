import { Router } from "lucide-react";
import type { ToolsSession } from "../../stores/tools-store";

interface Props {
  session: ToolsSession;
}

// Phase 3 stub — port scanning, service detection, ping/traceroute.
export function NetworkPanel({ session }: Props) {
  void session;
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center px-8">
      <Router size={26} strokeWidth={1.5} className="text-text-muted" aria-hidden="true" />
      <p className="text-sm text-text-secondary">
        Network tools are coming in Phase 3 — port scanning, service detection, and ping.
      </p>
    </div>
  );
}