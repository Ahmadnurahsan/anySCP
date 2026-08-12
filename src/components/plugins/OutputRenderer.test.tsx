import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OutputRenderer } from "./OutputRenderer";
import type { PluginRunResult } from "../../types";

function result(partial: Partial<PluginRunResult>): PluginRunResult {
  return {
    output: "text",
    text: null,
    table: null,
    metrics: null,
    json: null,
    exit_code: 0,
    stderr: "",
    truncated: false,
    cached: false,
    os: "debian",
    error: null,
    ...partial,
  };
}

describe("OutputRenderer", () => {
  it("renders the text widget", () => {
    render(<OutputRenderer result={result({ output: "text", text: "active (running)\n" })} />);
    expect(screen.getByText(/active \(running\)/)).toBeTruthy();
    expect(screen.getByText(/exit 0/)).toBeTruthy();
  });

  it("marks cached and truncated results", () => {
    render(
      <OutputRenderer
        result={result({ text: "out", cached: true, truncated: true, exit_code: 3 })}
      />,
    );
    expect(screen.getByText("cached")).toBeTruthy();
    expect(screen.getByText(/output truncated/)).toBeTruthy();
    expect(screen.getByText(/exit 3/)).toBeTruthy();
  });

  it("renders the table widget with headers and rows", () => {
    render(
      <OutputRenderer
        result={result({
          output: "table",
          table: { columns: ["name", "state"], rows: [["nginx", "running"], ["www", "stopped"]] },
        })}
      />,
    );
    expect(screen.getByText("name")).toBeTruthy();
    expect(screen.getByText("nginx")).toBeTruthy();
    expect(screen.getByText("stopped")).toBeTruthy();
  });

  it("formats metric values with units", () => {
    render(
      <OutputRenderer
        result={result({
          output: "metrics",
          metrics: [
            { label: "CPU", value: 42.5, unit: "%" },
            { label: "Containers", value: 1000, unit: null },
          ],
        })}
      />,
    );
    expect(screen.getByText("CPU")).toBeTruthy();
    expect(screen.getByText("Containers")).toBeTruthy();
    expect(screen.getByText(/42.5/)).toBeTruthy();
    // Large integers are thousands-separated.
    expect(screen.getByText(/1,000/)).toBeTruthy();
  });

  it("renders pretty-printed json", () => {
    render(
      <OutputRenderer
        result={result({ output: "json", json: { hostname: "web-1", ok: true } })}
      />,
    );
    const pre = screen.getByText(/"hostname": "web-1"/);
    expect(pre).toBeTruthy();
  });

  it("shows the failure block on a non-zero exit", () => {
    render(
      <OutputRenderer
        result={result({ exit_code: 1, error: "systemctl: no such unit" })}
      />,
    );
    expect(screen.getByText(/systemctl: no such unit/)).toBeTruthy();
    expect(screen.getByText(/Command failed/)).toBeTruthy();
  });
});