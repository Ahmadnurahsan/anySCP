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

// ─── Docker (Phase 2) ────────────────────────────────────────────────────

export interface DockerAvailability {
  present: boolean;
  daemon: boolean;
  client_version: string | null;
  server_version: string | null;
  needs_sudo: boolean;
  message: string;
}

export interface DockerContainer {
  id: string;
  names: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  created_at: string;
}

export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created_at: string;
}

export interface DockerStat {
  container: string;
  name: string;
  cpu_pct: number;
  mem_use: string;
  mem_pct: number;
  net_io: string;
  block_io: string;
  pid_count: number;
}

export type DockerContainerAction =
  | "start"
  | "stop"
  | "restart"
  | "remove";

export interface DockerActionResponse {
  container: string;
  action: DockerContainerAction;
  ok: boolean;
  needs_sudo: boolean;
  message: string;
}

export interface DockerLogFrame {
  stream_id: string;
  data: string;
  done: boolean;
  error: string | null;
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