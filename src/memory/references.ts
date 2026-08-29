// Reference validation + raw-trace rendering used by the update flow.
//
// Two concerns share this module because both center on "the set of refs
// the LLM is allowed to cite":
//
// * Update mode — refs must point at entities that appear in the current
//   chunk's source range. `refsInSpanL2` / `refsInSpanL3` return the
//   allowed pool; `validateFactRefs` filters extracted facts against it.
// * Rendering — `renderTracesForConcat` / `renderL2EntriesForConcat` turn
//   entities (L2) and L2 entries (L3) into the text that gets chunked.
//
// No I/O here: the caller has already hydrated the entity / doc maps.

import type { Document, Entry } from "./document";
import { isEntryId, isValidRef } from "./ids";
import type { Entity } from "../snapshot/entity";

export interface ExtractedFact {
  text: string;
  refs: string[];
  section: string;
}

// ── Update-mode helpers ─────────────────────────────────────────────────

export function refsInChunkL2(
  entities: readonly Entity[],
  surface: string,
  chunkText: string
): Set<string> {
  const allowed = new Set<string>();
  for (const ent of entities) {
    const marker = entityMarker(surface, ent.id);
    if (chunkText.includes(marker)) allowed.add(`${surface}:${ent.id}`);
  }
  return allowed;
}

export function refsInSpanL2(
  entities: readonly Entity[],
  surface: string,
  fullText: string,
  start: number,
  end: number
): Set<string> {
  const markers: Array<[number, string]> = [];
  for (const ent of entities) {
    const marker = entityMarker(surface, ent.id);
    const pos = fullText.indexOf(marker);
    if (pos !== -1) markers.push([pos, `${surface}:${ent.id}`]);
  }
  return refsOverlappingSpan(markers, fullText.length, start, end);
}

const _L3_SURFACE_HEADER_RE = /^### surface: ([a-z][a-z0-9_-]*)/gm;

export function refsInChunkL3(
  chunkText: string,
  entriesBySurface: Record<string, Entry[]>
): Set<string> {
  // Surface list is derived from the rendered text, not the map.
  void entriesBySurface;
  const allowed = new Set<string>();
  _L3_SURFACE_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = _L3_SURFACE_HEADER_RE.exec(chunkText)) !== null) {
    allowed.add(m[1]);
  }
  return allowed;
}

export function refsInSpanL3(
  entriesBySurface: Record<string, Entry[]>,
  fullText: string,
  start: number,
  end: number
): Set<string> {
  void entriesBySurface;
  _L3_SURFACE_HEADER_RE.lastIndex = 0;
  const headers: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = _L3_SURFACE_HEADER_RE.exec(fullText)) !== null) {
    headers.push(m);
  }
  if (headers.length === 0) return new Set();
  const allowed = new Set<string>();
  for (let idx = 0; idx < headers.length; idx++) {
    const blockStart = headers[idx].index;
    const blockEnd = idx + 1 < headers.length ? headers[idx + 1].index : fullText.length;
    if (blockStart < end && blockEnd > start) allowed.add(headers[idx][1]);
  }
  return allowed;
}

export interface ValidateFactRefsResult {
  keptRefs: string[];
  /** null when the fact survives; otherwise the rejection reason. */
  rejectReason: string | null;
}

export function validateFactRefs(
  fact: ExtractedFact,
  allowed: ReadonlySet<string>,
  enforceRequired: boolean,
  dropInvalid: boolean
): ValidateFactRefsResult {
  if (fact.refs.length === 0) {
    if (enforceRequired) return { keptRefs: [], rejectReason: "missing refs" };
    return { keptRefs: [], rejectReason: null };
  }

  if (dropInvalid) {
    const kept: string[] = [];
    for (const ref of fact.refs) {
      const normalized = normalizeAllowedRef(ref, allowed);
      if (normalized !== null) kept.push(normalized);
    }
    if (kept.length === 0 && enforceRequired) {
      return { keptRefs: [], rejectReason: "no surviving refs in chunk pool" };
    }
    return { keptRefs: dedupe(kept), rejectReason: null };
  }

  for (const ref of fact.refs) {
    const normalized = normalizeAllowedRef(ref, allowed);
    if (normalized === null && !isValidRef(ref)) {
      return { keptRefs: [], rejectReason: `malformed ref ${JSON.stringify(ref)}` };
    }
    if (normalized === null) {
      return { keptRefs: [], rejectReason: `out-of-pool ref ${JSON.stringify(ref)}` };
    }
  }
  return {
    keptRefs: dedupe(fact.refs.map((ref) => normalizeAllowedRef(ref, allowed) ?? ref)),
    rejectReason: null,
  };
}

// ── Rendering: traces → concatenated text ───────────────────────────────

const _ENTITY_HEADER_FMT = "=== {marker} ===";

export function renderTracesForConcat(entities: readonly Entity[], surface: string): string {
  const blocks: string[] = [];
  for (const ent of entities) {
    const header = _ENTITY_HEADER_FMT.replace("{marker}", entityMarker(surface, ent.id));
    const metaStr = formatMeta(ent);
    const body = (ent.content || "").trim();
    const parts = [
      header,
      `ref: ${surface}:${ent.id}`,
      `label: ${ent.label}`,
      `ts: ${ent.ts || "?"}`,
      metaStr ? `meta: ${metaStr}` : null,
      "",
      body,
    ].filter((x): x is string => x !== null);
    blocks.push(parts.join("\n"));
  }
  return blocks.join("\n\n");
}

export function renderL2EntriesForConcat(
  entriesBySurface: Record<string, Entry[]>
): string {
  const blocks: string[] = [];
  for (const [surface, entries] of Object.entries(entriesBySurface)) {
    if (!entries || entries.length === 0) continue;
    const lines = [`### surface: ${surface}`];
    for (const entry of entries) {
      const tag = entry.section ? `[${entry.section}] ` : "";
      lines.push(`- ${tag}${entry.text}`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

export function collectL2Entries(docs: Record<string, Document>): Record<string, Entry[]> {
  const out: Record<string, Entry[]> = {};
  for (const [surface, doc] of Object.entries(docs)) {
    out[surface] = doc.allEntries();
  }
  return out;
}

// ── Internals ───────────────────────────────────────────────────────────

export function entityMarker(surface: string, entityId: string): string {
  return `@entity ${surface}:${entityId}`;
}

function formatMeta(ent: Entity): string {
  const bits: string[] = [];
  for (const [k, v] of Object.entries(ent.metadata)) {
    if (v === null || v === "" || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && v !== null && Object.keys(v as object).length === 0) continue;
    bits.push(`${k}=${String(v)}`);
  }
  return bits.join(" ");
}

function normalizeAllowedRef(ref: string, allowed: ReadonlySet<string>): string | null {
  const candidate = stripRefWrappers(String(ref).trim());
  if (allowed.has(candidate) && isValidRef(candidate)) return candidate;
  const sorted = [...allowed].filter(isValidRef).sort((a, b) => b.length - a.length);
  for (const allowedRef of sorted) {
    if (hasRefSuffix(candidate, allowedRef)) return allowedRef;
  }
  return null;
}

function stripRefWrappers(ref: string): string {
  return ref.trim().replace(/^[`[\](){}<>]+|[`[\](){}<>]+$/g, "").replace(/^\^/, "").trim();
}

function hasRefSuffix(candidate: string, allowedRef: string): boolean {
  if (candidate === allowedRef) return true;
  if (!candidate.endsWith(allowedRef)) return false;
  const prefix = candidate.slice(0, -allowedRef.length);
  if (!prefix) return true;
  return [":", "：", "?", "？", "#", "/", "|", " ", "\t", "\n", "^"].includes(
    prefix[prefix.length - 1]
  );
}

function dedupe(refs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

function refsOverlappingSpan(
  markers: Array<[number, string]>,
  textLen: number,
  start: number,
  end: number
): Set<string> {
  const allowed = new Set<string>();
  const ordered = [...markers].sort((a, b) => a[0] - b[0]);
  for (let idx = 0; idx < ordered.length; idx++) {
    const blockStart = ordered[idx][0];
    const blockEnd = idx + 1 < ordered.length ? ordered[idx + 1][0] : textLen;
    if (blockStart < end && blockEnd > start) allowed.add(ordered[idx][1]);
  }
  return allowed;
}

// Re-export for consumers that keyed on the module-level name.
export { isEntryId };
