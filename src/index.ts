import { EventEmitter } from "events";
import Docker from "dockerode";
import { v4 as uuidv4 } from "uuid";
import tar from "tar";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import {
  SandboxConfig,
  SandboxManager,
  ContainerInfo,
  ContainerStatus,
  LogEntry,
  ExecOptions,
  ExecResult,
  FileTransferOptions,
  SandboxEvent,
  LogOptions,
  PortMapping,
  VolumeMapping
} from "./types";

const DEFAULT_IMAGE = "node:20-alpine";
const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_MEMORY_LIMIT = "512m";
const DEFAULT_CPU_LIMIT = 1;

// Interface for Docker client to allow mocking
export interface IDockerClient {
  createContainer(options: Docker.ContainerCreateOptions): Promise<Docker.Container>;
  listContainers(options: Docker.ContainerListOptions): Promise<Docker.ContainerInfo[]>;
  getContainer(id: string): Docker.Container;
}

export class DockerSandboxManager extends EventEmitter implements SandboxManager {
  private docker: IDockerClient;
  private containers: Map<string, Docker.Container> = new Map();
  private containerConfigs: Map<string, SandboxConfig> = new Map();

  constructor(dockerClient?: IDockerClient | Docker.DockerOptions) {
    super();
    if (dockerClient && "createContainer" in dockerClient) {
      this.docker = dockerClient as IDockerClient;
    } else {
      this.docker = new Docker(dockerClient as Docker.DockerOptions || { socketPath: "/var/run/docker.sock" }) as unknown as IDockerClient;
    }
  }

  private emitError(containerId: string, error: Error): void {
    this.emit("error", {
      type: "error",
      containerId,
      timestamp: new Date(),
      data: { error: error.message }
    } as SandboxEvent);
  }

  async create(config: SandboxConfig): Promise<string> {
    const containerId = uuidv4();
    const containerName = `emergent-sandbox-${containerId}`;

    const normalizedConfig = this.normalizeConfig(config);
    this.containerConfigs.set(containerId, normalizedConfig);

    const createOptions = this.buildCreateOptions(containerName, normalizedConfig);

    try {
      const container = await this.docker.createContainer(createOptions);
      this.containers.set(containerId, container);

      this.emit("status", {
        type: "status",
        containerId,
        timestamp: new Date(),
        data: { status: "created", containerId }
      } as SandboxEvent);

      return containerId;
    } catch (error) {
      this.containerConfigs.delete(containerId);
      this.emitError(containerId, error as Error);
      throw error;
    }
  }

  private normalizeConfig(config: SandboxConfig): Required<SandboxConfig> {
    return {
      image: config.image || DEFAULT_IMAGE,
      cpuLimit: config.cpuLimit || DEFAULT_CPU_LIMIT,
      memoryLimit: config.memoryLimit || DEFAULT_MEMORY_LIMIT,
      networkMode: config.networkMode || "bridge",
      workingDir: config.workingDir || DEFAULT_WORKDIR,
      environment: config.environment || {},
      ports: config.ports || [],
      volumes: config.volumes || []
    };
  }

  private buildCreateOptions(name: string, config: Required<SandboxConfig>): Docker.ContainerCreateOptions {
    const hostConfig: Docker.HostConfig = {
      Memory: this.parseMemoryLimit(config.memoryLimit),
      NanoCpus: Math.round(config.cpuLimit * 1e9),
      NetworkMode: config.networkMode,
      PortBindings: this.buildPortBindings(config.ports),
      Binds: this.buildBinds(config.volumes),
      WorkingDir: config.workingDir,
      AutoRemove: false,
      Init: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ReadonlyRootfs: false,
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,size=100m",
        "/run": "rw,noexec,nosuid,size=10m"
      }
    };

    const exposedPorts: Record<string, {}> = {};
    for (const port of config.ports) {
      exposedPorts[`${port.containerPort}/${port.protocol || "tcp"}`] = {};
    }

    return {
      Image: config.image,
      Name: name,
      Env: Object.entries(config.environment).map(([k, v]) => `${k}=${v}`),
      WorkingDir: config.workingDir,
      ExposedPorts: Object.keys(exposedPorts).length > 0 ? exposedPorts : undefined,
      HostConfig: hostConfig,
      Labels: {
        "emergent.sandbox": "true",
        "emergent.managed": "true"
      }
    };
  }

  private parseMemoryLimit(limit: string): number {
    const match = limit.match(/^(\d+)([kmg]?)$/i);
    if (!match) return 512 * 1024 * 1024;
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    switch (unit) {
      case "k": return value * 1024;
      case "m": return value * 1024 * 1024;
      case "g": return value * 1024 * 1024 * 1024;
      default: return value;
    }
  }

  private buildPortBindings(ports: PortMapping[]): Record<string, Docker.PortBinding[]> {
    const bindings: Record<string, Docker.PortBinding[]> = {};
    for (const port of ports) {
      const key = `${port.containerPort}/${port.protocol || "tcp"}`;
      bindings[key] = [{
        HostPort: port.hostPort?.toString() || "",
        HostIp: "0.0.0.0"
      }];
    }
    return bindings;
  }

  private buildBinds(volumes: VolumeMapping[]): string[] {
    return volumes.map(v => {
      const readOnly = v.readOnly ? ":ro" : ":rw";
      return `${v.hostPath}:${v.containerPath}${readOnly}`;
    });
  }

  async start(containerId: string): Promise<void> {
    const container = this.containers.get(containerId);
    if (!container) {
      const error = new Error(`Container ${containerId} not found`);
      this.emitError(containerId, error);
      throw error;
    }

    try {
      await container.start();

      this.emit("status", {
        type: "status",
        containerId,
        timestamp: new Date(),
        data: { status: "running", containerId }
      } as SandboxEvent);
    } catch (error) {
      this.emitError(containerId, error as Error);
      throw error;
    }
  }

  async stop(containerId: string, timeout: number = 10): Promise<void> {
    const container = this.containers.get(containerId);
    if (!container) {
      const error = new Error(`Container ${containerId} not found`);
      this.emitError(containerId, error);
      throw error;
    }

    try {
      await container.stop({ t: timeout });

      this.emit("status", {
        type: "status",
        containerId,
        timestamp: new Date(),
        data: { status: "exited", containerId }
      } as SandboxEvent);
    } catch (error) {
      this.emitError(containerId, error as Error);
      throw error;
    }
  }

  async remove(containerId: string, force: boolean = false): Promise<void> {
    const container = this.containers.get(containerId);
    if (!container) {
      const error = new Error(`Container ${containerId} not found`);
      this.emitError(containerId, error);
      throw error;
    }

    try {
      await container.remove({ force, v: true });
      this.containers.delete(containerId);
      this.containerConfigs.delete(containerId);

      this.emit("status", {
        type: "status",
        containerId,
        timestamp: new Date(),
        data: { status: "removed", containerId }
      } as SandboxEvent);
    } catch (error) {
      this.emitError(containerId, error as Error);
      throw error;
    }
  }

  async getInfo(containerId: string): Promise<ContainerInfo | null> {
    const container = this.containers.get(containerId);
    if (!container) return null;

    try {
      const data = await container.inspect();
      return this.mapContainerInfo(data);
    } catch {
      return null;
    }
  }

  async list(): Promise<ContainerInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ["emergent.sandbox=true"] }
    });

    const results: ContainerInfo[] = [];
    for (const c of containers) {
      const container = this.docker.getContainer(c.Id);
      try {
        const data = await container.inspect();
        results.push(this.mapContainerInfo(data));
      } catch {
        // Skip containers we can't inspect
      }
    }
    return results;
  }

  private mapContainerInfo(data: Docker.ContainerInspectInfo): ContainerInfo {
    const ports: PortMapping[] = [];
    if (data.NetworkSettings?.Ports) {
      for (const [containerPort, bindings] of Object.entries(data.NetworkSettings.Ports)) {
        if (bindings) {
          for (const binding of bindings) {
            ports.push({
              containerPort: parseInt(containerPort.split("/")[0], 10),
              hostPort: binding.HostPort ? parseInt(binding.HostPort, 10) : undefined,
              protocol: containerPort.includes("/udp") ? "udp" : "tcp"
            });
          }
        }
      }
    }

    return {
      id: data.Id,
      name: data.Name?.replace(/^\//, "") || "",
      status: this.mapStatus(data.State?.Status),
      image: data.Config?.Image || "",
      ports,
      createdAt: new Date(data.Created),
      startedAt: data.State?.StartedAt ? new Date(data.State.StartedAt) : undefined,
      finishedAt: data.State?.FinishedAt ? new Date(data.State.FinishedAt) : undefined,
      exitCode: data.State?.ExitCode
    };
  }

  private mapStatus(status?: string): ContainerStatus {
    switch (status) {
      case "created": return "created";
      case "running": return "running";
      case "paused": return "paused";
      case "restarting": return "restarting";
      case "exited": return "exited";
      case "dead": return "dead";
      case "removing": return "removing";
      default: return "created";
    }
  }

  async exec(containerId: string, options: ExecOptions): Promise<ExecResult> {
    const container = this.containers.get(containerId);
    if (!container) {
      throw new Error(`Container ${containerId} not found`);
    }

    const exec = await container.exec({
      Cmd: options.cmd,
      WorkingDir: options.cwd,
      Env: options.env ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`) : undefined,
      AttachStdout: options.attachStdout ?? true,
      AttachStderr: options.attachStderr ?? true,
      Tty: options.tty ?? false
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    let stdout = "";
    let stderr = "";

    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        const header = chunk.subarray(0, 8);
        const streamType = header[0];
        const length = header.readUInt32BE(4);
        const data = chunk.subarray(8, 8 + length).toString("utf8");

        if (streamType === 1) stdout += data;
        else if (streamType === 2) stderr += data;
      };

      stream.on("data", onData);
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });

    const inspect = await exec.inspect();

    return {
      exitCode: inspect.ExitCode ?? 0,
      stdout,
      stderr
    };
  }

  async copyToContainer(containerId: string, options: FileTransferOptions): Promise<void> {
    const container = this.containers.get(containerId);
    if (!container) {
      throw new Error(`Container ${containerId} not found`);
    }

    const sourcePath = path.resolve(options.sourcePath);
    const stats = await fs.stat(sourcePath);

    const tarStream = tar.create({
      cwd: path.dirname(sourcePath),
      portable: true
    }, [path.basename(sourcePath)]);

    const chunks: Buffer[] = [];
    for await (const chunk of tarStream) {
      chunks.push(chunk);
    }
    const tarBuffer = Buffer.concat(chunks);

    await container.putArchive(tarBuffer, {
      path: path.dirname(options.targetPath),
      noOverwriteDirNonDir: false
    });
  }

  async copyFromContainer(containerId: string, options: FileTransferOptions): Promise<void> {
    const container = this.containers.get(containerId);
    if (!container) {
      throw new Error(`Container ${containerId} not found`);
    }

    const stream = await container.getArchive({ path: options.sourcePath });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const tarBuffer = Buffer.concat(chunks);

    await fs.mkdir(path.dirname(options.targetPath), { recursive: true });
    
    // Write tar buffer to a temporary file and extract using tar.x with file option
    const tempFile = path.join(os.tmpdir(), `emergent-extract-${Date.now()}.tar`);
    await fs.writeFile(tempFile, tarBuffer);
    
    try {
      await tar.x({
        cwd: path.dirname(options.targetPath),
        file: tempFile
      } as any);
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  }

  async getLogs(containerId: string, options: LogOptions = {}): Promise<LogEntry[]> {
    const container = this.containers.get(containerId);
    if (!container) {
      throw new Error(`Container ${containerId} not found`);
    }

    const logOptions: Docker.ContainerLogOptions = {
      follow: options.follow ?? false,
      stdout: options.stdout ?? true,
      stderr: options.stderr ?? true,
      since: options.since ? Math.floor(options.since.getTime() / 1000) : undefined,
      until: options.until ? Math.floor(options.until.getTime() / 1000) : undefined,
      tail: options.tail?.toString() ?? "all",
      timestamps: true
    };

    const stream = await container.logs(logOptions);
    const logs: LogEntry[] = [];

    for await (const chunk of stream) {
      const header = chunk.subarray(0, 8);
      const streamType = header[0];
      const length = header.readUInt32BE(4);
      const payload = chunk.subarray(8, 8 + length);
      const timestamp = payload.toString("utf8");
      const data = chunk.subarray(8 + length).toString("utf8");

      if (streamType === 1 || streamType === 2) {
        logs.push({
          timestamp: new Date(timestamp.trim()),
          stream: streamType === 1 ? "stdout" : "stderr",
          data
        });
      }
    }

    return logs;
  }
}

export function createSandboxManager(options?: Docker.DockerOptions | IDockerClient): DockerSandboxManager {
  if (options && "createContainer" in options) {
    return new DockerSandboxManager(options as IDockerClient);
  }
  return new DockerSandboxManager(options as Docker.DockerOptions);
}
