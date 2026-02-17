export interface Blocker {
  description: string;
  file: string;
  line_range: string;
}

const MAX_BLOCKERS = 10;
const FILE_LINE_PATTERN = /([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+):(\d+(?:-\d+)?)/g;

export function extractBlockers(output: string): Blocker[] {
  const seen = new Set<string>();
  const blockers: Blocker[] = [];

  for (const match of output.matchAll(FILE_LINE_PATTERN)) {
    if (blockers.length >= MAX_BLOCKERS) break;

    const file = match[1];
    const lineRange = match[2];
    const key = `${file}:${lineRange}`;

    if (seen.has(key)) continue;
    seen.add(key);

    const lineStart = output.lastIndexOf('\n', match.index!) + 1;
    const lineEnd = output.indexOf('\n', match.index!);
    const description = output.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();

    blockers.push({ description, file, line_range: lineRange });
  }

  return blockers;
}
