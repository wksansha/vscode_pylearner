// Character-based chunking with boundary expansion.
//
// The L2/L3 update flow concatenates inputs into one string, then
// chunkWithBoundary cuts it into <= budget pieces. Each piece's right edge
// is extended forward to the next paragraph or sentence boundary — content
// is never truncated mid-statement. Adjacent chunks overlap by a
// percentage of the target size so a fact straddling a cut still gets a
// fair read.
//
// Pure functions: no I/O, no LLM.

export type Boundary = "paragraph" | "sentence";

// Paragraph boundary: one or more blank lines.
const _PARA_BOUNDARY = /\n\s*\n+/;
// Sentence boundary: terminal punctuation followed by space/newline/end.
// Covers ASCII (.!?) and CJK (。！？).
const _SENT_BOUNDARY = /[.!?。！？](?:[\")»」』]+)?(?=\s|$)/;

export interface ChunkSpan {
  /** 0-based position in the returned list. */
  index: number;
  /** Inclusive start offset in the source text. */
  start: number;
  /** Exclusive end offset in the source text. */
  end: number;
  text: string;
}

export interface ChunkOptions {
  budget: number;
  overlapRatio: number;
  minChunkChars: number;
  maxChunkChars: number;
  boundary?: Boundary;
}

export function chunkWithBoundary(text: string, opts: ChunkOptions): ChunkSpan[] {
  const {
    budget: budgetRaw,
    overlapRatio,
    minChunkChars,
    maxChunkChars,
    boundary = "paragraph",
  } = opts;

  if (!text.trim()) return [];
  const budget = budgetRaw < 1 ? 1 : budgetRaw;

  const n = text.length;
  let target = Math.ceil(n / budget);
  target = Math.max(minChunkChars, Math.min(maxChunkChars, target));
  const overlap = Math.max(0, Math.min(target - 1, Math.round(target * overlapRatio)));

  // Short-circuit: input fits in one chunk.
  if (n <= target) {
    return [{ index: 0, start: 0, end: n, text }];
  }

  const spans: ChunkSpan[] = [];
  let cursor = 0;
  while (cursor < n) {
    const targetEnd = Math.min(n, cursor + target);
    // Hard cap on how far the right edge can be pulled to find a boundary,
    // so chunks never grow past maxChunkChars even on degenerate input
    // (e.g. one long line with no paragraph/sentence breaks).
    const hardCap = Math.min(n, cursor + maxChunkChars);
    let end: number;
    if (targetEnd >= n) {
      end = n;
    } else {
      end = expandToBoundary(text, targetEnd, boundary, hardCap);
    }
    if (end <= cursor) {
      end = Math.min(n, cursor + Math.max(1, target));
    }
    spans.push({ index: spans.length, start: cursor, end, text: text.slice(cursor, end) });
    if (end >= n) break;
    let nextCursor = end - overlap;
    if (nextCursor <= cursor) nextCursor = cursor + 1;
    cursor = nextCursor;
  }

  return spans;
}

function expandToBoundary(
  text: string,
  targetEnd: number,
  boundary: Boundary,
  limit: number
): number {
  const re = boundary === "paragraph" ? _PARA_BOUNDARY : _SENT_BOUNDARY;
  const window = text.slice(targetEnd, limit);
  const m = re.exec(window);
  if (m === null) return limit;
  return targetEnd + m.index + m[0].length;
}
