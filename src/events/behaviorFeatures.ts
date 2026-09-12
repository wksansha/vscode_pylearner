// Typing-behavior feature extraction (pure, no vscode, no LLM).
//
// Converts one session's buffered change records + diagnostic snapshots +
// final text mirror into the compact `typing_session` payload described in
// the behavior-surface spec §六. The listener owns session lifecycle; this
// module only does math, so every rule is unit-testable and auditable.
//
// Numeric thresholds live in BEHAVIOR_CONSTANTS as initial-value constants
// (spec §十二) — deliberately NOT user settings. They are evidence for the
// LLM's attribution (SURFACE_FOCUS.behavior), never code-level verdicts.

export const BEHAVIOR_CONSTANTS = {
  /** Single-event inserts ≥ this many chars count as paste-like. */
  PASTE_LIKE_MIN_CHARS: 5,
  /** Gaps above this are hesitations (long pauses). */
  HESITATION_MS: 5_000,
  /** Line-bucket size for hot regions. */
  HOT_REGION_LINE_BUCKET: 3,
  /** Keep at most this many hot regions. */
  HOT_REGION_MAX: 3,
  /** Cap for hot-region final_text. */
  FINAL_TEXT_MAX_CHARS: 200,
  /** Cap applied by the wiring when snapshotting diagnostic messages. */
  DIAG_MSG_MAX_CHARS: 100,
  /** Cap for the errors_seen list (sorted by first appearance). */
  ERRORS_SEEN_MAX: 20,
} as const;

export type EndedBy =
  | "editor_switch"
  | "editor_close"
  | "idle"
  | "max_duration"
  | "deactivate";

/** One buffered document change. `t` is absolute ms (Date.now() at record). */
export interface BehaviorChangeRecord {
  t: number;
  /** 1-based start line of the change. */
  line: number;
  /** Inserted chars (change.text.length). */
  ins: number;
  /** Deleted chars (change.rangeLength). */
  del: number;
}

/** One diagnostic snapshot within the session. Messages raw (wiring truncates). */
export interface BehaviorDiagSnapshot {
  t: number;
  errors: string[];
}

export interface BehaviorExtractInput {
  file: string;
  startMs: number;
  endMs: number;
  endedBy: EndedBy;
  truncated: boolean;
  changes: BehaviorChangeRecord[];
  diagnostics: BehaviorDiagSnapshot[];
  /** Full current text of the file (from the listener's mirror). */
  finalText: string;
}

export interface TypingFeatures {
  changes: number;
  insert_chars: number;
  delete_chars: number;
  gap_median_ms: number;
  gap_p90_ms: number;
  hesitations_5s: number;
  max_gap_ms: number;
}

export interface HotRegion {
  /** "12-14" for a range, "12" for a single line. */
  lines: string;
  final_text: string;
  touches: number;
  insert_chars: number;
  delete_chars: number;
  constructs: string[];
}

export interface ErrorSighting {
  msg: string;
  first_rel_ms: number;
  fixed: boolean;
  /** First-fix latency (firstSeen → first disappearance). Omitted if never fixed. */
  latency_ms?: number;
  /** Times the error reappeared after having been absent. */
  recurred: number;
}

export interface DiagnosticsFeatures {
  errors_seen: ErrorSighting[];
  /** Distinct errors still present in the last snapshot. */
  unresolved: number;
}

export interface TypingSessionPayload {
  file: string;
  duration_ms: number;
  ended_by: EndedBy;
  truncated: boolean;
  typing: TypingFeatures;
  paste_like_inserts: number;
  hot_regions: HotRegion[];
  diagnostics: DiagnosticsFeatures;
}

// 12-entry initial-value construct table (spec §六). Keyword-based, so
// false positives are accepted noise; finer classification is the LLM's
// job at L2 time via final_text.
const CONSTRUCT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["for", /\bfor\b/],
  ["while", /\bwhile\b/],
  ["def", /\bdef\b/],
  ["class", /\bclass\b/],
  ["if-elif", /\b(?:if|elif)\b/],
  ["import", /\b(?:import|from)\b/],
  ["try-except", /\b(?:try|except)\b/],
  ["dict", /\{[^{}\n]*:[^{}\n]*\}/],
  ["list comprehension", /\[[^\]\n]*\bfor\b[^\]\n]*\]/],
  ["slicing", /\[\s*-?[\w.]*\s*:\s*-?[\w.]*\s*\]/],
  ["f-string", /\bf["']/],
  ["lambda", /\blambda\b/],
];

export function detectConstructs(text: string): string[] {
  const out: string[] = [];
  for (const [name, re] of CONSTRUCT_PATTERNS) {
    if (re.test(text)) out.push(name);
  }
  return out;
}

// Spec §六 normalization: strip "(file.py, line N)" location suffixes and
// bare "line N" fragments, collapse whitespace, lowercase. Same message at
// different lines aggregates as one recurring error; empty results drop.
const _LOC_PARENS_RE = /\((?:[^()]*\.py[^()]*)\)/g;
const _LINE_NUM_RE = /(?:, )?\bline \d+/gi;

export function normalizeDiagMsg(raw: string): string | null {
  let msg = raw.trim();
  msg = msg.replace(_LOC_PARENS_RE, "");
  msg = msg.replace(_LINE_NUM_RE, "");
  msg = msg.replace(/\s+/g, " ").trim().toLowerCase();
  return msg.length > 0 ? msg : null;
}

export function extractTypingSession(input: BehaviorExtractInput): TypingSessionPayload {
  const { changes, diagnostics, finalText, startMs, endMs, endedBy } = input;
  const c = BEHAVIOR_CONSTANTS;

  const durationMs = Math.max(0, endMs - startMs);

  // Gap series between consecutive changes. For idle-ended sessions the
  // trailing pause (last change → extraction) IS the max hesitation signal
  // (spec §五) and joins the series; other endings exclude it.
  const gaps: number[] = [];
  for (let i = 1; i < changes.length; i++) {
    gaps.push(Math.max(0, changes[i].t - changes[i - 1].t));
  }
  if (endedBy === "idle" && changes.length > 0) {
    gaps.push(Math.max(0, endMs - changes[changes.length - 1].t));
  }
  const sorted = [...gaps].sort((a, b) => a - b);

  const hotRegions = extractHotRegions(changes, finalText);

  return {
    file: input.file,
    duration_ms: durationMs,
    ended_by: endedBy,
    truncated: input.truncated,
    typing: {
      changes: changes.length,
      insert_chars: changes.reduce((s, ch) => s + ch.ins, 0),
      delete_chars: changes.reduce((s, ch) => s + ch.del, 0),
      gap_median_ms: median(sorted),
      gap_p90_ms: percentile90(sorted),
      hesitations_5s: gaps.filter((g) => g > c.HESITATION_MS).length,
      max_gap_ms: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    },
    paste_like_inserts: changes.filter((ch) => ch.ins >= c.PASTE_LIKE_MIN_CHARS).length,
    hot_regions: hotRegions,
    diagnostics: aggregateDiagnostics(diagnostics, startMs),
  };
}

function extractHotRegions(
  changes: BehaviorChangeRecord[],
  finalText: string
): HotRegion[] {
  const c = BEHAVIOR_CONSTANTS;
  if (changes.length === 0) return [];
  const bucketSize = c.HOT_REGION_LINE_BUCKET;

  // Group by 3-line bucket, keyed by the bucket's first line (1-based).
  const buckets = new Map<number, { touches: number; ins: number; del: number }>();
  for (const ch of changes) {
    const bucketStart = Math.floor((ch.line - 1) / bucketSize) * bucketSize + 1;
    const b = buckets.get(bucketStart) ?? { touches: 0, ins: 0, del: 0 };
    b.touches += 1;
    b.ins += ch.ins;
    b.del += ch.del;
    buckets.set(bucketStart, b);
  }

  const top = [...buckets.entries()]
    .sort((a, b) => b[1].touches - a[1].touches || a[0] - b[0])
    .slice(0, c.HOT_REGION_MAX);

  const lines = finalText.split("\n");
  return top.map(([bucketStart, b]) => {
    const bucketEnd = bucketStart + bucketSize - 1;
    const slice = lines.slice(Math.max(0, bucketStart - 1), bucketEnd);
    const text = slice.join("\n").slice(0, c.FINAL_TEXT_MAX_CHARS);
    return {
      lines: bucketStart === bucketEnd ? `${bucketStart}` : `${bucketStart}-${bucketEnd}`,
      final_text: text,
      touches: b.touches,
      insert_chars: b.ins,
      delete_chars: b.del,
      constructs: detectConstructs(text),
    };
  });
}

interface DiagTrack {
  firstSeen: number;
  currentlyPresent: boolean;
  fixed: boolean;
  fixedAt: number;
  recurred: number;
}

function aggregateDiagnostics(
  snapshots: BehaviorDiagSnapshot[],
  startMs: number
): DiagnosticsFeatures {
  const c = BEHAVIOR_CONSTANTS;
  const tracks = new Map<string, DiagTrack>();
  for (const snap of snapshots) {
    const present = new Set<string>();
    for (const raw of snap.errors) {
      const msg = normalizeDiagMsg(raw);
      if (!msg) continue;
      present.add(msg);
      const tr = tracks.get(msg);
      if (!tr) {
        tracks.set(msg, { firstSeen: snap.t, currentlyPresent: true, fixed: false, fixedAt: 0, recurred: 0 });
      } else if (!tr.currentlyPresent) {
        tr.recurred += 1; // was absent, now back → recurrence
        tr.currentlyPresent = true;
      }
    }
    for (const [msg, tr] of tracks) {
      if (!present.has(msg) && tr.currentlyPresent) {
        tr.currentlyPresent = false;
        if (!tr.fixed) {
          tr.fixed = true;
          tr.fixedAt = snap.t;
        }
      }
    }
  }

  const errors_seen: ErrorSighting[] = [...tracks.entries()]
    .sort((a, b) => a[1].firstSeen - b[1].firstSeen)
    .slice(0, c.ERRORS_SEEN_MAX)
    .map(([msg, tr]) => ({
      msg,
      first_rel_ms: Math.max(0, tr.firstSeen - startMs),
      fixed: tr.fixed,
      ...(tr.fixed ? { latency_ms: Math.max(0, tr.fixedAt - tr.firstSeen) } : {}),
      recurred: tr.recurred,
    }));

  const unresolved = [...tracks.values()].filter((tr) => tr.currentlyPresent).length;
  return { errors_seen, unresolved };
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function percentile90(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1);
  return sorted[idx];
}