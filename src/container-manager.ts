/**
 * Docker Container Manager
 * Handles container lifecycle, port mapping, and process management
 */

import Docker from "dockerode";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "net";
import {
  ContainerConfig,
  ContainerState,
  ContainerStatus,
  ExecConfig,
  ExecResult,
  LogEntry,
  SandboxSession,
  BackgroundProcess,
  ProcessStatus,
  PortMapping,
  VolumeMount,
  ResourceLimits,
  SandboxEvents,
} from "./types.js";
import { EventEmitter } from "events";

const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  cpuQuota: 50000,
  cpuPeriod: 100000,
  memoryLimit: 512 * 1024 * 1024, // 512MB
  memorySwapLimit: 1024 * 1024 * 1024, // 1GB
  pidsLimit: 100,
};

const DEFAULT_IMAGE = "node:20-alpine";

type DockerContainer = import("dockerode").Container;
type DockerHostConfig = import("dockerode").HostConfig;

export class ContainerManager extends EventEmitter<{
  [K in keyof SandboxEvents]: (payload: SandboxEvents[K]) => void;
}> {
  private docker: ReturnType<typeof Docker>;
  private sessions: Map<string, SandboxSession> = new Map();
  private containers: Map<string, DockerContainer> = new Map();
  private hostPortAllocator: Set<number> = new Set();
  private readonly portRangeStart = 30000;
  private readonly portRangeEnd = 40000;

  constructor(dockerSocketPath?: string) {
    super();
    this.docker = Docker({
      socketPath: dockerSocketPath || "/var/run/docker.sock",
    });
  }

  /**
   * Create a new sandbox session with a container
   */
  async createSession(
    userId: string,
    projectId: string,
    config?: Partial<ContainerConfig>
  ): Promise<SandboxSession> {
    const sessionId = uuidv4();
    const containerId = uuidv4();

    // Allocate host ports for container ports
    const portMappings = config?.ports || [
      { containerPort: 3000, protocol: "tcp" as const },
      { containerPort: 8000, protocol: "tcp" as const },
      { containerPort: 5173, protocol: "tcp" as const },
    ];

    const allocatedPorts = new Map<number, number>();
    for (const mapping of portMappings) {
      const hostPort = await this.allocateHostPort();
      allocatedPorts.set(mapping.containerPort, hostPort);
    }

    const containerConfig: ContainerConfig = {
      image: config?.image || DEFAULT_IMAGE,
      workingDir: config?.workingDir || "/workspace",
      environment: config?.environment || {},
      ports: portMappings.map((m) => ({
        ...m,
        hostPort: allocatedPorts.get(m.containerPort)!,
      })),
      volumes: config?.volumes || [
        {
          source: `/tmp/emergent-${sessionId}`,
          target: "/workspace",
          type: "bind",
          readOnly: false,
        },
      ],
      resources: config?.resources || DEFAULT_RESOURCE_LIMITS,
      networkMode: config?.networkMode || "bridge",
    };

    // Create container
    const container = await this.createContainer(containerId, containerConfig);
    this.containers.set(containerId, container);

    const containerState: ContainerState = {
      id: containerId,
      sessionId,
      status: "created",
      createdAt: new Date(),
      ports: allocatedPorts,
    };

    const session: SandboxSession = {
      id: sessionId,
      userId,
      projectId,
      container: containerState,
      processes: new Map(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.sessions.set(sessionId, session);
    this.emit("container:created", { container: containerState });

    return session;
  }

  /**
   * Start the container for a session
   */
  async startSession(sessionId: string): Promise<ContainerState> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const container = this.containers.get(session.container.id);
    if (!container) {
      throw new Error(`Container ${session.container.id} not found`);
    }

    // Update status to starting
    const updatedState: ContainerState = {
      ...session.container,
      status: "starting",
    };
    session.container = updatedState;
    session.updatedAt = new Date();

    try {
      await container.start();

      // Wait for container to be running
      await this.waitForContainerRunning(container);

      const startedState: ContainerState = {
        ...session.container,
        status: "running",
        startedAt: new Date(),
        pid: await this.getContainerPid(container),
      };
      session.container = startedState;
      session.updatedAt = new Date();

      this.emit("container:started", { container: startedState });

      // Start log streaming
      this.streamLogs(sessionId, container);

      return startedState;
    } catch (error) {
      const errorState: ContainerState = {
        ...session.container,
        status: "error",
      };
      session.container = errorState;
      this.emit("container:error", { container: errorState, error: error as Error });
      throw error;
    }
  }

  /**
   * Stop and remove a session
   */
  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const container = this.containers.get(session.container.id);
    if (container) {
      const updatedState: ContainerState = {
        ...session.container,
        status: "stopping",
      };
      session.container = updatedState;

      try {
        await container.stop({ t: 10 });
        await container.remove({ force: true });
      } catch (error) {
        // Force remove if stop fails
        await container.remove({ force: true }).catch(() => {});
      }

      this.containers.delete(session.container.id);
      this.releaseHostPorts(session.container.ports);
    }

    // Stop all background processes
    for (const process of session.processes.values()) {
      if (process.status === "running" || process.status === "starting") {
        await this.stopProcess(sessionId, process.id);
      }
    }

    const finalState: ContainerState = {
      ...session.container,
      status: "stopped",
      finishedAt: new Date(),
    };
    session.container = finalState;
    session.updatedAt = new Date();

    this.emit("container:stopped", { container: finalState, exitCode: 0 });
    this.sessions.delete(sessionId);
  }

  /**
   * Execute a command in the container
   */
  async exec(sessionId: string, config: ExecConfig): Promise<ExecResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const container = this.containers.get(session.container.id);
    if (!container) {
      throw new Error(`Container ${session.container.id} not found`);
    }

    if (session.container.status !== "running") {
      throw new Error(`Container is not running (status: ${session.container.status})`);
    }

    const startTime = Date.now();

    const exec = await container.exec({
      Cmd: config.cmd,
      WorkingDir: config.workingDir || session.container.workingDir,
      Env: config.environment
        ? Object.entries(config.environment).map(([k, v]) => `${k}=${v}`)
        : undefined,
      AttachStdout: config.attachStdout,
      AttachStderr: config.attachStderr,
      AttachStdin: config.attachStdin,
      Tty: config.tty,
      User: config.user,
    });

    const stream = await exec.start({ hijack: true, stdin: config.attachStdin });

    let stdout = "";
    let stderr = "";

    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        const data = chunk.toString();
        if (config.attachStdout) stdout += data;
        if (config.attachStderr) stderr += data;
      };

      stream.on("data", onData);
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });

    const inspect = await exec.inspect();
    const exitCode = inspect.ExitCode ?? -1;

    return {
      exitCode,
      stdout,
      stderr,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Start a background process in the container
   */
  async startBackgroundProcess(
    sessionId: string,
    command: readonly string[],
    options: {
      workingDir?: string;
      environment?: Record<string, string>;
      port?: number;
    } = {}
  ): Promise<BackgroundProcess> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (session.container.status !== "running") {
      throw new Error(`Container is not running`);
    }

    const processId = uuidv4();
    const workingDir = options.workingDir || session.container.workingDir;

    // Build command with nohup and output redirection
    const fullCommand = [
      "sh",
      "-c",
      `nohup ${command.join(" ")} > /tmp/process-${processId}.out 2>&1 & echo $!`,
    ];

    const result = await this.exec(sessionId, {
      cmd: fullCommand,
      workingDir,
      environment: options.environment,
      attachStdout: true,
      attachStderr: true,
      attachStdin: false,
      tty: false,
    });

    const pid = parseInt(result.stdout.trim(), 10);
    if (isNaN(pid)) {
      throw new Error(`Failed to start background process: ${result.stderr}`);
    }

    let hostPort: number | undefined;
    if (options.port) {
      hostPort = await this.allocateHostPort();
      // Set up port forwarding using socat or iptables
      await this.setupPortForwarding(session.container.id, options.port, hostPort);
    }

    const process: BackgroundProcess = {
      id: processId,
      sessionId,
      command,
      workingDir,
      environment: options.environment || {},
      status: "running",
      pid,
      port: hostPort,
      startedAt: new Date(),
      stdout: [],
      stderr: [],
    };

    session.processes.set(processId, process);
    session.updatedAt = new Date();

    this.emit("process:started", { process });

    // Start monitoring the process
    this.monitorProcess(sessionId, processId);

    return process;
  }

  /**
   * Stop a background process
   */
  async stopProcess(sessionId: string, processId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const process = session.processes.get(processId);
    if (!process) {
      throw new Error(`Process ${processId} not found`);
    }

    if (process.pid) {
      await this.exec(sessionId, {
        cmd: ["kill", "-TERM", String(process.pid)],
        attachStdout: true,
        attachStderr: true,
        attachStdin: false,
        tty: false,
      });
    }

    if (process.port) {
      this.releaseHostPort(process.port);
    }

    const stoppedProcess: BackgroundProcess = {
      ...process,
      status: "stopped",
    };
    session.processes.set(processId, stoppedProcess);
    session.updatedAt = new Date();

    this.emit("process:stopped", { process: stoppedProcess, exitCode: 0 });
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): SandboxSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions for a user
   */
  getUserSessions(userId: string): SandboxSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.userId === userId);
  }

  /**
   * Allocate a host port from the available range
   */
  private async allocateHostPort(): Promise<number> {
    for (let port = this.portRangeStart; port <= this.portRangeEnd; port++) {
      if (!this.hostPortAllocator.has(port)) {
        // Check if port is actually available on host
        const available = await this.isPortAvailable(port);
        if (available) {
          this.hostPortAllocator.add(port);
          return port;
        }
      }
    }
    throw new Error("No available ports in range");
  }

  /**
   * Release allocated host ports
   */
  private releaseHostPorts(ports: ReadonlyMap<number, number>): void {
    for (const hostPort of ports.values()) {
      this.hostPortAllocator.delete(hostPort);
    }
  }

  private releaseHostPort(port: number): void {
    this.hostPortAllocator.delete(port);
  }

  /**
   * Check if a port is available on the host
   */
  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port);
    });
  }

  /**
   * Create a Docker container
   */
  private async createContainer(
    containerId: string,
    config: ContainerConfig
  ): Promise<DockerContainer> {
    const hostConfig: DockerHostConfig = {
      Memory: config.resources.memoryLimit,
      MemorySwap: config.resources.memorySwapLimit,
      CpuQuota: config.resources.cpuQuota,
      CpuPeriod: config.resources.cpuPeriod,
      PidsLimit: config.resources.pidsLimit,
      NetworkMode: config.networkMode,
      PortBindings: {},
      Binds: config.volumes
        .filter((v) => v.type === "bind")
        .map((v) => `${v.source}:${v.target}:${v.readOnly ? "ro" : "rw"}`),
      Tmpfs: config.volumes
        .filter((v) => v.type === "tmpfs")
        .reduce((acc, v) => ({ ...acc, [v.target]: "" }), {} as Record<string, string>),
    };

    // Set up port bindings
    for (const mapping of config.ports) {
      if (mapping.hostPort) {
        hostConfig.PortBindings![`${mapping.containerPort}/${mapping.protocol}`] = [
          { HostPort: String(mapping.hostPort) },
        ];
      }
    }

    const container = await this.docker.createContainer({
      Image: config.image,
      WorkingDir: config.workingDir,
      Env: Object.entries(config.environment).map(([k, v]) => `${k}=${v}`),
      HostConfig: hostConfig,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: true,
      Tty: true,
      OpenStdin: true,
      StdinOnce: false,
      Labels: {
        "emergent.session": "true",
        "emergent.container-id": containerId,
      },
    });

    return container;
  }

  /**
   * Wait for container to reach running state
   */
  private async waitForContainerRunning(
    container: DockerContainer,
    timeout = 30000
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const info = await container.inspect();
      if (info.State.Running) {
        return;
      }
      if (info.State.Status === "exited" || info.State.Status === "dead") {
        throw new Error(`Container exited unexpectedly with code ${info.State.ExitCode}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    throw new Error("Timeout waiting for container to start");
  }

  /**
   * Get container PID
   */
  private async getContainerPid(container: DockerContainer): Promise<number | undefined> {
    const info = await container.inspect();
    return info.State.Pid;
  }

  /**
   * Stream container logs
   */
  private async streamLogs(sessionId: string, container: DockerContainer): Promise<void> {
    const stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: true,
    });

    stream.on("data", (chunk: Buffer) => {
      // Docker log format: 8-byte header + data
      // First byte: stream type (1=stdout, 2=stderr)
      // Next 3 bytes: reserved
      // Next 4 bytes: length (big-endian)
      let offset = 0;
      while (offset < chunk.length) {
        if (offset + 8 > chunk.length) break;

        const streamType = chunk[offset];
        const length = chunk.readUInt32BE(offset + 4);
        offset += 8;

        if (offset + length > chunk.length) break;

        const data = chunk.subarray(offset, offset + length).toString("utf8");
        offset += length;

        const logEntry: LogEntry = {
          timestamp: new Date(),
          stream: streamType === 1 ? "stdout" : "stderr",
          data,
          containerId: container.id,
        };

        if (streamType === 1) {
          this.emit("log:stdout", logEntry);
        } else if (streamType === 2) {
          this.emit("log:stderr", logEntry);
        }
      }
    });

    stream.on("error", (error: Error) => {
      this.emit("container:error", {
        container: this.sessions.get(sessionId)!.container,
        error,
      });
    });
  }

  /**
   * Set up port forwarding from container port to host port
   */
  private async setupPortForwarding(
    containerId: string,
    containerPort: number,
    hostPort: number
  ): Promise<void> {
    // Using socat inside the container for port forwarding
    const container = this.containers.get(containerId);
    if (!container) return;

    await this.exec(containerId, {
      cmd: [
        "sh",
        "-c",
        `apk add --no-cache socat >/dev/null 2>&1 && socat TCP-LISTEN:${hostPort},fork,reuseaddr TCP:localhost:${containerPort} &`,
      ],
      attachStdout: true,
      attachStderr: true,
      attachStdin: false,
      tty: false,
    });
  }

  /**
   * Monitor background process health
   */
  private async monitorProcess(sessionId: string, processId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const process = session.processes.get(processId);
    if (!process || !process.pid) return;

    // Poll process status
    const checkInterval = setInterval(async () => {
      const currentSession = this.sessions.get(sessionId);
      if (!currentSession) {
        clearInterval(checkInterval);
        return;
      }

      const currentProcess = currentSession.processes.get(processId);
      if (!currentProcess) {
        clearInterval(checkInterval);
        return;
      }

      try {
        const result = await this.exec(sessionId, {
          cmd: ["kill", "-0", String(currentProcess.pid)],
          attachStdout: true,
          attachStderr: true,
          attachStdin: false,
          tty: false,
        });

        if (result.exitCode !== 0) {
          // Process has exited
          const crashedProcess: BackgroundProcess = {
            ...currentProcess,
            status: "crashed",
          };
          currentSession.processes.set(processId, crashedProcess);
          currentSession.updatedAt = new Date();

          this.emit("process:error", {
            process: crashedProcess,
            error: new Error("Process exited unexpectedly"),
          });

          clearInterval(checkInterval);
        }
      } catch {
        // Process check failed
        clearInterval(checkInterval);
      }
    }, 5000);
  }
}

export function createContainerManager(dockerSocketPath?: string): ContainerManager {
  return new ContainerManager(dockerSocketPath);
}
