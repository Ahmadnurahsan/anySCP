// Tools — remote management (System Overview, Process Manager, Services).

export interface SystemOverview {
  hostname: string;
  os_name: string;
  kernel: string;
  load_1: number | null;
  load_5: number | null;
  load_15: number | null;
  cpu_cores: number | null;
  cpu_usage_pct: number | null;
  mem_total_bytes: number;
  mem_used_bytes: number;
  mem_available_bytes: number;
  swap_total_bytes: number;
  swap_used_bytes: number;
  uptime_secs: number;
  disks: DiskInfo[];
  is_linux: boolean;
}

export interface DiskInfo {
  filesystem: string;
  size_kb: number;
  used_kb: number;
  avail_kb: number;
  use_pct: number;
  mounted_on: string;
}

export interface ProcessInfo {
  pid: number;
  ppid: number | null;
  user: string;
  cpu_pct: number;
  mem_pct: number;
  rss_kb: number;
  state: string;
  name: string;
}

export interface KillResult {
  pid: number;
  signal: string;
  ok: boolean;
  message: string;
}

export type ServiceAction =
  | "start"
  | "stop"
  | "restart"
  | "reload"
  | "enable"
  | "disable";

export interface ServiceInfo {
  name: string;
  load: string;
  active: string;
  sub: string;
}

export interface ServiceResult {
  unit: string;
  action: ServiceAction;
  ok: boolean;
  needs_sudo: boolean;
  message: string;
}

export interface ToolsExecOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  truncated: boolean;
}

export type ToolsError = { kind: string; message: string };

export type ToolsToolId = "overview" | "processes" | "services" | "docker" | "network";