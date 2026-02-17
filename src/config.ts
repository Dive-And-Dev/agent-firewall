export interface Config {
  port: number;
  bind: string;
  bridgeToken: string;
  dataDir: string;
  allowedRoots: string[];
  denyGlobs: string[];
  promptAppend: string;
  maxConcurrent: number;
  turnsMaxCap: number;
  timeoutSecondsCap: number;
  promptAppendMaxBytes: number;
}

export function loadConfig(): Config {
  const bridgeToken = process.env.AF_BRIDGE_TOKEN;
  if (!bridgeToken) {
    throw new Error('AF_BRIDGE_TOKEN is required but not set');
  }

  const allowedRootsRaw = process.env.AF_ALLOWED_ROOTS;
  if (!allowedRootsRaw) {
    throw new Error('AF_ALLOWED_ROOTS is required but not set');
  }

  const allowedRoots = allowedRootsRaw.split(',').map(s => s.trim()).filter(Boolean);
  if (allowedRoots.length === 0) {
    throw new Error('AF_ALLOWED_ROOTS must contain at least one path');
  }

  const denyGlobsRaw = process.env.AF_DENY_GLOBS || '';
  const denyGlobs = denyGlobsRaw.split(',').map(s => s.trim()).filter(Boolean);

  const port = parseInt(process.env.AF_PORT || '8787', 10);
  const maxConcurrent = parseInt(process.env.AF_MAX_CONCURRENT || '1', 10);

  return {
    port: Number.isFinite(port) && port >= 1 && port <= 65535 ? port : 8787,
    bind: process.env.AF_BIND || '127.0.0.1',
    bridgeToken,
    dataDir: process.env.AF_DATA_DIR || './data/sessions',
    allowedRoots,
    denyGlobs,
    promptAppend: process.env.AF_PROMPT_APPEND || '',
    maxConcurrent: Number.isFinite(maxConcurrent) && maxConcurrent >= 1 ? maxConcurrent : 1,
    turnsMaxCap: 50,
    timeoutSecondsCap: 1800,
    promptAppendMaxBytes: 2048,
  };
}
