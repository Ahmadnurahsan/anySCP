import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePluginStore, runKey } from "./plugin-store";
import type { Plugin, PluginInfo } from "../types";

// The store reaches the backend via a dynamic `import("@tauri-apps/api/core")`,
// so we mock that module's `invoke` (persist is fire-and-forget, hence waitFor).
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const p1 = {
  enabled: true,
  source: "url",
  installed_version: "1.0.0",
  installed_at: "2026-08-12 10:00:00",
} as PluginInfo;
p1.manifest = {
  schema_version: 1,
  id: "mysql",
  name: "MySQL",
  version: "1.0.0",
  author: "community",
  platforms: ["linux"],
  commands: [
    {
      id: "status",
      title: "Status",
      dangerous: false,
      cache_ttl: 15,
      timeout: 0,
      max_output_bytes: 0,
      columns: [],
      variables: [],
      runs: { linux: ["systemctl is-active mysql"] },
      parser: { type: "raw" },
      output: "text",
    },
  ],
} satisfies Plugin;

function pluginList(plugins: PluginInfo[]) {
  return plugins.map((p) => ({ ...p, manifest: { ...p.manifest } }));
}

describe("plugin-store", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    usePluginStore.setState({
      installed: null,
      loading: false,
      error: null,
      installing: false,
      runs: {},
      marketplace: null,
      marketLoading: false,
      marketError: null,
    });
  });

  it("loads the installed list", async () => {
    const list = pluginList([p1]);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin_list") return list;
      throw new Error("unexpected command " + cmd);
    });
    await usePluginStore.getState().list();
    expect(usePluginStore.getState().installed).toEqual(list);
    expect(usePluginStore.getState().loading).toBe(false);
  });

  it("surfaces a list error", async () => {
    invoke.mockRejectedValue({ kind: "io_error", message: "db boom" });
    await usePluginStore.getState().list();
    expect(usePluginStore.getState().error).toBe("db boom");
  });

  it("installs from a URL source then refreshes the list", async () => {
    const list = pluginList([p1]);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin_install") return p1;
      if (cmd === "plugin_list") return list;
      throw new Error("unexpected command " + cmd);
    });
    await usePluginStore.getState().install({ type: "url", url: "https://x/manifest.json" });
    expect(invoke).toHaveBeenCalledWith("plugin_install", {
      source: { type: "url", url: "https://x/manifest.json" },
    });
    expect(usePluginStore.getState().installed).toEqual(list);
  });

  it("uninstalls by plugin id and refreshes", async () => {
    usePluginStore.setState({ installed: pluginList([p1]) });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin_uninstall") return undefined;
      if (cmd === "plugin_list") return [];
      throw new Error("unexpected command " + cmd);
    });
    await usePluginStore.getState().uninstall("mysql");
    expect(invoke).toHaveBeenCalledWith("plugin_uninstall", { pluginId: "mysql" });
    expect(usePluginStore.getState().installed).toEqual([]);
  });

  it("toggles enable state locally after persistence", async () => {
    usePluginStore.setState({ installed: pluginList([p1]) });
    await usePluginStore.getState().setEnabled("mysql", false);
    expect(invoke).toHaveBeenCalledWith("plugin_enable", { pluginId: "mysql", enabled: false });
    expect(usePluginStore.getState().installed?.[0]?.enabled).toBe(false);
  });

  it("runs a command and stores the result", async () => {
    const result = {
      output: "text",
      text: "active",
      table: null,
      metrics: null,
      json: null,
      exit_code: 0,
      stderr: "",
      truncated: false,
      cached: false,
      os: "debian",
      error: null,
    };
    invoke.mockResolvedValue(result);
    const out = await usePluginStore.getState().run("mysql", "status", "s1", {}, false);
    expect(out).toEqual(result);
    expect(invoke).toHaveBeenCalledWith("plugin_run", {
      pluginId: "mysql",
      commandId: "status",
      sessionId: "s1",
      variables: {},
      refresh: false,
    });
    const key = runKey("mysql", "status", "s1");
    expect(usePluginStore.getState().runs[key]).toEqual({
      running: false,
      result,
      error: null,
    });
  });

  it("records a run error message", async () => {
    invoke.mockRejectedValue({ kind: "unsupported_os", message: "not on windows" });
    const out = await usePluginStore.getState().run("mysql", "status", "s1", {}, false);
    expect(out).toBeNull();
    const key = runKey("mysql", "status", "s1");
    expect(usePluginStore.getState().runs[key].error).toBe("not on windows");
  });

  it("marks a run in-flight", async () => {
    let resolve!: (v: unknown) => void;
    invoke.mockReturnValue(new Promise((r) => (resolve = r)));
    const key = runKey("mysql", "status", "s1");
    const pending = usePluginStore.getState().run("mysql", "status", "s1", {}, false);
    expect(usePluginStore.getState().runs[key].running).toBe(true);
    resolve({ exit_code: 0 });
    await pending;
  });

  it("loads the marketplace registry", async () => {
    const entries = [
      {
        id: "system",
        name: "System",
        version: "1.0.0",
        author: "anySCP",
        description: null,
        icon: null,
        platforms: ["linux"],
        url: "https://raw.githubusercontent.com/x/manifest.json",
      },
    ];
    invoke.mockResolvedValue(entries);
    await usePluginStore.getState().loadMarketplace();
    expect(invoke).toHaveBeenCalledWith("plugin_marketplace_list", { refresh: false });
    expect(usePluginStore.getState().marketplace).toEqual(entries);
    expect(usePluginStore.getState().marketLoading).toBe(false);
  });

  it("surfaces a marketplace fetch error", async () => {
    invoke.mockRejectedValue({ kind: "fetch_error", message: "offline" });
    await usePluginStore.getState().loadMarketplace();
    expect(usePluginStore.getState().marketError).toBe("offline");
    expect(usePluginStore.getState().marketplace).toBeNull();
  });
});