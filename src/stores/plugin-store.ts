import { create } from "zustand";
import type {
  PluginInfo,
  PluginSource,
  PluginRunResult,
} from "../types";

export interface PluginRunState {
  running: boolean;
  result: PluginRunResult | null;
  error: string | null;
}

interface PluginState {
  /** `null` until the first successful `list()`. */
  installed: PluginInfo[] | null;
  loading: boolean;
  /** Global error for list/install/uninstall/enable. */
  error: string | null;
  installing: boolean;
  /** Per-run state, keyed `${pluginId}:${commandId}:${sessionId}`. */
  runs: Record<string, PluginRunState>;

  list: () => Promise<void>;
  install: (source: PluginSource) => Promise<void>;
  uninstall: (pluginId: string) => Promise<void>;
  setEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
  run: (
    pluginId: string,
    commandId: string,
    sessionId: string,
    variables: Record<string, string>,
    refresh?: boolean,
  ) => Promise<PluginRunResult | null>;
  clearResult: (key: string) => void;
  clearError: () => void;
}

export function runKey(pluginId: string, commandId: string, sessionId: string): string {
  return `${pluginId}:${commandId}:${sessionId}`;
}

function msg(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: unknown };
    if (typeof e.message === "string") return e.message;
  }
  return "Plugin error";
}

export const usePluginStore = create<PluginState>((set, get) => ({
  installed: null,
  loading: false,
  error: null,
  installing: false,
  runs: {},

  list: async () => {
    set({ loading: true, error: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const installed = await invoke<PluginInfo[]>("plugin_list");
      set({ installed, loading: false });
    } catch (err) {
      set({ loading: false, error: msg(err) });
    }
  },

  install: async (source) => {
    set({ installing: true, error: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<PluginInfo>("plugin_install", { source });
      await get().list();
    } catch (err) {
      set({ error: msg(err) });
    } finally {
      set({ installing: false });
    }
  },

  uninstall: async (pluginId) => {
    set({ error: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<void>("plugin_uninstall", { pluginId });
      await get().list();
    } catch (err) {
      set({ error: msg(err) });
    }
  },

  setEnabled: async (pluginId, enabled) => {
    set({ error: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<void>("plugin_enable", { pluginId, enabled });
      const installed = get().installed?.map((p) =>
        p.manifest.id === pluginId ? { ...p, enabled } : p,
      ) ?? null;
      set({ installed });
    } catch (err) {
      set({ error: msg(err) });
    }
  },

  run: async (pluginId, commandId, sessionId, variables, refresh = false) => {
    const key = runKey(pluginId, commandId, sessionId);
    set((state) => ({
      runs: { ...state.runs, [key]: { running: true, result: null, error: null } },
    }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<PluginRunResult>("plugin_run", {
        pluginId,
        commandId,
        sessionId,
        variables,
        refresh,
      });
      set((state) => ({
        runs: { ...state.runs, [key]: { running: false, result, error: null } },
      }));
      return result;
    } catch (err) {
      const message = msg(err);
      set((state) => ({
        runs: { ...state.runs, [key]: { running: false, result: null, error: message } },
      }));
      return null;
    }
  },

  clearResult: (key) =>
    set((state) => {
      const runs = { ...state.runs };
      delete runs[key];
      return { runs };
    }),

  clearError: () => set({ error: null }),
}));
