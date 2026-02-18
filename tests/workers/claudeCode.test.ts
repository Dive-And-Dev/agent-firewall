import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClaudeCodeWorker } from '../../src/workers/claudeCode.js';
import * as execModule from '../../src/utils/exec.js';
import * as filesChangedModule from '../../src/utils/filesChanged.js';
import * as artifactsModule from '../../src/utils/artifacts.js';

vi.mock('../../src/utils/exec.js');
vi.mock('../../src/utils/filesChanged.js');
vi.mock('../../src/utils/artifacts.js');

// Convenience default spawn result
const ok = (stdout = 'Task completed successfully.') => ({
  stdout,
  stderr: '',
  exitCode: 0,
  timedOut: false,
});

// "git diff" result (second spawn call in normal flow)
const gitDiff = () => ({
  stdout: 'diff --git a/src/main.ts b/src/main.ts\n',
  stderr: '',
  exitCode: 0,
  timedOut: false,
});

describe('ClaudeCodeWorker', () => {
  const mockSpawn = vi.mocked(execModule.spawnWithTimeout);
  const mockFilesChanged = vi.mocked(filesChangedModule.detectFilesChanged);
  const mockArtifacts = vi.mocked(artifactsModule.buildArtifactIndex);

  let sessionDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    mockFilesChanged.mockResolvedValue([]);
    mockArtifacts.mockResolvedValue([]);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-worker-'));
    sessionDir = path.join(tmp, 'session');
    workspaceDir = path.join(tmp, 'workspace');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    // Cleanup parent tmp dir
    const parentDir = path.dirname(sessionDir);
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  function run(overrides: {
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    timedOut?: boolean;
    allowedTools?: string[];
  } = {}) {
    const worker = new ClaudeCodeWorker();
    return worker.run(
      'sess-1',
      'Fix the bug',
      'You are an agent...',
      workspaceDir,
      sessionDir,
      overrides.allowedTools ?? [],
      60_000,
      async () => {},
    );
  }

  it('spawns claude -p with --output-format json and returns result', async () => {
    mockSpawn
      .mockResolvedValueOnce(ok())   // claude
      .mockResolvedValueOnce(gitDiff()); // git diff

    const result = await run();

    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
    expect(result.fallback_events).toHaveLength(0);

    // First spawn call should be to claude with -p and --output-format json
    const firstCall = mockSpawn.mock.calls[0];
    expect(firstCall[0]).toBe('claude');
    expect(firstCall[1]).toContain('-p');
    expect(firstCall[1]).toContain('--output-format');
    expect(firstCall[1]).toContain('json');
  });

  it('writes turn/0001 directory structure', async () => {
    mockSpawn
      .mockResolvedValueOnce(ok('some output'))
      .mockResolvedValueOnce(gitDiff());

    await run();

    const turnDir = path.join(sessionDir, 'turns', '0001');
    expect(fs.existsSync(path.join(turnDir, 'request.json'))).toBe(true);
    expect(fs.existsSync(path.join(turnDir, 'stdout.log'))).toBe(true);
    expect(fs.existsSync(path.join(turnDir, 'stderr.log'))).toBe(true);

    const req = JSON.parse(fs.readFileSync(path.join(turnDir, 'request.json'), 'utf-8'));
    expect(req.goal).toBe('Fix the bug');
    expect(req.workspace_root).toBe(workspaceDir);
    expect(req.is_fallback).toBe(false);
  });

  it('writes out/ directory with patch.diff and summary.md', async () => {
    mockSpawn
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(gitDiff());

    await run();

    const outDir = path.join(sessionDir, 'out');
    expect(fs.existsSync(path.join(outDir, 'patch.diff'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'summary.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'artifacts.json'))).toBe(true);

    const summary = fs.readFileSync(path.join(outDir, 'summary.md'), 'utf-8');
    expect(summary).toContain('Fix the bug');
  });

  it('parses JSON output and extracts turns_completed and cost_usd', async () => {
    const jsonOutput = JSON.stringify({
      turn_count: 3,
      cost_usd: 0.0012,
      result: 'Task done',
    });

    mockSpawn
      .mockResolvedValueOnce(ok(jsonOutput))
      .mockResolvedValueOnce(gitDiff());

    const result = await run();

    expect(result.turns_completed).toBe(3);
    expect(result.cost_usd).toBeCloseTo(0.0012);

    // cli_output.json should be written when JSON parsed successfully
    const turnDir = path.join(sessionDir, 'turns', '0001');
    expect(fs.existsSync(path.join(turnDir, 'cli_output.json'))).toBe(true);
  });

  it('falls back gracefully when output is not JSON', async () => {
    mockSpawn
      .mockResolvedValueOnce(ok('Plain text output — not JSON'))
      .mockResolvedValueOnce(gitDiff());

    const result = await run();

    expect(result.turns_completed).toBe(1); // default
    expect(result.cost_usd).toBeNull();
    expect(result.exit_code).toBe(0);

    // cli_output.json should NOT be written for plain text
    const turnDir = path.join(sessionDir, 'turns', '0001');
    expect(fs.existsSync(path.join(turnDir, 'cli_output.json'))).toBe(false);
  });

  it('records --allowedTools fallback event when CLI specifically rejects that flag', async () => {
    const unknownFlagResult = {
      stdout: '',
      stderr: 'unknown option --allowedTools: not recognized',
      exitCode: 1,
      timedOut: false,
    };

    mockSpawn
      .mockResolvedValueOnce(unknownFlagResult) // first attempt with --allowedTools fails
      .mockResolvedValueOnce(ok())              // retry without --allowedTools succeeds
      .mockResolvedValueOnce(gitDiff());         // git diff

    const result = await run({ allowedTools: ['Bash', 'Read'] });

    expect(result.fallback_events).toHaveLength(1);
    expect(result.fallback_events[0].attempted_flag).toBe('--allowedTools');
    expect(result.fallback_events[0].reason).toContain('allowedTools');
    expect(result.fallback_events[0].fallback_action).toContain('retry without');

    // request.json should mark is_fallback: true
    const req = JSON.parse(
      fs.readFileSync(path.join(sessionDir, 'turns', '0001', 'request.json'), 'utf-8'),
    );
    expect(req.is_fallback).toBe(true);
  });

  it('records --output-format fallback and preserves allowedTools in plain retry', async () => {
    // --output-format fails but stderr does NOT mention allowedTools
    const outputFormatFail = {
      stdout: '',
      stderr: 'unknown option --output-format',
      exitCode: 1,
      timedOut: false,
    };

    mockSpawn
      .mockResolvedValueOnce(outputFormatFail) // JSON mode fails
      .mockResolvedValueOnce(ok('plain result')) // plain --print WITH allowedTools succeeds
      .mockResolvedValueOnce(gitDiff());

    const result = await run({ allowedTools: ['Bash'] });

    // Only one fallback event: --output-format
    expect(result.fallback_events).toHaveLength(1);
    expect(result.fallback_events[0].attempted_flag).toBe('--output-format');

    // The plain retry must include --allowedTools (tools were not rejected, just JSON mode was)
    const plainRetryCall = mockSpawn.mock.calls[1];
    expect(plainRetryCall[0]).toBe('claude');
    expect(plainRetryCall[1]).toContain('--allowedTools');
  });

  it('redacts secrets from output', async () => {
    mockSpawn
      .mockResolvedValueOnce(ok('Found key sk-ant-abc123def456ghi789'))
      .mockResolvedValueOnce(gitDiff());

    const result = await run();

    expect(result.raw_output).toContain('sk-ant-abc123def456ghi789');
    expect(result.redacted_output).toContain('sk-ant-***REDACTED***');
    expect(result.redacted_output).not.toContain('abc123def456ghi789');

    // stdout.log is unredacted (audit trail)
    const stdoutLog = fs.readFileSync(
      path.join(sessionDir, 'turns', '0001', 'stdout.log'),
      'utf-8',
    );
    expect(stdoutLog).toContain('sk-ant-abc123def456ghi789');
  });

  it('extracts blockers from output', async () => {
    mockSpawn
      .mockResolvedValueOnce(ok('Error in src/main.ts:42 something broke'))
      .mockResolvedValueOnce(gitDiff());

    const result = await run();

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].file).toBe('src/main.ts');
    expect(result.blockers[0].line_range).toBe('42');
  });

  it('detects files changed and builds artifact index', async () => {
    mockSpawn
      .mockResolvedValueOnce(ok('Done'))
      .mockResolvedValueOnce(gitDiff());

    mockFilesChanged.mockResolvedValue(['src/app.ts', 'README.md']);
    mockArtifacts.mockResolvedValue([
      { name: 'output.log', path: '/tmp/artifacts/output.log', bytes: 100, sha256: 'abc123' },
    ]);

    const result = await run();

    expect(result.files_changed).toEqual(['src/app.ts', 'README.md']);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].name).toBe('output.log');
  });

  it('handles timeout correctly', async () => {
    mockSpawn
      .mockResolvedValueOnce({
        stdout: 'partial output',
        stderr: 'killed',
        exitCode: null,
        timedOut: true,
      })
      .mockResolvedValueOnce(gitDiff());

    const result = await run();

    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBeNull();
  });

  it('passes allowedTools to CLI args when provided', async () => {
    mockSpawn
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(gitDiff());

    await run({ allowedTools: ['Bash', 'Read', 'Write'] });

    const firstCall = mockSpawn.mock.calls[0];
    expect(firstCall[0]).toBe('claude');
    expect(firstCall[1]).toContain('--allowedTools');
    const toolsArg = firstCall[1][firstCall[1].indexOf('--allowedTools') + 1];
    expect(toolsArg).toContain('Bash');
    expect(toolsArg).toContain('Read');
  });

  it('writes test_report.md when test output detected', async () => {
    const testOutput = 'PASS src/auth.test.ts\n✓ returns 200 OK\nTests: 5 passed';

    mockSpawn
      .mockResolvedValueOnce(ok(testOutput))
      .mockResolvedValueOnce(gitDiff());

    await run();

    const outDir = path.join(sessionDir, 'out');
    expect(fs.existsSync(path.join(outDir, 'test_report.md'))).toBe(true);

    const report = fs.readFileSync(path.join(outDir, 'test_report.md'), 'utf-8');
    expect(report).toContain('PASS');
  });
});
