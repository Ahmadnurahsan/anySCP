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
  DockerAvailability,
  DockerContainer,
  DockerImage,
  DockerStat,
  DockerContainerAction,
  DockerActionResponse,
  DockerInspectResult,
  DockerLogFrame,
  NetworkToolsAvailability,
  ListeningPort,
  DnsLookupResponse,
  PortScanResponse,
  PingResponse,
  TracerouteResponse,
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
  // ── Docker ──
  docker: DockerAvailability | null;
  dockerLoading: boolean;
  containers: DockerContainer[];
  containersLoading: boolean;
  showAll: boolean;
  images: DockerImage[];
  imagesLoading: boolean;
  stats: DockerStat[];
  statsLoading: boolean;
  /** Active log streams: container short-id → accumulated text + liveness. */
  dockerLogs: Record<string, { lines: string; live: boolean }>;
  dockerLogError: string | null;
  /** docker inspect result, keyed by container id. */
  dockerInspects: Record<string, DockerInspectResult | null>;
  dockerInspectLoading: string | null;
  // ── Service logs ──
  serviceLogs: Record<string, string>;
  serviceLogLoading: string | null;
  // ── Network ──
  netAvailable: NetworkToolsAvailability | null;
  netLoading: boolean;
  listeningPorts: ListeningPort[];
  listeningPortsLoading: boolean;
  lastScan: PortScanResponse | null;
  lastPing: PingResponse | null;
  lastTrace: TracerouteResponse | null;
  lastDns: DnsLookupResponse | null;
  netError: string | null;
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

  // ── Docker ──
  loadDockerAvailability: (toolsSessionId: string) => Promise<DockerAvailability | null>;
  refreshContainers: (toolsSessionId: string, force?: boolean) => Promise<void>;
  toggleShowAll: (toolsSessionId: string) => void;
  refreshDockerImages: (toolsSessionId: string, force?: boolean) => Promise<void>;
  refreshDockerStats: (toolsSessionId: string, force?: boolean) => Promise<void>;
  dockerContainerAction: (
    toolsSessionId: string,
    container: string,
    action: DockerContainerAction,
  ) => Promise<DockerActionResponse>;
  dockerExecShell: (toolsSessionId: string, container: string) => Promise<string | null>;
  openLogs: (toolsSessionId: string, container: string, tail: number) => Promise<void>;
  closeLogs: (toolsSessionId: string, container: string) => void;
  appendLogFrame: (frame: DockerLogFrame) => void;
  dockerInspect: (toolsSessionId: string, container: string) => Promise<DockerInspectResult | null>;
  clearInspect: (toolsSessionId: string, container: string) => void;
  fetchServiceLog: (toolsSessionId: string, unit: string, lines?: number) => Promise<void>;
  clearServiceLog: (toolsSessionId: string, unit: string) => void;

  // ── Network ──
  loadNetworkAvailability: (toolsSessionId: string) => Promise<NetworkToolsAvailability | null>;
  fetchListeningPorts: (toolsSessionId: string) => Promise<void>;
  runPortScan: (
    toolsSessionId: string,
    target: string,
    ports: string,
    strategy: string,
  ) => Promise<PortScanResponse | null>;
  runPing: (toolsSessionId: string, target: string, count: number) => Promise<PingResponse | null>;
  runTraceroute: (toolsSessionId: string, target: string) => Promise<TracerouteResponse | null>;
  runDnsLookup: (toolsSessionId: string, target: string, recordType?: string) => Promise<DnsLookupResponse | null>;
}

function msg(err: unknown): string {
  return err && typeof err === "object" && "message" in err
    ? String((err as { message: string }).message)
    : "Tools error";
}

/** Stream ids (`<sessionId>:<container>`) with an active `docker logs -f`. */
const activeLogStreams = new Set<string>();

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
        docker: null,
        dockerLoading: false,
        containers: [],
        containersLoading: false,
        showAll: false,
        images: [],
        imagesLoading: false,
        stats: [],
        statsLoading: false,
        dockerLogs: {},
        dockerLogError: null,
        dockerInspects: {},
        dockerInspectLoading: null,
        serviceLogs: {},
        serviceLogLoading: null,
        netAvailable: null,
        netLoading: false,
        listeningPorts: [],
        listeningPortsLoading: false,
        lastScan: null,
        lastPing: null,
        lastTrace: null,
        lastDns: null,
        netError: null,
      });
      return { sessions: next, activeToolsSessionId: sshSessionId };
    }),

  closeSession: (toolsSessionId) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.delete(toolsSessionId);
      // Kill any in-flight `docker logs -f` streams for this session so the
      // backend token doesn't leak.
      const stopped = Array.from(activeLogStreams).filter((s) =>
        s.startsWith(`${toolsSessionId}:`),
      );
      stopped.forEach((s) => activeLogStreams.delete(s));
      if (stopped.length > 0) {
        void import("@tauri-apps/api/core").then(({ invoke }) => {
          stopped.forEach((s) => void invoke("docker_logs_stop", { streamId: s }));
        });
      }
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

  // ── Docker ──

  loadDockerAvailability: async (toolsSessionId) => {
    const s = get().sessions.get(toolsSessionId);
    if (s?.docker) return s.docker;
    if (s?.dockerLoading) return s.docker;
    set((state) => patch(state, toolsSessionId, { dockerLoading: true }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const docker = await invoke<DockerAvailability>("docker_available", {
        sessionId: toolsSessionId,
      });
      set((state) => patch(state, toolsSessionId, { docker, dockerLoading: false }));
      return docker;
    } catch (err) {
      set((state) =>
        patch(state, toolsSessionId, { dockerLoading: false, error: msg(err) }),
      );
      return null;
    }
  },

  refreshContainers: async (toolsSessionId, force = false) => {
    const s = get().sessions.get(toolsSessionId);
    if (!s) return;
    if (s.containersLoading) return;
    set((state) => patch(state, toolsSessionId, { containersLoading: true }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const containers = await invoke<DockerContainer[]>("docker_containers", {
        sessionId: toolsSessionId,
        all: s.showAll,
        refresh: force,
      });
      set((state) =>
        patch(state, toolsSessionId, { containers, containersLoading: false }),
      );
    } catch (err) {
      set((state) =>
        patch(state, toolsSessionId, {
          containersLoading: false,
          error: msg(err),
        }),
      );
    }
  },

  toggleShowAll: (toolsSessionId) => {
    const s = get().sessions.get(toolsSessionId);
    if (!s) return;
    const showAll = !s.showAll;
    set((state) => patch(state, toolsSessionId, { showAll }));
    void get().refreshContainers(toolsSessionId, true);
  },

  refreshDockerImages: async (toolsSessionId, force = false) => {
    const s = get().sessions.get(toolsSessionId);
    if (!s) return;
    if (s.imagesLoading) return;
    set((state) => patch(state, toolsSessionId, { imagesLoading: true }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const images = await invoke<DockerImage[]>("docker_images", {
        sessionId: toolsSessionId,
        refresh: force,
      });
      set((state) =>
        patch(state, toolsSessionId, { images, imagesLoading: false }),
      );
    } catch (err) {
      set((state) => patch(state, toolsSessionId, { imagesLoading: false, error: msg(err) }));
    }
  },

  refreshDockerStats: async (toolsSessionId, force = false) => {
    const s = get().sessions.get(toolsSessionId);
    if (!s) return;
    if (s.statsLoading) return;
    set((state) => patch(state, toolsSessionId, { statsLoading: true }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const stats = await invoke<DockerStat[]>("docker_stats", {
        sessionId: toolsSessionId,
        refresh: force,
      });
      set((state) => patch(state, toolsSessionId, { stats, statsLoading: false }));
    } catch (err) {
      set((state) => patch(state, toolsSessionId, { statsLoading: false, error: msg(err) }));
    }
  },

  dockerContainerAction: async (toolsSessionId, container, action) => {
    const { invoke } = await import("@tauri-apps/api/core");
    const res = await invoke<DockerActionResponse>("docker_container_action", {
      sessionId: toolsSessionId,
      container,
      action,
    });
    // Refresh the list + stats after a successful action lands.
    if (res.ok) {
      await get().refreshContainers(toolsSessionId, true);
      await get().refreshDockerStats(toolsSessionId, true);
    }
    return res;
  },

  dockerExecShell: async (toolsSessionId, container) => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { useTabStore } = await import("./tab-store");
    const { useSessionStore } = await import("./session-store");
    const s = get().sessions.get(toolsSessionId);
    if (!s) return null;
    const containerTarget = container.trim();
    const labelName = containerTarget.length > 16 ? containerTarget.slice(0, 16) + "…" : containerTarget;
    const sessionId = await invoke<string>("ssh_split_exec", {
      sourceSessionId: toolsSessionId,
      command: `docker exec -it ${containerTarget} /bin/bash 2>/dev/null || docker exec -it ${containerTarget} /bin/sh 2>/dev/null || docker exec -it ${containerTarget} sh`,
    });
    useSessionStore.getState().addSession(sessionId, {
      host: s.hostConfig.host,
      port: s.hostConfig.port,
      username: s.hostConfig.username,
      label: s.hostConfig.label || undefined,
      auth_method: s.hostConfig.auth_method,
    });
    useTabStore.getState().addTab({
      type: "terminal",
      id: sessionId,
      label: `${labelName} · docker`,
    });
    return sessionId;
  },

  openLogs: async (toolsSessionId, container, tail) => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    const raw = container.length >= 12 ? container.slice(0, 12) : container;
    const logStreamId = `${toolsSessionId}:${raw}`;
    activeLogStreams.add(logStreamId);
    const unlisten = await listen<DockerLogFrame>("tools:docker-log", (ev) => {
      const f = ev.payload;
      if (f.stream_id === logStreamId) {
        get().appendLogFrame(f);
        if (f.done) {
          unlisten();
          activeLogStreams.delete(logStreamId);
        }
      }
    });
    try {
      await invoke<string>("docker_logs_follow", {
        sessionId: toolsSessionId,
        container: raw,
        tail,
      });
    } catch (err) {
      unlisten();
      activeLogStreams.delete(logStreamId);
      const s = get().sessions.get(toolsSessionId);
      if (s) {
        set((state) => patch(state, toolsSessionId, { dockerLogError: msg(err) }));
      }
    }
  },

  closeLogs: (toolsSessionId, container) => {
    const streamId = `${toolsSessionId}:${container.slice(0, 12)}`;
    activeLogStreams.delete(streamId);
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke("docker_logs_stop", { streamId });
    });
    const s = get().sessions.get(toolsSessionId);
    if (s) {
      set((state) => patch(state, toolsSessionId, { dockerLogs: {}, dockerLogError: null }));
    }
  },

  appendLogFrame: (frame) => {
    const sep = frame.stream_id.indexOf(":");
    if (sep < 0) return;
    const toolsSessionId = frame.stream_id.slice(0, sep);
    const container = frame.stream_id.slice(sep + 1);
    set((state) => {
      const s = state.sessions.get(toolsSessionId);
      if (!s) return state;
      const existing = s.dockerLogs[container] ?? { lines: "", live: false };
      const lines = frame.done
        ? existing.lines
        : existing.lines + frame.data;
      return patch(state, toolsSessionId, {
        dockerLogs: {
          ...s.dockerLogs,
          [container]: { lines, live: !frame.done },
        },
      });
    });
  },

  // ── Docker Inspect ──

  dockerInspect: async (toolsSessionId, container) => {
    const s = get().sessions.get(toolsSessionId);
    if (!s) return null;
    // Container id might be a 12-char short id or a name — pass it through.
    set((state) => patch(state, toolsSessionId, { dockerInspectLoading: container }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<DockerInspectResult>("docker_inspect", {
        sessionId: toolsSessionId,
        container,
      });
      set((state) =>
        patch(state, toolsSessionId, {
          dockerInspectLoading: null,
          dockerInspects: {
            ...get().sessions.get(toolsSessionId)?.dockerInspects,
            [container]: result,
          },
        })
      );
      return result;
    } catch (err) {
      set((state) =>
        patch(state, toolsSessionId, {
          dockerInspectLoading: null,
          dockerInspects: {
            ...get().sessions.get(toolsSessionId)?.dockerInspects,
            [container]: null,
          },
          error: msg(err),
        })
      );
      return null;
    }
  },

  clearInspect: (toolsSessionId, container) => {
    const s = get().sessions.get(toolsSessionId);
    if (!s) return;
    const next = { ...s.dockerInspects };
    delete next[container];
    set((state) => patch(state, toolsSessionId, { dockerInspects: next }));
  },

  // ── Service Logs ──

  fetchServiceLog: async (toolsSessionId, unit, lines = 200) => {
    const s = get().sessions.get(toolsSessionId);
    if (!s) return;
    set((state) => patch(state, toolsSessionId, { serviceLogLoading: unit }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const text = await invoke<string>("service_log", {
        sessionId: toolsSessionId,
        unit,
        lines,
      });
      set((state) =>
        patch(state, toolsSessionId, {
          serviceLogLoading: null,
          serviceLogs: {
            ...get().sessions.get(toolsSessionId)?.serviceLogs,
            [unit]: text,
          },
        })
      );
    } catch (err) {
      set((state) =>
        patch(state, toolsSessionId, {
          serviceLogLoading: null,
          serviceLogs: {
            ...get().sessions.get(toolsSessionId)?.serviceLogs,
            [unit]: `Error: ${msg(err)}`,
          },
        })
      );
    }
  },

  clearServiceLog: (toolsSessionId, unit) => {
    const s = get().sessions.get(toolsSessionId);
    if (!s) return;
    const next = { ...s.serviceLogs };
    delete next[unit];
    set((state) => patch(state, toolsSessionId, { serviceLogs: next }));
  },

  // ── Network ──

  loadNetworkAvailability: async (toolsSessionId) => {
    const s = get().sessions.get(toolsSessionId);
    if (s?.netAvailable || s?.netLoading) return s?.netAvailable ?? null;
    set((state) => patch(state, toolsSessionId, { netLoading: true }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const a = await invoke<NetworkToolsAvailability>("network_tools_available", {
        sessionId: toolsSessionId,
      });
      set((state) => patch(state, toolsSessionId, { netAvailable: a, netLoading: false }));
      return a;
    } catch (err) {
      set((state) => patch(state, toolsSessionId, { netLoading: false, netError: msg(err) }));
      return null;
    }
  },

  runPortScan: async (toolsSessionId, target, ports, strategy) => {
    set((state) => patch(state, toolsSessionId, { netError: null }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<PortScanResponse>("port_scan", {
        sessionId: toolsSessionId,
        target,
        ports,
        strategy,
      });
      set((state) => patch(state, toolsSessionId, { lastScan: res, netError: res.error }));
      return res;
    } catch (err) {
      set((state) => patch(state, toolsSessionId, { netError: msg(err) }));
      return null;
    }
  },

  runPing: async (toolsSessionId, target, count) => {
    set((state) => patch(state, toolsSessionId, { netError: null }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<PingResponse>("ping_check", {
        sessionId: toolsSessionId,
        target,
        count,
      });
      set((state) => patch(state, toolsSessionId, { lastPing: res, netError: res.error }));
      return res;
    } catch (err) {
      set((state) => patch(state, toolsSessionId, { netError: msg(err) }));
      return null;
    }
  },

  runTraceroute: async (toolsSessionId, target) => {
    set((state) => patch(state, toolsSessionId, { netError: null }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<TracerouteResponse>("traceroute_check", {
        sessionId: toolsSessionId,
        target,
      });
      set((state) => patch(state, toolsSessionId, { lastTrace: res, netError: res.error }));
      return res;
    } catch (err) {
      set((state) => patch(state, toolsSessionId, { netError: msg(err) }));
      return null;
    }
  },

  fetchListeningPorts: async (toolsSessionId) => {
    set((state) => patch(state, toolsSessionId, { listeningPortsLoading: true }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const ports = await invoke<ListeningPort[]>("listening_ports", {
        sessionId: toolsSessionId,
      });
      set((state) =>
        patch(state, toolsSessionId, {
          listeningPorts: ports,
          listeningPortsLoading: false,
        })
      );
    } catch (err) {
      set((state) =>
        patch(state, toolsSessionId, {
          listeningPortsLoading: false,
          netError: msg(err),
        })
      );
    }
  },

  runDnsLookup: async (toolsSessionId, target, recordType = "A") => {
    set((state) => patch(state, toolsSessionId, { netError: null }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<DnsLookupResponse>("dns_lookup", {
        sessionId: toolsSessionId,
        target,
        recordType,
      });
      set((state) => patch(state, toolsSessionId, { lastDns: res, netError: res.error }));
      return res;
    } catch (err) {
      set((state) => patch(state, toolsSessionId, { netError: msg(err) }));
      return null;
    }
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