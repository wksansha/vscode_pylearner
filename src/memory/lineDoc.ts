// Line-numbered view of a memory document + line-level edit ops.
//
// The dedup pass asks the LLM to operate on a document the way an IDE
// assistant edits code: it sees numbered lines and emits structured edits
// referencing those numbers. To keep the document's invariants intact, the
// LLM only ever sees a sanitized view — section headers and entry bullets
// (each bullet annotated with its entry id and its citations). The footnote
// block is hidden and rebuilt by `serialize` from the surviving entries'
// refs.
//
// Editing model — three op types:
//   * ReplaceLineOp   — rewrite one bullet's text (and optionally its refs)
//   * DeleteLinesOp   — drop a contiguous run of entries
//   * InsertAfterOp   — add a new entry after a line (used by future audit,
//                      forbidden by the dedup prompt)
//
// Edits are applied in descending line order so earlier lines never shift
// under later edits. Each op carries a free-form `reason` for observability.
//
// Pure functions; no I/O, no LLM.

import { Document, Entry } from "./document";
import { hasBanned } from "./guards";
import { isEntryId, newEntryId } from "./ids";

export type Layer = "L2" | "L3";

export type LineKind = "title" | "blank" | "section" | "bullet";

export interface Line {
  /** 1-based, matches what the LLM sees. */
  number: number;
  kind: LineKind;
  /** Rendered text (no leading "n: " prefix). */
  text: string;
  /** For bullet lines, the m_xxx entry id. */
  entryId?: string;
  /** For bullet lines, the owning section name. */
  section?: string;
}

export interface LineView {
  lines: Line[];
  entriesInOrder: Entry[];
  entryById: Map<string, Entry>;
}

/** Snapshot of the sanitized document seen by the dedup LLM. */
export function renderView(doc: Document): LineView {
  const lines: Line[] = [];
  const entriesInOrder: Entry[] = [];
  const entryById = new Map<string, Entry>();

  if (doc.title) {
    lines.push({ number: lines.length + 1, kind: "title", text: `# ${doc.title}` });
    lines.push({ number: lines.length + 1, kind: "blank", text: "" });
  }

  for (const [sectionName, entries] of doc.sections) {
    if (entries.length === 0) continue;
    lines.push({ number: lines.length + 1, kind: "section", text: `## ${sectionName}` });
    for (const entry of entries) {
      // Annotate with the entry id (stable) and citations (so the LLM can
      // union refs when merging two entries — the whole point of dedup).
      const refs = entry.refs.length > 0 ? ` (${entry.refs.join(", ")})` : "";
      lines.push({
        number: lines.length + 1,
        kind: "bullet",
        text: `- ${entry.text} [^${entry.id}]${refs}`,
        entryId: entry.id,
        section: sectionName,
      });
      entriesInOrder.push(entry);
      entryById.set(entry.id, entry);
    }
    lines.push({ number: lines.length + 1, kind: "blank", text: "" });
  }

  // Strip trailing blanks so the rendered view doesn't end with an empty
  // line — keeps line counts predictable.
  while (lines.length > 0 && lines[lines.length - 1].kind === "blank") lines.pop();

  return { lines, entriesInOrder, entryById };
}

/** Render a LineView as the right-aligned "n: text" block the LLM sees. */
export function renderNumbered(view: LineView): string {
  const width = Math.max(2, String(view.lines.length).length);
  return view.lines.map((l) => `${String(l.number).padStart(width)}: ${l.text}`).join("\n");
}

// ── Edit ops ────────────────────────────────────────────────────────────

export interface ReplaceLineOp {
  op: "replace";
  line: number;
  newText: string;
  refs: string[];
  reason: string;
}

export interface DeleteLinesOp {
  op: "delete";
  lineStart: number;
  /** Inclusive. */
  lineEnd: number;
  reason: string;
}

export interface InsertAfterOp {
  op: "insert";
  afterLine: number;
  text: string;
  refs: string[];
  /** Optional; when absent the engine infers it from `afterLine`. */
  section?: string;
  reason: string;
}

export type LineEdit = ReplaceLineOp | DeleteLinesOp | InsertAfterOp;

export interface EditResult {
  op: LineEdit;
  status: "applied" | "rejected";
  detail: string;
  /** True when a replace omitted refs and the engine kept the entry's
   *  existing citations (provenance-preserving fallback). Only ever set
   *  on replace; delete/insert never populate it. */
  refsPreserved?: boolean;
}

export interface EditReport {
  applied: EditResult[];
  rejected: EditResult[];
}

/** Apply a batch of edits, in reverse line order, to a fresh copy.
 *
 * Returns `{ doc, report }`. `doc` is always returned; rejected edits are
 * captured in `report.rejected` and the rest still apply (callers decide
 * what to do with a partial-success batch — dedup writes the partial result).
 */
export function applyEdits(
  doc: Document,
  edits: LineEdit[]
): { doc: Document; report: EditReport } {
  const view = renderView(doc);
  const sorted = [...edits].sort((a, b) => editPos(b) - editPos(a));
  const report: EditReport = { applied: [], rejected: [] };

  // Deep-copy the section → entry arrays so edits don't mutate the caller's
  // document. Entry objects are copied too (replace mutates text/refs).
  const newDoc = new Document(doc.title);
  newDoc.sections = doc.sections.map(
    ([name, entries]) => [name, entries.map((e) => ({ ...e, refs: [...e.refs] }))] as [
      string,
      Entry[],
    ]
  );

  for (const edit of sorted) {
    try {
      const outcome = applyOne(edit, newDoc, view);
      report.applied.push({
        op: edit,
        status: "applied",
        detail: outcome.detail,
        refsPreserved: outcome.refsPreserved,
      });
    } catch (err) {
      report.rejected.push({
        op: edit,
        status: "rejected",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  dropEmptySections(newDoc);
  return { doc: newDoc, report };
}

// ── Apply one edit ──────────────────────────────────────────────────────

interface ApplyOutcome {
  detail: string;
  /** Set only on replace when refs were omitted and the entry's existing
   *  citations were preserved. */
  refsPreserved?: boolean;
}

function applyOne(edit: LineEdit, doc: Document, view: LineView): ApplyOutcome {
  if (edit.op === "replace") return applyReplace(edit, doc, view);
  if (edit.op === "delete") return applyDelete(edit, doc, view);
  return applyInsert(edit, doc, view);
}

function lineAt(view: LineView, n: number): Line | undefined {
  return n >= 1 && n <= view.lines.length ? view.lines[n - 1] : undefined;
}

function applyReplace(edit: ReplaceLineOp, doc: Document, view: LineView): ApplyOutcome {
  const line = lineAt(view, edit.line);
  if (!line || line.kind !== "bullet" || !line.entryId) {
    throw new Error(`line ${edit.line} is not an editable entry`);
  }
  const newText = edit.newText.trim();
  if (!newText) throw new Error("new_text empty");
  if (hasBanned(newText)) throw new Error("new_text carries banned absolutist phrasing");
  const entry = doc.find(line.entryId);
  if (!entry) throw new Error(`entry ${line.entryId} not found`);

  let refs = cleanRefs(edit.refs);
  // If the LLM omitted (or only echoed entry-id markers for) refs, preserve
  // the entry's existing citations — a text-only rewrite shouldn't lose
  // provenance. Flag it so callers can surface the silent under-merge risk.
  let refsPreserved = false;
  if (refs.length === 0) {
    refs = [...entry.refs];
    refsPreserved = true;
  }

  entry.text = newText;
  entry.refs = refs;
  return { detail: `replace ${entry.id}`, refsPreserved };
}

function applyDelete(edit: DeleteLinesOp, doc: Document, view: LineView): ApplyOutcome {
  if (edit.lineEnd < edit.lineStart) {
    throw new Error(`line_end ${edit.lineEnd} < line_start ${edit.lineStart}`);
  }
  const idsToDrop = new Set<string>();
  for (let n = edit.lineStart; n <= edit.lineEnd; n++) {
    const line = lineAt(view, n);
    if (line && line.kind === "bullet" && line.entryId) idsToDrop.add(line.entryId);
  }
  if (idsToDrop.size === 0) throw new Error("range covers no entries");

  for (let i = 0; i < doc.sections.length; i++) {
    const [name, entries] = doc.sections[i];
    doc.sections[i] = [name, entries.filter((e) => !idsToDrop.has(e.id))];
  }
  return { detail: `deleted ${idsToDrop.size} entries` };
}

function applyInsert(edit: InsertAfterOp, doc: Document, view: LineView): ApplyOutcome {
  const text = edit.text.trim();
  if (!text) throw new Error("insert text empty");
  if (hasBanned(text)) throw new Error("insert text carries banned absolutist phrasing");
  const refs = cleanRefs(edit.refs);
  if (refs.length === 0) throw new Error("insert requires non-empty refs");

  let section = edit.section?.trim();
  if (!section) {
    const anchor = lineAt(view, edit.afterLine);
    if (anchor && anchor.section) section = anchor.section;
    else if (anchor && anchor.kind === "section") section = anchor.text.replace(/^##\s*/, "");
  }
  if (!section) throw new Error("no section context for insert; supply section");

  const entry: Entry = { id: newEntryId(), section, text, refs };
  const target = doc.sectionEntries(section);
  const anchor = lineAt(view, edit.afterLine);
  if (anchor && anchor.kind === "bullet" && anchor.section === section && anchor.entryId) {
    const idx = target.findIndex((e) => e.id === anchor.entryId);
    if (idx !== -1) target.splice(idx + 1, 0, entry);
    else target.push(entry);
  } else {
    target.push(entry);
  }
  return { detail: `inserted ${entry.id} into ${JSON.stringify(section)}` };
}

// ── Parse edits payload ─────────────────────────────────────────────────

const _WRAPPER_CHARS = /^[`[\](){}<>^\s]+|[`[\](){}<>^\s]+$/g;

/**
 * Strip wrappers + drop garbage from one `refs` array.
 *
 * The line view shows each bullet as `- text [^m_xxx]`; LLMs sometimes copy
 * the marker (`^m_xxx`) wholesale into the new refs array. We strip wrapper
 * characters (`` ` [ ] ( ) { } < > ^ `` + whitespace), then drop any `m_<ULID>`
 * entry id — those are line-view markers, not citations. Real L2 refs are
 * `surface:id`; real L3 refs are bare surface names.
 */
export function cleanRefs(rawRefs: unknown): string[] {
  if (!Array.isArray(rawRefs)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rawRefs) {
    if (typeof r !== "string") continue;
    const s = r.replace(_WRAPPER_CHARS, "").trim();
    if (!s) continue;
    if (isEntryId(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Tolerant JSON parse → typed edit list. Empty on any failure — never throws.
 *
 * Accepts `{"edits": [...]}` or a top-level `[...]`. Unknown ops are dropped.
 */
export function parseEditsPayload(raw: string): LineEdit[] {
  const snippet = extractJson(raw);
  if (snippet === null) return [];

  let data: unknown;
  try {
    data = JSON.parse(snippet);
  } catch {
    return [];
  }

  const items =
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    "edits" in (data as Record<string, unknown>)
      ? (data as Record<string, unknown>).edits
      : data;
  if (!Array.isArray(items)) return [];

  const edits: LineEdit[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const kind = rec.op;
    if (kind === "replace") {
      edits.push({
        op: "replace",
        line: toInt(rec.line),
        newText: toStr(rec.new_text).trim(),
        refs: cleanRefs(rec.refs),
        reason: toStr(rec.reason).trim(),
      });
    } else if (kind === "delete") {
      const lineStart = toInt(rec.line_start ?? rec.line);
      const lineEnd = toInt(rec.line_end ?? rec.line);
      edits.push({ op: "delete", lineStart, lineEnd, reason: toStr(rec.reason).trim() });
    } else if (kind === "insert") {
      const section = typeof rec.section === "string" ? rec.section.trim() : undefined;
      edits.push({
        op: "insert",
        afterLine: toInt(rec.after_line),
        text: toStr(rec.text).trim(),
        refs: cleanRefs(rec.refs),
        section,
        reason: toStr(rec.reason).trim(),
      });
    }
  }
  return edits;
}

// ── Internals ───────────────────────────────────────────────────────────

function editPos(e: LineEdit): number {
  const primary = e.op === "delete" ? e.lineEnd : e.op === "replace" ? e.line : e.afterLine;
  // Secondary tie-break: replace before delete before insert at the same
  // line, mirroring DeepTutor's reverse-sort key.
  const secondary = e.op === "replace" ? 0 : e.op === "delete" ? 1 : 2;
  return primary * 3 + secondary;
}

function dropEmptySections(doc: Document): void {
  doc.sections = doc.sections.filter(([, entries]) => entries.length > 0);
}

function toInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return 0;
}

function toStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Find the outermost `{...}` or `[...]` JSON payload (fences stripped). */
function extractJson(raw: string): string | null {
  let text = raw.trim();
  text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  const objStart = text.indexOf("{");
  const arrStart = text.indexOf("[");
  let start: number;
  if (objStart === -1 && arrStart === -1) return null;
  if (objStart === -1) start = arrStart;
  else if (arrStart === -1) start = objStart;
  else start = Math.min(objStart, arrStart);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (end <= start) return null;
  return text.slice(start, end + 1);
}
