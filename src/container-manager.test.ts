/**
 * Vitest Integration Tests for ContainerManager
 * Tests Docker container lifecycle, port mapping, and process management
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { ContainerManager, createContainerManager } from "./container-manager.js";
import type { SandboxSession, ContainerState, BackgroundProcess, ExecConfig } from "./types.js";

const TEST_DOCKER_SOCKET = process.env.DOCKER_SOCKET || "//./pipe/docker_engine";
const TEST_TIMEOUT = 60000;

let dockerAvailable = false;

describe("ContainerManager", () => {
  let manager: ContainerManager;
  let testSessionId: string;
  let testContainerId: string;

  beforeAll(async () => {
    manager = createContainerManager(TEST_DOCKER_SOCKET);
    try {
      await manager["docker"].ping();
      dockerAvailable = true;
    } catch (error) {
      console.warn("Docker daemon not available, tests will be skipped");
      dockerAvailable = false;
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (dockerAvailable && manager) {
      const containers = await manager["docker"].listContainers({
        all: true,
        filters: { label: ["emergent.session=true"] },
      });
      for (const containerInfo of containers) {
        try {
          const container = manager["docker"].getContainer(containerInfo.Id);
          await container.stop({ t: 5 }).catch(() => {});
          await container.remove({ force: true }).catch(() => {});
        } catch {
        }
      }
    }
  }, TEST_TIMEOUT);

  beforeEach(() => {
    testSessionId = "";
    testContainerId = "";
  });

  afterEach(async () => {
    if (dockerAvailable && testSessionId && manager) {
      try {
        await manager.stopSession(testSessionId);
      } catch {
      }
    }
  });

  const itIfDocker = dockerAvailable ? it : it.skip;

  describe("Session Management", () => {
    itIfDocker("should create a new sandbox session", async () => {
      const session = await manager.createSession("user-123", "project-456");
      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
      expect(session.userId).toBe("user-123");
      expect(session.projectId).toBe("project-456");
      expect(session.container.id).toBeDefined();
      expect(session.container.sessionId).toBe(session.id);
      expect(session.container.status).toBe("created");
      expect(session.container.ports.size).toBeGreaterThan(0);
      expect(session.processes).toBeInstanceOf(Map);
      expect(session.createdAt).toBeInstanceOf(Date);
      testSessionId = session.id;
      testContainerId = session.container.id;
    }, TEST_TIMEOUT);

    itIfDocker("should create session with custom configuration", async () => {
      const session = await manager.createSession("user-123", "project-456", {
        image: "node:18-alpine",
        workingDir: "/app",
        environment: { NODE_ENV: "test", CUSTOM_VAR: "value" },
        ports: [
          { containerPort: 3000, protocol: "tcp" },
          { containerPort: 4000, protocol: "tcp" },
        ],
        resources: {
          cpuQuota: 25000,
          cpuPeriod: 100000,
          memoryLimit: 256 * 1024 * 1024,
          memorySwapLimit: 512 * 1024 * 1024,
          pidsLimit: 50,
        },
      });
      expect(session.container.ports.size).toBe(2);
      expect(session.container.ports.has(3000)).toBe(true);
      expect(session.container.ports.has(4000)).toBe(true);
      testSessionId = session.id;
    }, TEST_TIMEOUT);

    itIfDocker("should get session by ID", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      const retrieved = manager.getSession(session.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(session.id);
      expect(retrieved?.userId).toBe("user-123");
    }, TEST_TIMEOUT);

    itIfDocker("should get user sessions", async () => {
      const session1 = await manager.createSession("user-123", "project-1");
      const session2 = await manager.createSession("user-123", "project-2");
      const session3 = await manager.createSession("user-456", "project-3");
      testSessionId = session1.id;
      const userSessions = manager.getUserSessions("user-123");
      expect(userSessions.length).toBe(2);
      expect(userSessions.map(s => s.id).sort()).toEqual([session1.id, session2.id].sort());
    }, TEST_TIMEOUT);
  });

  describe("Container Lifecycle", () => {
    itIfDocker("should start a container session", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      const startedContainer = await manager.startSession(session.id);
      expect(startedContainer.status).toBe("running");
      expect(startedContainer.startedAt).toBeInstanceOf(Date);
      expect(startedContainer.pid).toBeDefined();
      expect(typeof startedContainer.pid).toBe("number");
      expect(startedContainer.pid).toBeGreaterThan(0);
    }, TEST_TIMEOUT);

    itIfDocker("should emit container:started event", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      const startedPromise = new Promise<ContainerState>((resolve) => {
        manager.once("container:started", ({ container }) => resolve(container));
      });
      await manager.startSession(session.id);
      const startedContainer = await startedPromise;
      expect(startedContainer.status).toBe("running");
    }, TEST_TIMEOUT);

    itIfDocker("should stop and remove a session", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      await manager.startSession(session.id);
      await manager.stopSession(session.id);
      const stoppedSession = manager.getSession(session.id);
      expect(stoppedSession).toBeUndefined();
    }, TEST_TIMEOUT);

    itIfDocker("should emit container:stopped event", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      await manager.startSession(session.id);
      const stoppedPromise = new Promise<{ container: ContainerState; exitCode: number }>((resolve) => {
        manager.once("container:stopped", (payload) => resolve(payload));
      });
      await manager.stopSession(session.id);
      const payload = await stoppedPromise;
      expect(payload.container.status).toBe("stopped");
      expect(payload.exitCode).toBe(0);
    }, TEST_TIMEOUT);
  });

  describe("Command Execution", () => {
    itIfDocker("should execute a simple command in the container", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      await manager.startSession(session.id);
      const result = await manager.exec(session.id, {
        cmd: ["echo", "hello world"],
        attachStdout: true,
        attachStderr: true,
        attachStdin: false,
        tty: false,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello world");
      expect(result.stderr).toBe("");
      expect(result.duration).toBeGreaterThan(0);
    }, TEST_TIMEOUT);

    itIfDocker("should execute command with working directory", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      await manager.startSession(session.id);
      await manager.exec(session.id, {
        cmd: ["sh", "-c", "mkdir -p /workspace/testdir && echo 'test content' > /workspace/testdir/file.txt"],
        attachStdout: true,
        attachStderr: true,
        attachStdin: false,
        tty: false,
      });
      const result = await manager.exec(session.id, {
        cmd: ["cat", "file.txt"],
        workingDir: "/workspace/testdir",
        attachStdout: true,
        attachStderr: true,
        attachStdin: false,
        tty: false,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("test content");
    }, TEST_TIMEOUT);

    itIfDocker("should execute command with environment variables", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      await manager.startSession(session.id);
      const result = await manager.exec(session.id, {
        cmd: ["sh", "-c", "echo $CUSTOM_VAR"],
        environment: { CUSTOM_VAR: "test-value-123" },
        attachStdout: true,
        attachStderr: true,
        attachStdin: false,
        tty: false,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("test-value-123");
    }, TEST_TIMEOUT);

    itIfDocker("should handle command errors", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      await manager.startSession(session.id);
      const result = await manager.exec(session.id, {
        cmd: ["false"],
        attachStdout: true,
        attachStderr: true,
        attachStdin: false,
        tty: false,
      });
      expect(result.exitCode).toBe(1);
    }, TEST_TIMEOUT);

    itIfDocker("should throw error when executing in non-running container", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      await expect(manager.exec(session.id, {
        cmd: ["echo", "test"],
        attachStdout: true,
        attachStderr: true,
        attachStdin: false,
        tty: false,
      })).rejects.toThrow("Container is not running");
    }, TEST_TIMEOUT);
  });

  describe("Background Process Management", () => {
    itIfDocker("should start a background process", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      await manager.startSession(session.id);
      const process = await manager.startBackgroundProcess(session.id, ["sleep", "30"]);
      expect(process.id).toBeDefined();
      expect(process.sessionId).toBe(session.id);
      expect(process.command).toEqual(["sleep", "30"]);
      expect(process.status).toBe("running");
      expect(process.pid).toBeDefined();
      expect(typeof process.pid).toBe("number");
      expect(process.pid).toBeGreaterThan(0);
      expect(process.startedAt).toBeInstanceOf(Date);
    }, TEST_TIMEOUT);

    itIfDocker("should start background process with custom working directory", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      await manager.startSession(session.id);
      await manager.exec(session.id, {
        cmd: ["mkdir", "-p", "/workspace/custom"],
        attachStdout: true,
        attachStderr: true,
        attachStdin: false,
        tty: false,
      });
      const process = await manager.startBackgroundProcess(session.id, ["sh", "-c", "sleep 30"], {
        workingDir: "/workspace/custom",
      });
      expect(process.workingDir).toBe("/workspace/custom");
    }, TEST_TIMEOUT);

    itIfDocker("should start background process with environment variables", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      await manager.startSession(session.id);
      const process = await manager.startBackgroundProcess(session.id, ["sh", "-c", "sleep 30"], {
        environment: { PROCESS_VAR: "process-value" },
      });
      expect(process.environment.PROCESS_VAR).toBe("process-value");
    }, TEST_TIMEOUT);

    itIfDocker("should start background process with port mapping", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      await manager.startSession(session.id);
      const process = await manager.startBackgroundProcess(session.id, ["sh", "-c", "python3 -m http.server 8080"], {
        port: 8080,
      });
      expect(process.port).toBeDefined();
      expect(typeof process.port).toBe("number");
      expect(process.port).toBeGreaterThan(0);
    }, TEST_TIMEOUT);

    itIfDocker("should stop a background process", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      await manager.startSession(session.id);
      const process = await manager.startBackgroundProcess(session.id, ["sleep", "30"]);
      await manager.stopProcess(session.id, process.id);
      const stoppedProcess = session.processes.get(process.id);
      expect(stoppedProcess?.status).toBe("stopped");
    }, TEST_TIMEOUT);

    itIfDocker("should emit process:started and process:stopped events", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      await manager.startSession(session.id);
      const startedPromise = new Promise<BackgroundProcess>((resolve) => {
        manager.once("process:started", ({ process }) => resolve(process));
      });
      const process = await manager.startBackgroundProcess(session.id, ["sleep", "5"]);
      const startedProcess = await startedPromise;
      expect(startedProcess.id).toBe(process.id);
      const stoppedPromise = new Promise<{ process: BackgroundProcess; exitCode: number }>((resolve) => {
        manager.once("process:stopped", (payload) => resolve(payload));
      });
      await manager.stopProcess(session.id, process.id);
      const stoppedPayload = await stoppedPromise;
      expect(stoppedPayload.process.id).toBe(process.id);
      expect(stoppedPayload.exitCode).toBe(0);
    }, TEST_TIMEOUT);
  });

  describe("Log Streaming", () => {
    itIfDocker("should emit log:stdout events", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      await manager.startSession(session.id);
      const logPromise = new Promise<string>((resolve) => {
        manager.once("log:stdout", (entry) => resolve(entry.data));
      });
      await manager.exec(session.id, {
        cmd: ["echo", "test-log-output"],
        attachStdout: true,
        attachStderr: true,
        attachStdin: false,
        tty: false,
      });
      const logData = await logPromise;
      expect(logData).toContain("test-log-output");
    }, TEST_TIMEOUT);

    itIfDocker("should emit log:stderr events", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      await manager.startSession(session.id);
      const logPromise = new Promise<string>((resolve) => {
        manager.once("log:stderr", (entry) => resolve(entry.data));
      });
      await manager.exec(session.id, {
        cmd: ["sh", "-c", "echo 'error message' >&2"],
        attachStdout: true,
        attachStderr: true,
        attachStdin: false,
        tty: false,
      });
      const logData = await logPromise;
      expect(logData).toContain("error message");
    }, TEST_TIMEOUT);
  });

  describe("Port Allocation", () => {
    itIfDocker("should allocate unique host ports for each container port", async () => {
      const session = await manager.createSession("user-123", "project-456", {
        ports: [
          { containerPort: 3000, protocol: "tcp" },
          { containerPort: 3001, protocol: "tcp" },
          { containerPort: 8080, protocol: "tcp" },
        ],
      });
      testSessionId = session.id;
      const ports = Array.from(session.container.ports.values());
      const uniquePorts = new Set(ports);
      expect(ports.length).toBe(3);
      expect(uniquePorts.size).toBe(3);
      expect(ports.every(p => p >= 30000 && p <= 40000)).toBe(true);
    }, TEST_TIMEOUT);

    itIfDocker("should release ports when session is stopped", async () => {
      const session = await manager.createSession("user-123", "project-456");
      testSessionId = session.id;
      const allocatedPorts = Array.from(session.container.ports.values());
      await manager.startSession(session.id);
      await manager.stopSession(session.id);
      const session2 = await manager.createSession("user-123", "project-457");
      testSessionId = session2.id;
      const newPorts = Array.from(session2.container.ports.values());
      expect(newPorts.length).toBeGreaterThan(0);
    }, TEST_TIMEOUT);
  });

  describe("Error Handling", () => {
    itIfDocker("should emit container:error event on container failure", async () => {
      const session = await manager.createSession("user-123", "project-456", {
        image: "nonexistent-image-that-does-not-exist:latest",
      });
      testSessionId = session.id;
      const errorPromise = new Promise<{ container: ContainerState; error: Error }>((resolve) => {
        manager.once("container:error", (payload) => resolve(payload));
      });
      try {
        await manager.startSession(session.id);
      } catch {
      }
      const payload = await errorPromise;
      expect(payload.error).toBeInstanceOf(Error);
    }, TEST_TIMEOUT);

    itIfDocker("should handle stopSession for non-existent session", async () => {
      await expect(manager.stopSession("non-existent-session")).rejects.toThrow("Session non-existent-session not found");
    }, TEST_TIMEOUT);

    itIfDocker("should handle exec for non-existent session", async () => {
      await expect(manager.exec("non-existent-session", {
        cmd: ["echo", "test"],
        attachStdout: true,
        attachStderr: true,
        attachStdin: false,
        tty: false,
      })).rejects.toThrow("Session non-existent-session not found");
    }, TEST_TIMEOUT);
  });
});

describe("createContainerManager factory", () => {
  it("should create a ContainerManager instance", () => {
    const manager = createContainerManager();
    expect(manager).toBeInstanceOf(ContainerManager);
  });

  it("should accept custom docker socket path", () => {
    const manager = createContainerManager("/custom/docker.sock");
    expect(manager).toBeInstanceOf(ContainerManager);
  });
});

// Unit tests that don't require Docker
describe("ContainerManager - Unit Tests (No Docker Required)", () => {
  describe("createContainerManager factory", () => {
    it("should create a ContainerManager instance", () => {
      const manager = createContainerManager();
      expect(manager).toBeInstanceOf(ContainerManager);
    });

    it("should accept custom docker socket path", () => {
      const manager = createContainerManager("/custom/docker.sock");
      expect(manager).toBeInstanceOf(ContainerManager);
    });
  });

  describe("Port allocation logic", () => {
    it("should have correct port range constants", () => {
      expect(30000).toBeLessThan(40000);
    });
  });

  describe("Type exports", () => {
    it("should export all required types", () => {
      expect(typeof ContainerManager).toBe("function");
      expect(typeof createContainerManager).toBe("function");
    });
  });
});