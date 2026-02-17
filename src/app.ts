import express from 'express';
import * as fs from 'node:fs';
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
    // Validate input
    const validation = validateTaskInput(req.body, config);
    if (!validation.valid) {
      res.status(400).json({ error: 'Invalid task input', errors: validation.errors });
      return;
    }

    const sanitized = validation.sanitized!;

    // Check workspace_root against pathGuard
    const pathCheck = validatePath(sanitized.workspace_root, config.allowedRoots, config.denyGlobs);
    if (!pathCheck.allowed) {
      res.status(400).json({ error: 'workspace_root denied', reason: pathCheck.reason });
      return;
    }

    // Build prompt before acquiring gate — buildPrompt can throw and must not hold the lock
    const constraints = sanitized.allowed_tools.length > 0
      ? `ALLOWED_TOOLS: ${sanitized.allowed_tools.join(', ')}`
      : '';

    const { prompt, templateHash } = buildPrompt(
      { goal: sanitized.goal, workspace: sanitized.workspace_root, constraints },
      config.promptAppend,
    );

    // Try to acquire concurrency slot (after all synchronous validation)
    const sessionId = uuidv4();
    if (!gate.acquire(sanitized.workspace_root, sessionId)) {
      res.status(503).json({
        error: 'Server busy',
        active_session: gate.activeSessionId(),
      });
      return;
    }

    // Create session record — release gate on any setup failure
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

    // Return 202 immediately
    res.status(202).json({ session_id: sessionId });

    // Run worker in background (fire-and-forget)
    const ac = new AbortController();
    abortControllers.set(sessionId, ac);

    // Fire-and-forget: suppress unhandled rejections — runWorker handles all errors internally
    runWorker(sessionId, sanitized, prompt, worker, store, gate, ac, abortControllers).catch(() => {});
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
      // Signal the worker to stop. runWorker's finally block releases the gate
      // when the worker actually exits — we must NOT release it here to avoid
      // a race where a new session starts before the old worker terminates.
      ac.abort();
    }

    // Mark as aborted immediately so callers can see the state
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

    // Resolve file path relative to the session's workspace
    const resolved = path.resolve(task.workspace_root, filePath);

    // PathGuard: scope to session's workspace_root (not global allowedRoots)
    const pathCheck = validatePath(resolved, [task.workspace_root], config.denyGlobs);
    if (!pathCheck.allowed) {
      res.status(403).json({ error: 'Path access denied', reason: pathCheck.reason });
      return;
    }

    try {
      const content = fs.readFileSync(pathCheck.resolved!, 'utf-8');
      const lineStart = parseInt(req.query.line_start as string) || 1;
      const lineEnd = parseInt(req.query.line_end as string) || 0;

      const lines = content.split('\n');
      const start = Math.max(1, lineStart) - 1;
      const end = lineEnd > 0 ? Math.min(lineEnd, lines.length) : lines.length;
      const excerpt = lines.slice(start, end).join('\n');

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

    // Allowlist check: only serve artifacts recorded in session state
    if (!state.artifacts.includes(req.params.name)) {
      res.status(404).json({ error: 'Artifact not found' });
      return;
    }

    // getArtifactPath validates the name and prevents traversal
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

  // --- GET /v1/health ---
  app.get('/v1/health', (_req, res) => {
    res.json({
      status: 'ok',
      active_session: gate.activeSessionId(),
    });
  });

  return app;
}

async function runWorker(
  sessionId: string,
  sanitized: { goal: string; workspace_root: string; turns_max: number; timeout_seconds: number },
  prompt: string,
  worker: Worker,
  store: FileSessionStore,
  gate: GlobalConcurrencyGate,
  ac: AbortController,
  abortControllers: Map<string, AbortController>,
): Promise<void> {
  try {
    const result = await worker.run(
      sessionId,
      sanitized.goal,
      prompt,
      sanitized.workspace_root,
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
      artifacts: result.artifacts.map(a => a.name),
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
