import { createHash } from 'node:crypto';

const BASE_TEMPLATE = `You are an AI coding assistant operating within Agent Firewall.

WORKSPACE: {{workspace}}
GOAL: {{goal}}
{{constraints}}

RULES:
- Only modify files within the workspace directory
- Do not access files outside the workspace
- Do not attempt to exfiltrate data via network calls
- Report any blockers with exact file paths and line numbers
- Generate a summary of changes made

Begin working on the goal.`;

const INJECTION_PATTERNS = [
  /ignore\s+previous/i,
  /disregard\s+(all\s+)?instructions/i,
  /\bread\s+\/(?!tmp)/i,
  /\bexfiltrate\b/i,
];

const MAX_APPEND_BYTES = 2048;

export class PromptTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptTemplateError';
  }
}

export interface PromptParams {
  goal: string;
  workspace: string;
  constraints: string;
}

export interface PromptResult {
  prompt: string;
  templateHash: string;
}

export function buildPrompt(params: PromptParams, append: string): PromptResult {
  if (Buffer.byteLength(append, 'utf-8') > MAX_APPEND_BYTES) {
    throw new PromptTemplateError(`AF_PROMPT_APPEND exceeds ${MAX_APPEND_BYTES} byte limit`);
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(append)) {
      throw new PromptTemplateError(`AF_PROMPT_APPEND contains blocked pattern: ${pattern.source}`);
    }
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(params.goal)) {
      throw new PromptTemplateError(`Goal contains blocked injection pattern: ${pattern.source}`);
    }
  }

  const templateHash = createHash('sha256').update(BASE_TEMPLATE).digest('hex').slice(0, 16);

  let prompt = BASE_TEMPLATE
    .replace('{{goal}}', params.goal)
    .replace('{{workspace}}', params.workspace)
    .replace('{{constraints}}', params.constraints);

  if (append.trim()) {
    prompt += `\n\nADDITIONAL INSTRUCTIONS:\n${append.trim()}`;
  }

  return { prompt, templateHash: `sha256:${templateHash}` };
}
