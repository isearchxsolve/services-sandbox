export interface SandboxConfig {
  image: string;
  cpuLimit?: number;
  memoryLimit?: string;
  networkMode?: string;
  workingDir?: string;
  environment?: Record<string, string>;
  ports?: PortMapping[];
  volumes?: VolumeMapping[];
}

export interface PortMapping {
  containerPort: number;
  hostPort?: number;
  protocol?: 'tcp' | 'udp';
}

export interface VolumeMapping {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface ContainerInfo {
  id: string;
  name: string;
  status: ContainerStatus;
  image: string;
  ports: PortMapping[];
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  exitCode?: number;
}

export type ContainerStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'restarting'
  | 'exited'
  | 'dead'
  | 'removing';

export interface LogEntry {
  timestamp: Date;
  stream: 'stdout' | 'stderr';
  data: string;
}

export interface ExecOptions {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  attachStdout?: boolean;
  attachStderr?: boolean;
  tty?: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FileTransferOptions {
  sourcePath: string;
  targetPath: string;
  mode?: number;
}

export interface SandboxEvent {
  type: 'log' | 'status' | 'error' | 'exit';
  containerId: string;
  timestamp: Date;
  data: unknown;
}

export interface SandboxManager {
  create(config: SandboxConfig): Promise<string>;
  start(containerId: string): Promise<void>;
  stop(containerId: string, timeout?: number): Promise<void>;
  remove(containerId: string, force?: boolean): Promise<void>;
  getInfo(containerId: string): Promise<ContainerInfo | null>;
  list(): Promise<ContainerInfo[]>;
  exec(containerId: string, options: ExecOptions): Promise<ExecResult>;
  copyToContainer(containerId: string, options: FileTransferOptions): Promise<void>;
  copyFromContainer(containerId: string, options: FileTransferOptions): Promise<void>;
  getLogs(containerId: string, options?: LogOptions): Promise<LogEntry[]>;
  on(event: 'log' | 'status' | 'error' | 'exit', listener: (event: SandboxEvent) => void): this;
  off(event: 'log' | 'status' | 'error' | 'exit', listener: (event: SandboxEvent) => void): this;
}

export interface LogOptions {
  follow?: boolean;
  stdout?: boolean;
  stderr?: boolean;
  since?: Date;
  until?: Date;
  tail?: number;
}
