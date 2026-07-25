/**
 * Robust JSON extraction for LLM output. Models frequently wrap JSON in
 * markdown fences or surround it with prose; this helper finds and parses
 * the first JSON object or array in a string.
 */

/**
 * Extract the first JSON object/array from free-form text.
 * Handles: bare JSON, ```json fences, JSON embedded in prose, and strings
 * containing braces. Returns `undefined` when nothing parseable is found.
 */
export function extractJsonObject(text: string): unknown | undefined {
  if (!text) return undefined;
  let t = text.trim();

  // Prefer fenced blocks when present.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence?.[1]) t = fence[1].trim();

  // Fast path: whole string is JSON.
  try { return JSON.parse(t); } catch { /* fall through to scan */ }

  // Balanced scan from the first `{` or `[`, respecting strings/escapes.
  const starts: number[] = [];
  const brace = t.indexOf('{');
  const bracket = t.indexOf('[');
  if (brace >= 0) starts.push(brace);
  if (bracket >= 0) starts.push(bracket);
  if (starts.length === 0) return undefined;
  const start = Math.min(...starts);
  const open = t[start];
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(t.slice(start, i + 1)); } catch { return undefined; }
      }
    }
  }
  return undefined;
}
