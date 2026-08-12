import { Database, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import type { PluginRunResult, PluginTable, Metric } from "../../types";

interface Props {
  result: PluginRunResult;
}

/** Generic widget renderer — one widget per `output` kind, no plugin-specific UI. */
export function OutputRenderer({ result }: Props) {
  return (
    <div className="space-y-2">
      <ResultMeta result={result} />
      {result.error ? (
        <div className="rounded-lg border border-status-error/40 bg-status-error/10 p-3">
          <div className="flex items-center gap-1.5 text-status-error text-xs font-medium">
            <XCircle size={14} strokeWidth={1.8} aria-hidden="true" />
            Command failed
          </div>
          <pre className="mt-1.5 text-xs whitespace-pre-wrap break-words font-mono text-text-primary">
            {result.error}
          </pre>
        </div>
      ) : null}
      {renderWidget(result)}
    </div>
  );
}

function ResultMeta({ result }: Props) {
  const exitOk = result.exit_code === 0;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-muted">
      <span
        className={`flex items-center gap-1 ${exitOk ? "text-status-connected" : "text-status-error"}`}
      >
        {exitOk ? (
          <CheckCircle2 size={13} strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <XCircle size={13} strokeWidth={1.8} aria-hidden="true" />
        )}
        exit {result.exit_code}
      </span>
      {result.cached && (
        <span className="flex items-center gap-1 text-accent">
          <Database size={13} strokeWidth={1.8} aria-hidden="true" />
          cached
        </span>
      )}
      {result.os && <span>{result.os}</span>}
      {result.truncated && (
        <span className="flex items-center gap-1 text-status-connecting">
          <AlertTriangle size={13} strokeWidth={1.8} aria-hidden="true" />
          output truncated
        </span>
      )}
    </div>
  );
}

function renderWidget(result: PluginRunResult) {
  switch (result.output) {
    case "text":
      return <TextView text={result.text ?? ""} />;
    case "table":
      return <TableView table={result.table} />;
    case "metrics":
      return <MetricsView metrics={result.metrics ?? []} />;
    case "json":
      return <JsonView value={result.json} />;
    default:
      return <TextView text={result.text ?? ""} />;
  }
}

function TextView({ text }: { text: string }) {
  return (
    <pre className="rounded-lg border border-border/60 bg-bg-subtle p-3 text-xs font-mono whitespace-pre-wrap break-words text-text-primary overflow-auto max-h-[420px]">
      {text || "(no output)"}
    </pre>
  );
}

function TableView({ table }: { table?: PluginTable | null }) {
  if (!table || table.columns.length === 0) {
    return <TextView text={JSON.stringify(table, null, 2)} />;
  }
  return (
    <div className="rounded-lg border border-border/60 overflow-auto max-h-[420px]">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="bg-bg-surface border-b border-border/60">
            {table.columns.map((c) => (
              <th
                key={c}
                className="text-left font-medium text-text-muted px-3 py-1.5 whitespace-nowrap sticky top-0 bg-bg-surface"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.length === 0 ? (
            <tr>
              <td
                colSpan={table.columns.length}
                className="px-3 py-4 text-center text-text-muted"
              >
                No rows
              </td>
            </tr>
          ) : (
            table.rows.map((row, i) => (
              <tr
                key={i}
                className={i % 2 ? "bg-bg-subtle/50" : ""}
              >
                {table.columns.map((c, j) => (
                  <td key={c} className="px-3 py-1 whitespace-pre-wrap break-words align-top">
                    {row[j] ?? ""}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function MetricsView({ metrics }: { metrics: Metric[] }) {
  if (metrics.length === 0) {
    return <TextView text="(no metrics)" />;
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {metrics.map((m, i) => (
        <div
          key={`${m.label}-${i}`}
          className="rounded-lg border border-border/60 bg-bg-subtle p-3 space-y-1"
        >
          <div className="text-[11px] font-medium uppercase tracking-wider text-text-muted truncate" title={m.label}>
            {m.label}
          </div>
          <div className="text-lg font-semibold leading-tight">
            {formatNumber(m.value)}
            {m.unit ? (
              <span className="ml-1 text-xs font-normal text-text-muted">{m.unit}</span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function JsonView({ value }: { value: unknown }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return <TextView text={text} />;
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
