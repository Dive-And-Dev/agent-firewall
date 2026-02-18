import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Worker, WorkerResult } from '../src/workers/types.js';
import type { SharedState } from '../src/sessions/types.js';

// Stub worker that resolves immediately and exposes a completion promise
class StubWorker implements Worker {
  lastPrompt = '';
  result: Partial<WorkerResult> = {};

  // Resolves when the worker run() completes — lets tests await actual completion
  readonly done: Promise<void>;
  private _resolveDone!: () => void;

  constructor() {
    this.done = new Promise<void>(r => { this._resolveDone = r; });
  }

  async run(
    _sessionId: string,
    _goal: string,
    prompt: string,
    _workspaceRoot: string,
    _sessionDir: string,
    _allowedTools: string[],
    _timeoutMs: number,
    onProgress: (patch: Partial<SharedState>) => Promise<void>,
  ): Promise<WorkerResult> {
    this.lastPrompt = prompt;
    await onProgress({ turns_completed: 1 });
    this._resolveDone();
    return {
      raw_output: 'raw output',
      redacted_output: 'redacted output',
      exit_code: 0,
      timed_out: false,
      turns_completed: 1,
      cost_usd: null,
      blockers: [],
      files_changed: ['src/index.ts'],
      artifacts: [],
      fallback_events: [],
      ...this.result,
    };
  }
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8787,
    bind: '127.0.0.1',
    bridgeToken: 'test-token',
    dataDir: '',
    allowedRoots: ['/tmp'],
    denyGlobs: ['**/.env', '**/.ssh/**'],
    promptAppend: '',
    maxConcurrent: 1,
    turnsMaxCap: 50,
    timeoutSecondsCap: 1800,
    promptAppendMaxBytes: 2048,
    logtailMaxLines: 200,
    ...overrides,
  };
}

describe('routes', () => {
  let tmpDir: string;
  let worker: StubWorker;
  let config: Config;
  const TOKEN = 'test-token';
  const AUTH = `Bearer ${TOKEN}`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-routes-'));
    worker = new StubWorker();
    config = makeConfig({ dataDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function app() {
    return createApp(config, worker);
  }

  // --- Auth ---

  it('returns 401 without auth header', async () => {
    const res = await request(app()).post('/v1/tasks').send({});
    expect(res.status).toBe(401);
  });

  // --- POST /v1/tasks ---

  it('POST /v1/tasks returns 202 with session_id', async () => {
    const workspace = path.join(tmpDir, 'project');
    fs.mkdirSync(workspace, { recursive: true });
    config.allowedRoots = [tmpDir];

    const appInstance = app();
    const res = await request(appInstance)
      .post('/v1/tasks')
      .set('Authorization', AUTH)
      .send({ goal: 'Fix the bug', workspace_root: workspace });

    expect(res.status).toBe(202);
    expect(res.body.session_id).toBeTruthy();
    expect(typeof res.body.session_id).toBe('string');

    await worker.done;
  });

  it('POST /v1/tasks rejects missing goal', async () => {
    const res = await request(app())
      .post('/v1/tasks')
      .set('Authorization', AUTH)
      .send({ workspace_root: '/tmp/proj' });

    expect(res.status).toBe(400);
    expect(res.body.errors).toContain('goal is required');
  });

  it('POST /v1/tasks rejects workspace outside allowed roots', async () => {
    config.allowedRoots = ['/tmp/allowed-only'];

    const res = await request(app())
      .post('/v1/tasks')
      .set('Authorization', AUTH)
      .send({ goal: 'Fix', workspace_root: '/home/evil' });

    expect(res.status).toBe(400);
  });

  it('POST /v1/tasks returns 503 when slot is busy', async () => {
    const workspace = path.join(tmpDir, 'proj');
    fs.mkdirSync(workspace, { recursive: true });
    config.allowedRoots = [tmpDir];

    let releaseWorker: () => void;
    const workerBlockedP = new Promise<void>(r => { releaseWorker = r; });

    const hangingWorker: Worker = {
      async run(_sid, _goal, _prompt, _ws, _sessionDir, _allowedTools, _timeout, _onProgress) {
        await workerBlockedP;
        return {
          raw_output: '', redacted_output: '', exit_code: 0,
          timed_out: false, turns_completed: 0, cost_usd: null,
          blockers: [], files_changed: [], artifacts: [], fallback_events: [],
        };
      },
    };
    const hangApp = createApp(config, hangingWorker);

    const res1 = await request(hangApp)
      .post('/v1/tasks')
      .set('Authorization', AUTH)
      .send({ goal: 'First', workspace_root: workspace });

    expect(res1.status).toBe(202);

    const res2 = await request(hangApp)
      .post('/v1/tasks')
      .set('Authorization', AUTH)
      .send({ goal: 'Second', workspace_root: workspace });

    expect(res2.status).toBe(503);

    releaseWorker!();
    await new Promise(r => setTimeout(r, 20));
  });

  // --- GET /v1/sessions ---

  it('GET /v1/sessions returns session list', async () => {
    const workspace = path.join(tmpDir, 'proj');
    fs.mkdirSync(workspace, { recursive: true });
    config.allowedRoots = [tmpDir];

    const appInstance = app();

    await request(appInstance)
      .post('/v1/tasks')
      .set('Authorization', AUTH)
      .send({ goal: 'Test', workspace_root: workspace });

    await worker.done;

    const res = await request(appInstance)
      .get('/v1/sessions')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  // --- GET /v1/sessions/:id/state ---

  it('GET /v1/sessions/:id/state returns 404 for unknown session', async () => {
    const res = await request(app())
      .get('/v1/sessions/nonexistent/state')
      .set('Authorization', AUTH);

    expect(res.status).toBe(404);
  });

  it('GET /v1/sessions/:id/state returns state for valid session', async () => {
    const workspace = path.join(tmpDir, 'proj');
    fs.mkdirSync(workspace, { recursive: true });
    config.allowedRoots = [tmpDir];

    const appInstance = app();

    const createRes = await request(appInstance)
      .post('/v1/tasks')
      .set('Authorization', AUTH)
      .send({ goal: 'Test state', workspace_root: workspace });

    const sessionId = createRes.body.session_id;

    await worker.done;

    const res = await request(appInstance)
      .get(`/v1/sessions/${sessionId}/state`)
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.goal).toBe('Test state');
    // artifacts is now ArtifactEntry[] not string[]
    expect(Array.isArray(res.body.artifacts)).toBe(true);
  });

  // --- POST /v1/sessions/:id/abort ---

  it('POST /v1/sessions/:id/abort returns 404 for unknown session', async () => {
    const res = await request(app())
      .post('/v1/sessions/nonexistent/abort')
      .set('Authorization', AUTH);

    expect(res.status).toBe(404);
  });

  // --- GET /v1/sessions/:id/excerpt ---

  it('GET /v1/sessions/:id/excerpt validates path param', async () => {
    const res = await request(app())
      .get('/v1/sessions/nonexistent/excerpt')
      .query({ path: '/etc/passwd' })
      .set('Authorization', AUTH);

    expect(res.status).toBe(404);
  });

  it('GET /v1/sessions/:id/excerpt supports start/end aliases', async () => {
    const workspace = path.join(tmpDir, 'proj');
    fs.mkdirSync(workspace, { recursive: true });
    config.allowedRoots = [tmpDir];

    const testFile = path.join(workspace, 'test.txt');
    fs.writeFileSync(testFile, 'line1\nline2\nline3\nline4\nline5\n');

    const appInstance = app();
    const createRes = await request(appInstance)
      .post('/v1/tasks')
      .set('Authorization', AUTH)
      .send({ goal: 'Test', workspace_root: workspace });

    await worker.done;
    const sessionId = createRes.body.session_id;

    // Use start/end aliases (spec-compatible)
    const res = await request(appInstance)
      .get(`/v1/sessions/${sessionId}/excerpt`)
      .query({ path: 'test.txt', start: 2, end: 3 })
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('line2\nline3');
    expect(res.body.line_start).toBe(2);
    expect(res.body.line_end).toBe(3);
  });

  it('GET /v1/sessions/:id/excerpt respects max_chars', async () => {
    const workspace = path.join(tmpDir, 'proj');
    fs.mkdirSync(workspace, { recursive: true });
    config.allowedRoots = [tmpDir];

    const testFile = path.join(workspace, 'test.txt');
    fs.writeFileSync(testFile, 'abcdefghij\nklmnopqrst\n');

    const appInstance = app();
    const createRes = await request(appInstance)
      .post('/v1/tasks')
      .set('Authorization', AUTH)
      .send({ goal: 'Test', workspace_root: workspace });

    await worker.done;
    const sessionId = createRes.body.session_id;

    const res = await request(appInstance)
      .get(`/v1/sessions/${sessionId}/excerpt`)
      .query({ path: 'test.txt', max_chars: 5 })
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.content.length).toBeLessThanOrEqual(5);
  });

  // --- GET /v1/sessions/:id/artifacts ---

  it('GET /v1/sessions/:id/artifacts returns 404 for unknown session', async () => {
    const res = await request(app())
      .get('/v1/sessions/nonexistent/artifacts')
      .set('Authorization', AUTH);

    expect(res.status).toBe(404);
  });

  it('GET /v1/sessions/:id/artifacts returns metadata array', async () => {
    const workspace = path.join(tmpDir, 'proj');
    fs.mkdirSync(workspace, { recursive: true });
    config.allowedRoots = [tmpDir];

    const appInstance = app();
    const createRes = await request(appInstance)
      .post('/v1/tasks')
      .set('Authorization', AUTH)
      .send({ goal: 'Test', workspace_root: workspace });

    await worker.done;
    const sessionId = createRes.body.session_id;

    const res = await request(appInstance)
      .get(`/v1/sessions/${sessionId}/artifacts`)
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.artifacts)).toBe(true);
    // Each entry is an ArtifactEntry object (not a plain string)
    for (const a of res.body.artifacts) {
      expect(typeof a).toBe('object');
    }
  });

  // --- GET /v1/sessions/:id/artifacts/:name ---

  it('GET /v1/sessions/:id/artifacts/:name returns 404 for unknown session', async () => {
    const res = await request(app())
      .get('/v1/sessions/nonexistent/artifacts/patch.diff')
      .set('Authorization', AUTH);

    expect(res.status).toBe(404);
  });

  // --- GET /v1/sessions/:id/logtail ---

  it('GET /v1/sessions/:id/logtail returns 404 for unknown session', async () => {
    const res = await request(app())
      .get('/v1/sessions/nonexistent/logtail')
      .set('Authorization', AUTH);

    expect(res.status).toBe(404);
  });

  it('GET /v1/sessions/:id/logtail returns 400 for invalid stream', async () => {
    const workspace = path.join(tmpDir, 'proj');
    fs.mkdirSync(workspace, { recursive: true });
    config.allowedRoots = [tmpDir];

    const appInstance = app();
    const createRes = await request(appInstance)
      .post('/v1/tasks')
      .set('Authorization', AUTH)
      .send({ goal: 'Test', workspace_root: workspace });

    await worker.done;
    const sessionId = createRes.body.session_id;

    const res = await request(appInstance)
      .get(`/v1/sessions/${sessionId}/logtail`)
      .query({ stream: 'invalid' })
      .set('Authorization', AUTH);

    expect(res.status).toBe(400);
  });

  it('GET /v1/sessions/:id/logtail returns empty lines when no turn logs exist', async () => {
    const workspace = path.join(tmpDir, 'proj');
    fs.mkdirSync(workspace, { recursive: true });
    config.allowedRoots = [tmpDir];

    const appInstance = app();
    const createRes = await request(appInstance)
      .post('/v1/tasks')
      .set('Authorization', AUTH)
      .send({ goal: 'Test', workspace_root: workspace });

    await worker.done;
    const sessionId = createRes.body.session_id;

    // StubWorker doesn't write turn logs, so logtail returns empty
    const res = await request(appInstance)
      .get(`/v1/sessions/${sessionId}/logtail`)
      .query({ stream: 'stdout', n: 10 })
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.lines)).toBe(true);
    expect(res.body.stream).toBe('stdout');
    expect(res.body.n).toBe(10);
  });

  it('GET /v1/sessions/:id/logtail reads turn logs and applies grep', async () => {
    const workspace = path.join(tmpDir, 'proj');
    fs.mkdirSync(workspace, { recursive: true });
    config.allowedRoots = [tmpDir];

    const appInstance = app();
    const createRes = await request(appInstance)
      .post('/v1/tasks')
      .set('Authorization', AUTH)
      .send({ goal: 'Test', workspace_root: workspace });

    await worker.done;
    const sessionId = createRes.body.session_id;

    // Write a fake stdout.log directly so we can test reading
    const turnDir = path.join(tmpDir, sessionId, 'turns', '0001');
    fs.mkdirSync(turnDir, { recursive: true });
    fs.writeFileSync(path.join(turnDir, 'stdout.log'), 'hello world\nerror here\nanother line\n');

    const res = await request(appInstance)
      .get(`/v1/sessions/${sessionId}/logtail`)
      .query({ stream: 'stdout', n: 50, grep: 'error' })
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual(['error here']);
  });

  it('GET /v1/sessions/:id/logtail caps n at logtailMaxLines', async () => {
    config.logtailMaxLines = 5;
    const workspace = path.join(tmpDir, 'proj');
    fs.mkdirSync(workspace, { recursive: true });
    config.allowedRoots = [tmpDir];

    const appInstance = app();
    const createRes = await request(appInstance)
      .post('/v1/tasks')
      .set('Authorization', AUTH)
      .send({ goal: 'Test', workspace_root: workspace });

    await worker.done;
    const sessionId = createRes.body.session_id;

    const res = await request(appInstance)
      .get(`/v1/sessions/${sessionId}/logtail`)
      .query({ stream: 'stdout', n: 9999 })
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.n).toBe(5);
  });

  // --- GET /v1/health ---

  it('GET /v1/health returns 200 with status', async () => {
    const res = await request(app())
      .get('/v1/health')
      .set('Authorization', AUTH);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
