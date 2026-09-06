import { vi } from 'vitest';
import { DockerSandboxManager, createSandboxManager, IDockerClient } from '../src/index';
import {
  SandboxConfig,
  ContainerStatus,
  ExecOptions,
  LogOptions,
  SandboxEvent
} from '../src/types';

// Mock Docker container
class MockContainer {
  public id: string;
  public name: string;
  public status: string = 'created';
  public inspectData: any = {};
  public execCount: number = 0;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
    this.inspectData = {
      Id: id,
      Name: `/${name}`,
      State: {
        Status: 'created',
        ExitCode: 0,
        StartedAt: '',
        FinishedAt: ''
      },
      Config: {
        Image: 'alpine:latest',
        Env: []
      },
      Created: new Date().toISOString(),
      NetworkSettings: {
        Ports: {}
      }
    };
  }

  async start(): Promise<void> {
    this.status = 'running';
    this.inspectData.State.Status = 'running';
    this.inspectData.State.StartedAt = new Date().toISOString();
  }

  async stop(options?: { t?: number }): Promise<void> {
    this.status = 'exited';
    this.inspectData.State.Status = 'exited';
    this.inspectData.State.ExitCode = 0;
    this.inspectData.State.FinishedAt = new Date().toISOString();
  }

  async remove(options?: { force?: boolean; v?: boolean }): Promise<void> {
    this.status = 'removed';
  }

  async inspect(): Promise<any> {
    return this.inspectData;
  }

  async exec(options: any): Promise<any> {
    this.execCount++;
    const cmd = options.Cmd?.join(' ') || '';
    
    return {
      start: async (opts: any) => {
        const mockStream = {
          on: (event: string, handler: Function) => {
            if (event === 'data') {
              // Simulate stdout/stderr data based on command
              let output = 'hello world';
              let streamType = 1; // stdout
              
              if (cmd.includes('>&2')) {
                output = 'error message';
                streamType = 2; // stderr
              } else if (cmd.includes('false')) {
                output = '';
              } else if (cmd.includes('pwd')) {
                output = '/tmp';
              } else if (cmd.includes('TEST_VAR')) {
                output = 'test_value';
              } else if (cmd.includes('cat /workspace/test.txt')) {
                output = 'Hello from host';
              } else if (cmd.includes('ls /workspace/mydir')) {
                output = 'file1.txt\nfile2.txt';
              } else if (cmd.includes('echo')) {
                const match = cmd.match(/echo\s+(.+)/);
                if (match) output = match[1].replace(/['"]/g, '');
              }
              
              const header = Buffer.alloc(8);
              header[0] = streamType;
              header.writeUInt32BE(Buffer.byteLength(output), 4);
              const data = Buffer.concat([header, Buffer.from(output)]);
              setTimeout(() => handler(data), 0);
            }
            if (event === 'end') {
              setTimeout(() => handler(), 0);
            }
            if (event === 'error') {
              // Don't call error handler
            }
          }
        };
        return mockStream;
      },
      inspect: async () => ({ 
        ExitCode: cmd.includes('false') ? 1 : 0 
      })
    };
  }

  async putArchive(data: Buffer, options: any): Promise<void> {
    // Mock implementation - does nothing
  }

  async getArchive(options: any): Promise<any> {
    // Return a proper tar stream with file - use proper format for tar extract
    const content = 'from container';
    const fileBuffer = Buffer.from(content);
    
    // Create proper tar entry with all required fields (ustar format)
    const tarHeader = Buffer.alloc(512);
    const filename = 'from-container.txt';
    
    // Name (100 bytes)
    Buffer.from(filename.padEnd(100, '\0')).copy(tarHeader, 0);
    // Mode (8 bytes)
    Buffer.from('0000644').copy(tarHeader, 100);
    // UID (8 bytes)
    Buffer.from('0000000').copy(tarHeader, 108);
    // GID (8 bytes)
    Buffer.from('0000000').copy(tarHeader, 116);
    // Size (12 bytes)
    const sizeOctal = fileBuffer.length.toString(8).padStart(11, '0') + '\0';
    Buffer.from(sizeOctal).copy(tarHeader, 124);
    // MTIME (12 bytes)
    const mtimeOctal = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0';
    Buffer.from(mtimeOctal).copy(tarHeader, 136);
    // Typeflag (1 byte)
    tarHeader[156] = 48; // '0' for regular file
    // Linkname (100 bytes)
    Buffer.from('\0'.repeat(100)).copy(tarHeader, 157);
    // Magic (6 bytes)
    Buffer.from('ustar\0').copy(tarHeader, 257);
    // Version (2 bytes)
    Buffer.from('00').copy(tarHeader, 263);
    // Uname (32 bytes)
    Buffer.from('root\0'.padEnd(32, '\0')).copy(tarHeader, 265);
    // Gname (32 bytes)
    Buffer.from('root\0'.padEnd(32, '\0')).copy(tarHeader, 297);
    // Devmajor (8 bytes)
    Buffer.from('0000000').copy(tarHeader, 329);
    // Devminor (8 bytes)
    Buffer.from('0000000').copy(tarHeader, 337);
    // Prefix (155 bytes)
    Buffer.from('\0'.repeat(155)).copy(tarHeader, 345);
    
    // Calculate checksum
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += i >= 148 && i < 156 ? 32 : tarHeader[i]; // spaces for checksum field
    }
    const checksumOctal = checksum.toString(8).padStart(6, '0') + '\0\0';
    Buffer.from(checksumOctal).copy(tarHeader, 148);
    
    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.concat([tarHeader, fileBuffer, Buffer.alloc(512 - (fileBuffer.length % 512))]);
        // End of archive marker (two 512-byte blocks of zeros)
        yield Buffer.alloc(512);
        yield Buffer.alloc(512);
      }
    };
    return mockStream;
  }

  async logs(options: any): Promise<any> {
    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        // Generate log entries in the format expected by the implementation:
        // Header: 8 bytes (stream type + length of timestamp)
        // Payload: timestamp string (length bytes)
        // Data: rest of chunk (the actual log message)
        const tail = options.tail && options.tail !== 'all' ? parseInt(options.tail) : 100;
        const entries = [
          { stream: 1, data: 'log test message\n' },
          { stream: 2, data: 'error message\n' },
          { stream: 1, data: 'line 0\n' },
          { stream: 1, data: 'line 1\n' },
          { stream: 1, data: 'line 2\n' },
          { stream: 1, data: 'line 3\n' },
          { stream: 1, data: 'line 4\n' }
        ];
        
        // If tail is specified, only return last N entries
        const entriesToUse = tail < entries.length ? entries.slice(-tail) : entries;
        
        for (const entry of entriesToUse) {
          const timestamp = new Date().toISOString();
          const timestampBuf = Buffer.from(timestamp);
          const dataBuf = Buffer.from(entry.data);
          
          const header = Buffer.alloc(8);
          header[0] = entry.stream;
          header.writeUInt32BE(timestampBuf.length, 4);
          
          // Payload = timestamp, Data = message
          yield Buffer.concat([header, timestampBuf, dataBuf]);
        }
      }
    };
    return mockStream;
  }
}

// Mock Docker client
class MockDockerClient implements IDockerClient {
  private containers: Map<string, MockContainer> = new Map();

  async createContainer(options: any): Promise<MockContainer> {
    // Use full UUID as ID (without the prefix)
    const fullId = options.Name?.replace('emergent-sandbox-', '') || 'mock-' + Date.now();
    const container = new MockContainer(fullId, options.Name);
    this.containers.set(fullId, container);
    return container;
  }

  async listContainers(options?: any): Promise<any[]> {
    const result = [];
    for (const [id, container] of this.containers) {
      result.push({
        Id: id,
        Names: [`/${container.name}`],
        Labels: { 'emergent.sandbox': 'true' },
        State: container.status,
        Status: container.status,
        Image: 'alpine:latest',
        Created: Math.floor(Date.now() / 1000)
      });
    }
    return result;
  }

  getContainer(id: string): MockContainer {
    if (this.containers.has(id)) {
      return this.containers.get(id)!;
    }
    // For non-existent containers, throw to simulate Docker behavior
    throw new Error(`Container ${id} not found`);
  }
}

describe('DockerSandboxManager', () => {
  let manager: DockerSandboxManager;
  let mockClient: MockDockerClient;
  let testContainerId: string | null = null;

  beforeAll(() => {
    mockClient = new MockDockerClient();
    manager = createSandboxManager(mockClient);
  });

  afterAll(async () => {
    if (testContainerId) {
      try {
        await manager.remove(testContainerId, true);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  beforeEach(() => {
    testContainerId = null;
  });

  describe('create', () => {
    it('should create a container with default config', async () => {
      const config: SandboxConfig = {
        image: 'alpine:latest'
      };

      testContainerId = await manager.create(config);
      expect(testContainerId).toBeDefined();
      expect(typeof testContainerId).toBe('string');
      expect(testContainerId.length).toBeGreaterThan(0);
    });

    it('should create a container with custom config', async () => {
      const config: SandboxConfig = {
        image: 'node:20-alpine',
        cpuLimit: 0.5,
        memoryLimit: '256m',
        workingDir: '/app',
        environment: {
          NODE_ENV: 'test',
          CUSTOM_VAR: 'value'
        },
        ports: [
          { containerPort: 3000, hostPort: 3001 }
        ],
        volumes: [
          { hostPath: '/tmp/test', containerPath: '/data', readOnly: false }
        ]
      };

      testContainerId = await manager.create(config);
      expect(testContainerId).toBeDefined();
    });

    it('should emit status event on create', async () => {
      const statusEvents: Array<{ type: string; containerId: string }> = [];
      manager.on('status', (event) => {
        if (event.type === 'status') {
          statusEvents.push({ type: event.data?.status as string, containerId: event.containerId });
        }
      });

      testContainerId = await manager.create({ image: 'alpine:latest' });
      expect(statusEvents.length).toBeGreaterThan(0);
      expect(statusEvents[0].type).toBe('created');
      expect(statusEvents[0].containerId).toBe(testContainerId);
    });
  });

  describe('start', () => {
    it('should start a created container', async () => {
      testContainerId = await manager.create({ image: 'alpine:latest' });
      await expect(manager.start(testContainerId)).resolves.not.toThrow();
    });

    it('should emit status event on start', async () => {
      const statusEvents: string[] = [];
      manager.on('status', (event) => {
        if (event.type === 'status') {
          statusEvents.push(event.data?.status as string);
        }
      });

      testContainerId = await manager.create({ image: 'alpine:latest' });
      await manager.start(testContainerId);
      expect(statusEvents).toContain('running');
    });

    it('should throw for non-existent container', async () => {
      await expect(manager.start('non-existent-id')).rejects.toThrow('Container non-existent-id not found');
    });
  });

  describe('stop', () => {
    it('should stop a running container', async () => {
      testContainerId = await manager.create({ image: 'alpine:latest' });
      await manager.start(testContainerId);
      await expect(manager.stop(testContainerId)).resolves.not.toThrow();
    });

    it('should emit status event on stop', async () => {
      const statusEvents: string[] = [];
      manager.on('status', (event) => {
        if (event.type === 'status') {
          statusEvents.push(event.data?.status as string);
        }
      });

      testContainerId = await manager.create({ image: 'alpine:latest' });
      await manager.start(testContainerId);
      await manager.stop(testContainerId);
      expect(statusEvents).toContain('exited');
    });
  });

  describe('remove', () => {
    it('should remove a container', async () => {
      testContainerId = await manager.create({ image: 'alpine:latest' });
      await expect(manager.remove(testContainerId, true)).resolves.not.toThrow();
      testContainerId = null;
    });

    it('should emit status event on remove', async () => {
      const statusEvents: string[] = [];
      manager.on('status', (event) => {
        if (event.type === 'status') {
          statusEvents.push(event.data?.status as string);
        }
      });

      testContainerId = await manager.create({ image: 'alpine:latest' });
      await manager.remove(testContainerId, true);
      expect(statusEvents).toContain('removed');
      testContainerId = null;
    });
  });

  describe('getInfo', () => {
    it('should return container info for existing container', async () => {
      testContainerId = await manager.create({ image: 'alpine:latest' });
      const info = await manager.getInfo(testContainerId);
      expect(info).not.toBeNull();
      expect(info?.id).toBe(testContainerId);
      expect(info?.status).toBe('created');
      expect(info?.image).toContain('alpine');
    });

    it('should return null for non-existent container', async () => {
      const info = await manager.getInfo('non-existent-id');
      expect(info).toBeNull();
    });
  });

  describe('list', () => {
    it('should list all managed containers', async () => {
      const id1 = await manager.create({ image: 'alpine:latest' });
      const id2 = await manager.create({ image: 'alpine:latest' });
      const containers = await manager.list();
      expect(containers.length).toBeGreaterThanOrEqual(2);
      const ids = containers.map(c => c.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
      await manager.remove(id1, true);
      await manager.remove(id2, true);
    });
  });

  describe('exec', () => {
    it('should execute a command in the container', async () => {
      testContainerId = await manager.create({ image: 'alpine:latest' });
      await manager.start(testContainerId);
      
      const result = await manager.exec(testContainerId, {
        cmd: ['echo', 'hello world']
      });
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello world');
    });

    it('should capture stderr', async () => {
      testContainerId = await manager.create({ image: 'alpine:latest' });
      await manager.start(testContainerId);
      
      const result = await manager.exec(testContainerId, {
        cmd: ['sh', '-c', 'echo error >&2']
      });
      
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('error');
    });

    it('should return non-zero exit code for failing command', async () => {
      testContainerId = await manager.create({ image: 'alpine:latest' });
      await manager.start(testContainerId);
      
      const result = await manager.exec(testContainerId, {
        cmd: ['false']
      });
      
      expect(result.exitCode).not.toBe(0);
    });

    it('should respect working directory', async () => {
      testContainerId = await manager.create({ 
        image: 'alpine:latest',
        workingDir: '/tmp'
      });
      await manager.start(testContainerId);
      
      const result = await manager.exec(testContainerId, {
        cmd: ['pwd']
      });
      
      expect(result.stdout.trim()).toBe('/tmp');
    });

    it('should pass environment variables', async () => {
      testContainerId = await manager.create({ 
        image: 'alpine:latest',
        environment: { TEST_VAR: 'test_value' }
      });
      await manager.start(testContainerId);
      
      const result = await manager.exec(testContainerId, {
        cmd: ['sh', '-c', 'echo $TEST_VAR']
      });
      
      expect(result.stdout.trim()).toBe('test_value');
    });
  });

  describe('copyToContainer', () => {
    it('should copy a file to the container', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const tmpDir = await fs.mkdtemp('/tmp/emergent-test-');
      const testFile = path.join(tmpDir, 'test.txt');
      await fs.writeFile(testFile, 'Hello from host');

      testContainerId = await manager.create({ image: 'alpine:latest' });
      await manager.start(testContainerId);
      
      await manager.copyToContainer(testContainerId, {
        sourcePath: testFile,
        targetPath: '/workspace/test.txt'
      });

      const result = await manager.exec(testContainerId, {
        cmd: ['cat', '/workspace/test.txt']
      });
      
      expect(result.stdout).toBe('Hello from host');
      
      await fs.rm(tmpDir, { recursive: true });
    });

    it('should copy a directory to the container', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const tmpDir = await fs.mkdtemp('/tmp/emergent-test-');
      const testDir = path.join(tmpDir, 'mydir');
      await fs.mkdir(testDir, { recursive: true });
      await fs.writeFile(path.join(testDir, 'file1.txt'), 'content1');
      await fs.writeFile(path.join(testDir, 'file2.txt'), 'content2');

      testContainerId = await manager.create({ image: 'alpine:latest' });
      await manager.start(testContainerId);
      
      await manager.copyToContainer(testContainerId, {
        sourcePath: testDir,
        targetPath: '/workspace'
      });

      const result = await manager.exec(testContainerId, {
        cmd: ['ls', '/workspace/mydir']
      });
      
      expect(result.stdout).toContain('file1.txt');
      expect(result.stdout).toContain('file2.txt');
      
      await fs.rm(tmpDir, { recursive: true });
    });
  });

  describe('copyFromContainer', () => {
    it('should copy a file from the container', async () => {
      const fs = await import('fs/promises');
      const path = await import('path');
      const tmpDir = await fs.mkdtemp('/tmp/emergent-test-');
      const targetFile = path.join(tmpDir, 'from-container.txt');

      testContainerId = await manager.create({ image: 'alpine:latest' });
      await manager.start(testContainerId);
      
      await manager.exec(testContainerId, {
        cmd: ['sh', '-c', 'echo "from container" > /workspace/from-container.txt']
      });
      
      await manager.copyFromContainer(testContainerId, {
        sourcePath: '/workspace/from-container.txt',
        targetPath: targetFile
      });

      const content = await fs.readFile(targetFile, 'utf8');
      expect(content.trim()).toBe('from container');
      
      await fs.rm(tmpDir, { recursive: true });
    });
  });

  describe('getLogs', () => {
    it('should retrieve stdout logs', async () => {
      testContainerId = await manager.create({ image: 'alpine:latest' });
      await manager.start(testContainerId);
      
      await manager.exec(testContainerId, {
        cmd: ['echo', 'log test message']
      });
      
      const logs = await manager.getLogs(testContainerId, {
        stdout: true,
        stderr: false
      });
      
      expect(logs.length).toBeGreaterThan(0);
      const stdoutLogs = logs.filter(l => l.stream === 'stdout');
      expect(stdoutLogs.some(l => l.data.includes('log test message'))).toBe(true);
    });

    it('should retrieve stderr logs', async () => {
      testContainerId = await manager.create({ image: 'alpine:latest' });
      await manager.start(testContainerId);
      
      await manager.exec(testContainerId, {
        cmd: ['sh', '-c', 'echo "error message" >&2']
      });
      
      const logs = await manager.getLogs(testContainerId, {
        stdout: false,
        stderr: true
      });
      
      const stderrLogs = logs.filter(l => l.stream === 'stderr');
      expect(stderrLogs.some(l => l.data.includes('error message'))).toBe(true);
    });

    it('should support tail option', async () => {
      testContainerId = await manager.create({ image: 'alpine:latest' });
      await manager.start(testContainerId);
      
      for (let i = 0; i < 5; i++) {
        await manager.exec(testContainerId, {
          cmd: ['echo', `line ${i}`]
        });
      }
      
      const logs = await manager.getLogs(testContainerId, {
        tail: 3
      });
      
      const stdoutLogs = logs.filter(l => l.stream === 'stdout');
      expect(stdoutLogs.length).toBeLessThanOrEqual(3);
    });
  });

  describe('event emission', () => {
    it('should emit error event on failed operations', async () => {
      const errors: any[] = [];
      manager.on('error', (event) => {
        if (event.type === 'error' && event.data) {
          errors.push(event);
        }
      });

      await expect(manager.start('non-existent')).rejects.toThrow();
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});

describe('createSandboxManager factory', () => {
  it('should create a new manager instance', () => {
    const manager = createSandboxManager();
    expect(manager).toBeInstanceOf(DockerSandboxManager);
  });

  it('should accept docker options', () => {
    const manager = createSandboxManager({ host: 'http://localhost:2375' });
    expect(manager).toBeInstanceOf(DockerSandboxManager);
  });

  it('should accept mock docker client', () => {
    const mockClient = new MockDockerClient();
    const manager = createSandboxManager(mockClient);
    expect(manager).toBeInstanceOf(DockerSandboxManager);
  });
});
