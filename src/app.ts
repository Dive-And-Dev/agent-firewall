import express from 'express';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { Config } from './config.js';
import type { Worker } from './workers/types.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { FileSessionStore } from './sessions/sessionStore.js';
import { GlobalConcurrencyGate } from './workers/concurrencyGate.js';
import { validateTaskInput } from './security/policy.js';
import { validatePath } from './security/pathGuard.js';
import { buildPrompt } from './security/promptTemplate.js';
import { redact } from './security/redaction.js';

export function createApp(config: Config, worker: Worker) {
  const app = express();
  const store = new FileSessionStore(config.dataDir);
  const gate = new GlobalConcurrencyGate();

  // Track active abort controllers for running sessions
  const abortControllers = new Map<string, AbortController>();

  app.use(express.json());
  app.use(createAuthMiddleware(config.bridgeToken));

  // --- POST /v1/tasks ---
  app.post('/v1/tasks', async (req, res) => {
    const validation = validateTaskInput(req.body, config);
    if (!validation.valid) {
      res.status(400).json({ error: 'Invalid task input', errors: validation.errors });
      return;
    }

    const sanitized = validation.sanitized!;

    const pathCheck = validatePath(sanitized.workspace_root, config.allowedRoots, config.denyGlobs);
    if (!pathCheck.allowed) {
      res.status(400).json({ error: 'workspace_root denied', reason: pathCheck.reason });
      return;
    }

    // Build prompt before acquiring gate — buildPrompt can throw
    const constraints = sanitized.allowed_tools.length > 0
      ? `ALLOWED_TOOLS: ${sanitized.allowed_tools.join(', ')}`
      : '';

    const { prompt, templateHash } = buildPrompt(
      { goal: sanitized.goal, workspace: sanitized.workspace_root, constraints },
      config.promptAppend,
    );

    const sessionId = uuidv4();
    if (!gate.acquire(sanitized.workspace_root, sessionId)) {
      res.status(503).json({
        error: 'Server busy',
        active_session: gate.activeSessionId(),
      });
      return;
    }

    try {
      await store.create(sessionId, {
        session_id: sessionId,
        goal: sanitized.goal,
        workspace_root: sanitized.workspace_root,
        allowed_tools: sanitized.allowed_tools,
        turns_max: sanitized.turns_max,
        timeout_seconds: sanitized.timeout_seconds,
        created_at: new Date().toISOString(),
        template_hash: templateHash,
      });
    } catch (err) {
      gate.release(sanitized.workspace_root, sessionId);
      throw err;
    }

    res.status(202).json({ session_id: sessionId });

    const ac = new AbortController();
    abortControllers.set(sessionId, ac);
    runWorker(sessionId, sanitized, prompt, config, worker, store, gate, ac, abortControllers).catch(() => {});
  });

  // --- GET /v1/sessions ---
  app.get('/v1/sessions', async (_req, res) => {
    const sessions = await store.listSessions();
    res.json(sessions);
  });

  // --- GET /v1/sessions/:id/state ---
  app.get('/v1/sessions/:id/state', async (req, res) => {
    const state = await store.getState(req.params.id);
    if (!state) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(state);
  });

  // --- POST /v1/sessions/:id/abort ---
  app.post('/v1/sessions/:id/abort', async (req, res) => {
    const state = await store.getState(req.params.id);
    if (!state) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (state.status !== 'running') {
      res.status(409).json({ error: 'Session is not running', status: state.status });
      return;
    }

    const ac = abortControllers.get(req.params.id);
    if (ac) {
      // Signal the worker; runWorker's finally block releases the gate
      ac.abort();
    }

    await store.updateState(req.params.id, {
      status: 'aborted',
      error_summary: 'Aborted by client request',
    });

    res.json({ status: 'aborted' });
  });

  // --- GET /v1/sessions/:id/excerpt ---
  app.get('/v1/sessions/:id/excerpt', async (req, res) => {
    const task = await store.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }

    const resolved = path.resolve(task.workspace_root, filePath);
    const pathCheck = validatePath(resolved, [task.workspace_root], config.denyGlobs);
    if (!pathCheck.allowed) {
      res.status(403).json({ error: 'Path access denied', reason: pathCheck.reason });
      return;
    }

    try {
      const content = await fsp.readFile(pathCheck.resolved!, 'utf-8');

      // Support both line_start/line_end (original) and start/end (spec alias)
      const lineStart = parseInt(
        ((req.query.line_start ?? req.query.start) as string) || '1'
      ) || 1;
      const lineEnd = parseInt(
        ((req.query.line_end ?? req.query.end) as string) || '0'
      ) || 0;
      const maxChars = parseInt((req.query.max_chars as string) || '0') || 0;

      const lines = content.split('\n');
      const start = Math.max(1, lineStart) - 1;
      const end = lineEnd > 0 ? Math.min(lineEnd, lines.length) : lines.length;
      let excerpt = lines.slice(start, end).join('\n');
      if (maxChars > 0 && excerpt.length > maxChars) {
        excerpt = excerpt.slice(0, maxChars);
      }

      res.json({ path: filePath, line_start: start + 1, line_end: end, content: redact(excerpt) });
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      throw err;
    }
  });

  // --- GET /v1/sessions/:id/artifacts ---
  app.get('/v1/sessions/:id/artifacts', async (req, res) => {
    const state = await store.getState(req.params.id);
    if (!state) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    // Return full ArtifactEntry metadata (name, path, bytes, sha256)
    res.json({ artifacts: state.artifacts });
  });

  // --- GET /v1/sessions/:id/artifacts/:name ---
  app.get('/v1/sessions/:id/artifacts/:name', async (req, res) => {
    const [state, task] = await Promise.all([
      store.getState(req.params.id),
      store.getTask(req.params.id),
    ]);
    if (!state || !task) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Allowlist check: only serve artifacts recorded in session state.
    // Handle both ArtifactEntry[] (current format) and legacy string[] (pre-migration sessions).
    const name = req.params.name;
    const allowed = state.artifacts.some(
      a => (typeof a === 'string' ? a : (a as { name: string }).name) === name,
    );
    if (!allowed) {
      res.status(404).json({ error: 'Artifact not found' });
      return;
    }

    const artifactPath = await store.getArtifactPath(
      req.params.id,
      req.params.name,
      task.workspace_root,
    );
    if (!artifactPath) {
      res.status(404).json({ error: 'Artifact not found' });
      return;
    }

    res.sendFile(artifactPath);
  });

  // --- GET /v1/sessions/:id/logtail ---
  app.get('/v1/sessions/:id/logtail', async (req, res) => {
    const state = await store.getState(req.params.id);
    if (!state) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const stream = (req.query.stream as string) || 'stdout';
    if (stream !== 'stdout' && stream !== 'stderr') {
      res.status(400).json({ error: 'stream must be stdout or stderr' });
      return;
    }

    const nRaw = parseInt((req.query.n as string) || '50') || 50;
    const n = Math.min(Math.max(1, nRaw), config.logtailMaxLines);
    const grep = (req.query.grep as string) || '';

    const sessionDir = path.join(config.dataDir, req.params.id);
    const logFile = await findLatestTurnLog(sessionDir, stream);

    if (!logFile) {
      res.json({ lines: [], stream, n });
      return;
    }

    try {
      let lines = await tailLines(logFile, n);
      if (grep) lines = lines.filter(l => l.includes(grep));
      res.json({ lines: lines.map(l => redact(l)), stream, n });
    } catch {
      res.json({ lines: [], stream, n });
    }
  });

  // --- GET /v1/health ---
  app.get('/v1/health', (_req, res) => {
    res.json({
      status: 'ok',
      active_session: gate.activeSessionId(),
    });
  });

  return app;
}

// Read the last `maxLines` lines from a file without loading the entire contents.
// Estimates ~512 bytes per line, which comfortably covers typical log lines.
async function tailLines(filePath: string, maxLines: number): Promise<string[]> {
  const BYTES_PER_LINE = 512;
  const stat = await fsp.stat(filePath);
  if (stat.size === 0) return [];

  const readBytes = Math.min(stat.size, maxLines * BYTES_PER_LINE + 512);
  const offset = stat.size - readBytes;

  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(readBytes);
    const { bytesRead } = await fh.read(buf, 0, readBytes, offset);
    let lines = buf.slice(0, bytesRead).toString('utf-8').split('\n');
    // Drop the first entry when starting mid-file — it may be a partial line
    if (offset > 0 && lines.length > 0) lines = lines.slice(1);
    return lines.filter(l => l.length > 0).slice(-maxLines);
  } finally {
    await fh.close();
  }
}

async function findLatestTurnLog(sessionDir: string, stream: string): Promise<string | null> {
  const turnsDir = path.join(sessionDir, 'turns');
  try {
    const entries = await fsp.readdir(turnsDir);
    entries.sort();
    const latest = entries[entries.length - 1];
    if (!latest) return null;
    const logFile = path.join(turnsDir, latest, `${stream}.log`);
    await fsp.access(logFile);
    return logFile;
  } catch {
    return null;
  }
}

async function runWorker(
  sessionId: string,
  sanitized: {
    goal: string;
    workspace_root: string;
    turns_max: number;
    timeout_seconds: number;
    allowed_tools: string[];
  },
  prompt: string,
  config: Config,
  worker: Worker,
  store: FileSessionStore,
  gate: GlobalConcurrencyGate,
  ac: AbortController,
  abortControllers: Map<string, AbortController>,
): Promise<void> {
  const sessionDir = path.join(config.dataDir, sessionId);
  try {
    const result = await worker.run(
      sessionId,
      sanitized.goal,
      prompt,
      sanitized.workspace_root,
      sessionDir,
      sanitized.allowed_tools,
      sanitized.timeout_seconds * 1000,
      async (patch) => {
        if (ac.signal.aborted) return;
        await store.updateState(sessionId, patch);
      },
    );

    if (ac.signal.aborted) return;

    const status = result.timed_out ? 'failed' : result.exit_code === 0 ? 'done' : 'failed';
    const errorSummary = result.timed_out
      ? 'Worker timed out'
      : result.exit_code !== 0
        ? `Worker exited with code ${result.exit_code}`
        : null;

    await store.updateState(sessionId, {
      status,
      files_changed: result.files_changed,
      artifacts: result.artifacts,
      fallback_events: result.fallback_events,
      cost_usd: result.cost_usd,
      blockers: result.blockers,
      error_summary: errorSummary,
    });
  } catch (err: any) {
    if (!ac.signal.aborted) {
      await store.updateState(sessionId, {
        status: 'failed',
        error_summary: `Worker error: ${err.message}`,
      });
    }
  } finally {
    gate.release(sanitized.workspace_root, sessionId);
    abortControllers.delete(sessionId);
  }
}
