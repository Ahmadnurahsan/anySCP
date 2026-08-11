import { Boxes } from "lucide-react";
import type { ToolsSession } from "../../stores/tools-store";

interface Props {
  session: ToolsSession;
}

// Phase 2 stub — Docker management arrives in a later milestone.
export function DockerPanel({ session }: Props) {
  void session;
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center px-8">
      <Boxes size={26} strokeWidth={1.5} className="text-text-muted" aria-hidden="true" />
      <p className="text-sm text-text-secondary">
        Docker tools are coming in Phase 2 — list, stats, logs, and exec on your containers
        without installing anything on the host.
      </p>
    </div>
  );
}