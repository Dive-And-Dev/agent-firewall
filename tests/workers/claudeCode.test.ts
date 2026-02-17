import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeCodeWorker } from '../../src/workers/claudeCode.js';
import * as execModule from '../../src/utils/exec.js';
import * as filesChangedModule from '../../src/utils/filesChanged.js';
import * as artifactsModule from '../../src/utils/artifacts.js';

vi.mock('../../src/utils/exec.js');
vi.mock('../../src/utils/filesChanged.js');
vi.mock('../../src/utils/artifacts.js');

describe('ClaudeCodeWorker', () => {
  const mockSpawn = vi.mocked(execModule.spawnWithTimeout);
  const mockFilesChanged = vi.mocked(filesChangedModule.detectFilesChanged);
  const mockArtifacts = vi.mocked(artifactsModule.buildArtifactIndex);

  beforeEach(() => {
    vi.resetAllMocks();
    mockFilesChanged.mockResolvedValue([]);
    mockArtifacts.mockResolvedValue([]);
  });

  it('spawns claude --print with prompt and returns result', async () => {
    mockSpawn.mockResolvedValue({
      stdout: 'Task completed successfully.',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });

    const worker = new ClaudeCodeWorker();
    const result = await worker.run(
      'sess-1', 'Fix the bug', 'You are an agent...', '/tmp/proj',
      60_000, async () => {},
    );

    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
    expect(result.raw_output).toBe('Task completed successfully.');
    expect(result.redacted_output).toBe('Task completed successfully.');

    // Verify spawn was called correctly
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--print']),
      expect.objectContaining({
        timeoutMs: 60_000,
        cwd: '/tmp/proj',
      }),
    );
  });

  it('redacts secrets from output', async () => {
    mockSpawn.mockResolvedValue({
      stdout: 'Found key sk-ant-abc123def456ghi789',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });

    const worker = new ClaudeCodeWorker();
    const result = await worker.run(
      'sess-1', 'Check keys', 'prompt', '/tmp/proj',
      60_000, async () => {},
    );

    expect(result.raw_output).toContain('sk-ant-abc123def456ghi789');
    expect(result.redacted_output).toContain('sk-ant-***REDACTED***');
    expect(result.redacted_output).not.toContain('abc123def456ghi789');
  });

  it('extracts blockers from output', async () => {
    mockSpawn.mockResolvedValue({
      stdout: 'Error in src/main.ts:42 something broke',
      stderr: '',
      exitCode: 1,
      timedOut: false,
    });

    const worker = new ClaudeCodeWorker();
    const result = await worker.run(
      'sess-1', 'Build', 'prompt', '/tmp/proj',
      60_000, async () => {},
    );

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].file).toBe('src/main.ts');
    expect(result.blockers[0].line_range).toBe('42');
  });

  it('detects files changed and builds artifacts', async () => {
    mockSpawn.mockResolvedValue({
      stdout: 'Done',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });
    mockFilesChanged.mockResolvedValue(['src/app.ts', 'README.md']);
    mockArtifacts.mockResolvedValue([
      { name: 'output.log', path: '/tmp/artifacts/output.log', bytes: 100, sha256: 'abc123' },
    ]);

    const worker = new ClaudeCodeWorker();
    const result = await worker.run(
      'sess-1', 'Refactor', 'prompt', '/tmp/proj',
      60_000, async () => {},
    );

    expect(result.files_changed).toEqual(['src/app.ts', 'README.md']);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].name).toBe('output.log');
  });

  it('handles timeout correctly', async () => {
    mockSpawn.mockResolvedValue({
      stdout: 'partial output',
      stderr: 'killed',
      exitCode: null,
      timedOut: true,
    });

    const worker = new ClaudeCodeWorker();
    const result = await worker.run(
      'sess-1', 'Long task', 'prompt', '/tmp/proj',
      1000, async () => {},
    );

    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBeNull();
  });
});
