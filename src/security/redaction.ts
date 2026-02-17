// Pass 1: Block-level patterns (PEM keys, certs)
const BLOCK_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '<REDACTED_PRIVATE_KEY_BLOCK>',
  },
  {
    pattern: /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    replacement: '<REDACTED_CERT_BLOCK>',
  },
];

// Pass 2: Token-level patterns (API keys, JWTs)
const TOKEN_PATTERNS: Array<{ pattern: RegExp; replacer: (match: string) => string }> = [
  // JWT (must be before generic Bearer)
  { pattern: /eyJ[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+/g, replacer: () => '<REDACTED_JWT>' },
  // Anthropic (must be before generic sk-)
  { pattern: /sk-ant-[A-Za-z0-9_-]{10,}/g, replacer: () => 'sk-ant-***REDACTED***' },
  // OpenAI / generic sk-
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacer: () => 'sk-***REDACTED***' },
  // GitHub PAT (github_pat_)
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacer: () => 'github_pat_***REDACTED***' },
  // GitHub (ghp_, gho_, ghs_, ghr_, ghu_)
  { pattern: /gh[posru]_[A-Za-z0-9]{20,}/g, replacer: (m) => `${m.slice(0, 4)}***REDACTED***` },
  // Slack
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacer: (m) => `${m.slice(0, 5)}***REDACTED***` },
  // AWS Access Key
  { pattern: /A[SK]IA[0-9A-Z]{16}/g, replacer: (m) => `${m.slice(0, 4)}***REDACTED***` },
  // Generic Bearer token (catch-all, after specific patterns)
  { pattern: /\bBearer\s+([A-Za-z0-9_.\-/+=]{20,})/g, replacer: () => 'Bearer <REDACTED>' },
];

// Pass 3: KV-level patterns (password=, secret=, etc.)
const KV_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // JSON "key": "value"
  {
    pattern: /("(?:private_key|client_secret|secret_key|api_key|access_token|refresh_token)")\s*:\s*"[^"]+"/gi,
    replacement: '$1: "<REDACTED>"',
  },
  // ENV style KEY=value (only for sensitive key names, value must be 6+ chars)
  {
    pattern: /\b([A-Z_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z_]*)=["']?([^"'\s]{6,})["']?/gi,
    replacement: '$1=<REDACTED>',
  },
];

export function redact(input: string): string {
  let result = input;

  // Pass 1: Block-level
  for (const { pattern, replacement } of BLOCK_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), replacement);
  }

  // Pass 2: Token-level
  for (const { pattern, replacer } of TOKEN_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), replacer);
  }

  // Pass 3: KV-level (skip values already redacted by Pass 2)
  for (const { pattern, replacement } of KV_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), (...args) => {
      const fullMatch = args[0] as string;
      if (fullMatch.includes('REDACTED')) return fullMatch;
      return fullMatch.replace(new RegExp(pattern.source, pattern.flags), replacement);
    });
  }

  return result;
}
