// Plugins — community JSON-manifest plugins (control-panel style widgets).
// Mirrors src-tauri/src/plugins/{manifest,mod}.rs exactly: the Tauri layer
// serializes the same serde shape back to the frontend, so field names and
// optionality must stay in sync. `None` on the Rust side arrives as `null`.

export type VarType = "text" | "number" | "select" | "password" | "boolean";
export type OutputKind = "text" | "table" | "metrics" | "json";
export type ParserType = "raw" | "key_value" | "regex_table" | "csv" | "json" | "lines";

export interface Parser {
  type: ParserType;
  /** Used by `key_value` (default `:`). */
  separator?: string | null;
  /** Used by `regex_table` — regex with named capture groups. */
  pattern?: string | null;
}

export interface PluginVariable {
  name: string;
  label?: string | null;
  type: VarType;
  default?: string | null;
  options: string[];
  required: boolean;
  /** Optional regex the resolved value must match before the command runs. */
  validation?: string | null;
}

export interface PluginCommand {
  id: string;
  title: string;
  description?: string | null;
  /** `true` ⇒ the frontend must confirm before running AND the result is never cached. */
  dangerous: boolean;
  /** Seconds to cache the result (clamped server-side). */
  cache_ttl: number;
  /** Seconds before the exec is killed (clamped server-side). */
  timeout: number;
  /** Bytes capped per output stream (clamped server-side). */
  max_output_bytes: number;
  /** Hinted columns for `output: "table"` — most parsers derive their own. */
  columns: string[];
  variables: PluginVariable[];
  /** OS-family → command lines (resolution order: family → `linux` → `*`). */
  runs: Record<string, string[]>;
  parser: Parser;
  output: OutputKind;
}

export interface Plugin {
  schema_version: number;
  id: string;
  name: string;
  version: string;
  author: string;
  description?: string | null;
  icon?: string | null;
  /** Allowed remote families (empty list = no restriction). */
  platforms: string[];
  min_anyscp?: string | null;
  commands: PluginCommand[];
}

/** `plugin_install` source — a local file path or a raw http(s) URL. */
export type PluginSource =
  | { type: "local"; path: string }
  | { type: "url"; url: string };

export interface PluginInfo {
  enabled: boolean;
  source: string;
  installed_version: string;
  installed_at: string;
  manifest: Plugin;
}

/** One row of the marketplace registry — metadata + raw manifest URL. */
export interface PluginMarketplaceEntry {
  id: string;
  name: string;
  version: string;
  author: string;
  description?: string | null;
  icon?: string | null;
  platforms: string[];
  /** Raw URL of the plugin manifest (http/https). */
  url: string;
}

export interface PluginTable {
  columns: string[];
  rows: string[][];
}

export interface Metric {
  label: string;
  value: number;
  unit?: string | null;
}

/** Everything `plugin_run` hands back. Exactly one of text/table/metrics/json. */
export interface PluginRunResult {
  output: OutputKind;
  text?: string | null;
  table?: PluginTable | null;
  metrics?: Metric[] | null;
  json?: unknown | null;
  exit_code: number;
  stderr: string;
  truncated: boolean;
  /** True when served from the TTL cache (never true for dangerous commands). */
  cached: boolean;
  os: string;
  /** Populated when `exit_code != 0` reaches the render stage. */
  error?: string | null;
}

/** Every plugin command failure arrives as `{ kind, message }`. */
export interface PluginError {
  kind: string;
  message: string;
}
