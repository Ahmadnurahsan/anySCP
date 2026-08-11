import { create } from "zustand";
import type {
  HostConfig,
  SystemOverview,
  ProcessInfo,
  ServiceInfo,
  ServiceAction,
  ServiceResult,
  KillResult,
  ToolsToolId,
} from "../types";

export interface ToolsSession {
  sshSessionId: string;
  label: string;
  hostConfig: HostConfig;
  activeTool: ToolsToolId;
  overview: SystemOverview | null;
  overviewLoading: boolean;
  processes: ProcessInfo[];
  processesLoading: boolean;
  serviceAvailable: boolean | null;
  services: ServiceInfo[];
  serviceLoading: boolean;
  error: string | null;
}

interface ToolsState {
  sessions: Map<string, ToolsSession>;
  activeToolsSessionId: string | null;

  openSession: (
    sshSessionId: string,
    label: string,
    hostConfig: HostConfig,
  ) => void;
  closeSession: (toolsSessionId: string) => void;
  setActiveToolsSession: (id: string | null) => void;
  setActiveTool: (toolsSessionId: string, tool: ToolsToolId) => void;
  clearError: (toolsSessionId: string) => void;

  refreshOverview: (toolsSessionId: string) => Promise<void>;
  refreshProcesses: (toolsSessionId: string, force?: boolean) => Promise<void>;
  killProcess: (
    toolsSessionId: string,
    pid: number,
    signal?: string,
  ) => Promise<KillResult>;
  loadServiceAvailability: (toolsSessionId: string) => Promise<boolean>;
  refreshServices: (toolsSessionId: string, force?: boolean) => Promise<void>;
  serviceControl: (
    toolsSessionId: string,
    unit: string,
    action: ServiceAction,
  ) => Promise<ServiceResult>;
}

function msg(err: unknown): string {
  return err && typeof err === "object" && "message" in err
    ? String((err as { message: string }).message)
    : "Tools error";
}

export const useToolsStore = create<ToolsState>((set, get) => ({
  sessions: new Map(),
  activeToolsSessionId: null,

  openSession: (sshSessionId, label, hostConfig) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.set(sshSessionId, {
        sshSessionId,
        label,
        hostConfig,
        activeTool: "overview",
        overview: null,
        overviewLoading: false,
        processes: [],
        processesLoading: false,
        serviceAvailable: null,
        services: [],
        serviceLoading: false,
        error: null,
      });
      return { sessions: next, activeToolsSessionId: sshSessionId };
    }),

  closeSession: (toolsSessionId) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.delete(toolsSessionId);
      const newActive =
        state.activeToolsSessionId === toolsSessionId
          ? (next.keys().next().value ?? null)
          : state.activeToolsSessionId;
      return { sessions: next, activeToolsSessionId: newActive };
    }),

  setActiveToolsSession: (id) => set({ activeToolsSessionId: id }),

  setActiveTool: (toolsSessionId, tool) =>
    set((state) => {
      const s = state.sessions.get(toolsSessionId);
      if (!s) return state;
      const next = new Map(state.sessions);
      next.set(toolsSessionId, { ...s, activeTool: tool, error: null });
      return { sessions: next };
    }),

  clearError: (toolsSessionId) =>
    set((state) => {
      const s = state.sessions.get(toolsSessionId);
      if (!s) return state;
      const next = new Map(state.sessions);
      next.set(toolsSessionId, { ...s, error: null });
      return { sessions: next };
    }),

  refreshOverview: async (toolsSessionId) => {
    const s = get().sessions.get(toolsSessionId);
    if (!s) return;
    set((state) => patch(state, toolsSessionId, { overviewLoading: true }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const overview = await invoke<SystemOverview>("system_overview", {
        sessionId: toolsSessionId,
      });
      set((state) =>
        patch(state, toolsSessionId, { overview, overviewLoading: false }),
      );
    } catch (err) {
      set((state) =>
        patch(state, toolsSessionId, {
          overviewLoading: false,
          error: msg(err),
        }),
      );
    }
  },

  refreshProcesses: async (toolsSessionId, force = false) => {
    const s = get().sessions.get(toolsSessionId);
    if (!s) return;
    if (s.processesLoading) return;
    set((state) => patch(state, toolsSessionId, { processesLoading: true }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const processes = await invoke<ProcessInfo[]>("process_list", {
        sessionId: toolsSessionId,
        refresh: force,
      });
      set((state) =>
        patch(state, toolsSessionId, { processes, processesLoading: false }),
      );
    } catch (err) {
      set((state) =>
        patch(state, toolsSessionId, {
          processesLoading: false,
          error: msg(err),
        }),
      );
    }
  },

  killProcess: async (toolsSessionId, pid, signal = "TERM") => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<KillResult>("process_kill", {
      sessionId: toolsSessionId,
      pid,
      signal,
    });
  },

  loadServiceAvailability: async (toolsSessionId) => {
    const s = get().sessions.get(toolsSessionId);
    if (s?.serviceAvailable != null) return s.serviceAvailable;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const available = await invoke<boolean>("service_available", {
        sessionId: toolsSessionId,
      });
      set((state) =>
        patch(state, toolsSessionId, { serviceAvailable: available }),
      );
      return available;
    } catch {
      set((state) => patch(state, toolsSessionId, { serviceAvailable: false }));
      return false;
    }
  },

  refreshServices: async (toolsSessionId, force = false) => {
    const s = get().sessions.get(toolsSessionId);
    if (!s) return;
    if (s.serviceLoading) return;
    set((state) => patch(state, toolsSessionId, { serviceLoading: true }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const services = await invoke<ServiceInfo[]>("service_list", {
        sessionId: toolsSessionId,
        refresh: force,
      });
      set((state) =>
        patch(state, toolsSessionId, { services, serviceLoading: false }),
      );
    } catch (err) {
      set((state) =>
        patch(state, toolsSessionId, {
          serviceLoading: false,
          error: msg(err),
        }),
      );
    }
  },

  serviceControl: async (toolsSessionId, unit, action) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<ServiceResult>("service_control", {
      sessionId: toolsSessionId,
      unit,
      action,
    });
  },
}));

function patch(
  state: ToolsState,
  id: string,
  data: Partial<ToolsSession>,
): ToolsState {
  const s = state.sessions.get(id);
  if (!s) return state;
  const next = new Map(state.sessions);
  next.set(id, { ...s, ...data });
  return { ...state, sessions: next };
}