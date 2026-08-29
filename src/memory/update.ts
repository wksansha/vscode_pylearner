// Chunk-based incremental consolidation (L2 + L3), single-pass + append.
//
// Algorithm (per layer):
// 1. Compute "new since last update" by id-set diff against `*.meta.json`.
// 2. Concatenate the new inputs (oldest first) and chunk with boundary
//    expansion — never truncating mid-paragraph/sentence.
// 3. Per chunk: one LLM call → parse facts → validate refs against the
//    chunk-local pool → append to the in-memory doc → flush.
// 4. Atomic save of the doc + fresh `*.meta.json`.
//
// Pure helpers (`appendFactsToDoc`, `renderExisting`, `chunkWithRefHeader`)
// are exported for unit tests; `updateL2` / `updateL3` take a
// `ConsolidatorDeps` interface so the disk + LLM sides can be swapped for
// tests without the `vscode` module.

import type { Surface } from "../constants";
import type { Entity } from "../snapshot/entity";
import { chunkWithBoundary } from "./chunker";
import { Document, serialize } from "./document";
import type { Entry } from "./document";
import { hasBanned } from "./guards";
import type { L2Meta, L3Meta } from "./meta";
import { apply } from "./ops";
import type { AddOp } from "./ops";
import { parseFacts, type ExtractedFact } from "./parse";
import type { L3Slot } from "./paths";
import { buildL2System, buildL2User, buildL3System, buildL3User } from "./prompts";
import {
  refsInSpanL2,
  refsInSpanL3,
  renderL2EntriesForConcat,
  renderTracesForConcat,
  validateFactRefs,
} from "./references";
import { MEMORY_SETTINGS, SLOT_FOCUS, SURFACE_FOCUS } from "./settings";

export type UpdateLayer = "L2" | "L3";

export interface UpdateResult {
  layer: UpdateLayer;
  key: string;
  chunksProcessed: number;
  factsAdded: number;
  refsDropped: number;
  newEntryIds: string[];
  noNewInput: boolean;
}

export interface UpdateOptions {
  budget?: number;
  userLabel?: string;
}

export interface ConsolidatorDeps {
  readEntities(surface: Surface): Promise<Entity[]>;
  loadAllL2Docs(): Promise<Record<string, Document>>;
  loadL2Meta(surface: Surface): Promise<L2Meta>;
  saveL2Meta(surface: Surface, meta: L2Meta): Promise<void>;
  loadL3Meta(slot: L3Slot): Promise<L3Meta>;
  saveL3Meta(slot: L3Slot, meta: L3Meta): Promise<void>;
  loadL2Doc(surface: Surface): Promise<Document | null>;
  saveL2Doc(surface: Surface, doc: Document): Promise<void>;
  loadL3Doc(slot: L3Slot): Promise<Document | null>;
  saveL3Doc(slot: L3Slot, doc: Document): Promise<void>;
  callLlm(systemPrompt: string, userPrompt: string): Promise<string>;
  onEvent?(event: Record<string, unknown>): void;
}

export async function updateL2(
  deps: ConsolidatorDeps,
  surface: Surface,
  opts: UpdateOptions = {}
): Promise<UpdateResult> {
  const budget = opts.budget ?? MEMORY_SETTINGS.update.l2Budget;
  const userLabel = opts.userLabel ?? "anonymous";
  const today = todayIso();

  const meta = await deps.loadL2Meta(surface);
  const seen = new Set(meta.seen_entity_refs);
  const allEntities = (await deps.readEntities(surface)).sort(byTsThenId);
  const seenNow = new Set(allEntities.map((e) => `${surface}:${e.id}`));
  const newEntities = allEntities.filter((e) => !seen.has(`${surface}:${e.id}`));

  emit(deps, { stage: "trace_loaded", surface, total: allEntities.length, new: newEntities.length });

  if (newEntities.length === 0) {
    await deps.saveL2Meta(surface, { last_update_at: nowIso(), seen_entity_refs: [...seenNow] });
    emit(deps, { stage: "done", no_new_input: true, facts_added: 0 });
    return emptyResult("L2", surface, true);
  }

  const text = renderTracesForConcat(newEntities, surface);
  const chunks = chunkWithBoundary(text, {
    budget,
    overlapRatio: MEMORY_SETTINGS.chunking.overlapRatio,
    minChunkChars: MEMORY_SETTINGS.chunking.minChunkChars,
    maxChunkChars: MEMORY_SETTINGS.chunking.maxChunkChars,
    boundary: MEMORY_SETTINGS.chunking.boundary,
  });
  emit(deps, { stage: "chunked", chunks: chunks.length, budget, chars: text.length });

  const focus = SURFACE_FOCUS[surface];
  const doc = (await deps.loadL2Doc(surface)) ?? new Document(`${surface} memory`);

  let factsAdded = 0;
  let refsDropped = 0;
  const newEntryIds: string[] = [];

  for (const chunk of chunks) {
    const allowed = refsInSpanL2(newEntities, surface, text, chunk.start, chunk.end);
    const system = buildL2System(
      userLabel,
      surface,
      focus.sections.join(", "),
      focus.focus,
      today
    );
    const user = buildL2User(
      surface,
      renderExisting(doc),
      chunkWithRefHeader(chunk.text, allowed),
      chunk.index + 1,
      chunks.length,
      chunk.start,
      chunk.end
    );
    const raw = await deps.callLlm(system, user);
    const facts = parseFacts(raw);
    const kept: ExtractedFact[] = [];
    for (const fact of facts) {
      const { keptRefs, rejectReason } = validateFactRefs(
        fact,
        allowed,
        MEMORY_SETTINGS.reference.enforceRequired,
        MEMORY_SETTINGS.reference.dropInvalidRefs
      );
      if (rejectReason !== null) {
        refsDropped++;
        continue;
      }
      kept.push({ text: fact.text, refs: keptRefs, section: fact.section });
    }
    const addedNow = appendFactsToDoc(doc, kept, focus.sections);
    factsAdded += addedNow.length;
    newEntryIds.push(...addedNow);
    if (addedNow.length > 0) await deps.saveL2Doc(surface, doc);
    emit(deps, {
      stage: "facts_extracted",
      turn: chunk.index + 1,
      kept: kept.length,
      added: addedNow.length,
    });
  }

  await deps.saveL2Meta(surface, { last_update_at: nowIso(), seen_entity_refs: [...seenNow] });
  emit(deps, { stage: "done", facts_added: factsAdded, refs_dropped: refsDropped, chunks_processed: chunks.length });
  return { layer: "L2", key: surface, chunksProcessed: chunks.length, factsAdded, refsDropped, newEntryIds, noNewInput: false };
}

export async function updateL3(
  deps: ConsolidatorDeps,
  slot: L3Slot,
  opts: UpdateOptions = {}
): Promise<UpdateResult> {
  if (slot === "preferences") {
    throw new Error("preferences.md is not auto-consolidated");
  }

  const budget = opts.budget ?? MEMORY_SETTINGS.update.l3Budget;
  const userLabel = opts.userLabel ?? "anonymous";
  const today = todayIso();

  const meta = await deps.loadL3Meta(slot);
  const l2Docs = await deps.loadAllL2Docs();

  const entriesBySurface: Record<string, Entry[]> = {};
  const seenNow: Record<string, string[]> = {};
  for (const [surface, doc] of Object.entries(l2Docs)) {
    const all = doc.allEntries();
    seenNow[surface] = all.map((e) => e.id);
    const seen = new Set(meta.seen_l2_entry_ids[surface] ?? []);
    entriesBySurface[surface] = all.filter((e) => !seen.has(e.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  const newCount = Object.values(entriesBySurface).reduce((s, v) => s + v.length, 0);
  emit(deps, { stage: "trace_loaded", slot, new_l2_entries: newCount });

  if (newCount === 0) {
    await deps.saveL3Meta(slot, { last_update_at: nowIso(), seen_l2_entry_ids: seenNow });
    emit(deps, { stage: "done", no_new_input: true, facts_added: 0 });
    return emptyResult("L3", slot, true);
  }

  const text = renderL2EntriesForConcat(entriesBySurface);
  const chunks = chunkWithBoundary(text, {
    budget,
    overlapRatio: MEMORY_SETTINGS.chunking.overlapRatio,
    minChunkChars: MEMORY_SETTINGS.chunking.minChunkChars,
    maxChunkChars: MEMORY_SETTINGS.chunking.maxChunkChars,
    boundary: MEMORY_SETTINGS.chunking.boundary,
  });
  emit(deps, { stage: "chunked", chunks: chunks.length, budget, chars: text.length });

  const focus = SLOT_FOCUS[slot];
  const doc = (await deps.loadL3Doc(slot)) ?? new Document(defaultL3Title(slot));

  let factsAdded = 0;
  let refsDropped = 0;
  const newEntryIds: string[] = [];

  for (const chunk of chunks) {
    const allowed = refsInSpanL3(entriesBySurface, text, chunk.start, chunk.end);
    const system = buildL3System(userLabel, slot, focus.sections.join(", "), focus.focus, today);
    const user = buildL3User(
      slot,
      renderExisting(doc),
      chunkWithRefHeader(chunk.text, allowed),
      chunk.index + 1,
      chunks.length
    );
    const raw = await deps.callLlm(system, user);
    const facts = parseFacts(raw);
    const kept: ExtractedFact[] = [];
    for (const fact of facts) {
      const { keptRefs, rejectReason } = validateFactRefs(
        fact,
        allowed,
        MEMORY_SETTINGS.reference.enforceRequired,
        MEMORY_SETTINGS.reference.dropInvalidRefs
      );
      if (rejectReason !== null) {
        refsDropped++;
        continue;
      }
      kept.push({ text: fact.text, refs: keptRefs, section: fact.section });
    }
    const addedNow = appendFactsToDoc(doc, kept, focus.sections);
    factsAdded += addedNow.length;
    newEntryIds.push(...addedNow);
    if (addedNow.length > 0) await deps.saveL3Doc(slot, doc);
    emit(deps, {
      stage: "facts_extracted",
      turn: chunk.index + 1,
      kept: kept.length,
      added: addedNow.length,
    });
  }

  await deps.saveL3Meta(slot, { last_update_at: nowIso(), seen_l2_entry_ids: seenNow });
  emit(deps, { stage: "done", facts_added: factsAdded, refs_dropped: refsDropped, chunks_processed: chunks.length });
  return { layer: "L3", key: slot, chunksProcessed: chunks.length, factsAdded, refsDropped, newEntryIds, noNewInput: false };
}

// ── Pure helpers (exported for tests) ───────────────────────────────────

/** Append each fact as one AddOp; returns the new entry ids. */
export function appendFactsToDoc(
  doc: Document,
  facts: ExtractedFact[],
  allowedSections: string[]
): string[] {
  const newIds: string[] = [];
  const fallbackSection = allowedSections[0] ?? "Notes";
  for (const fact of facts) {
    // L3 objectivity guard: drop facts carrying absolutist phrasing
    // (outside quoted user verbatim). Runtime safety net beneath the prompt.
    if (hasBanned(fact.text)) continue;
    let section = fact.section ? fact.section : fallbackSection;
    if (allowedSections.length > 0 && !allowedSections.includes(section)) {
      section = fallbackSection;
    }
    const op: AddOp = { op: "add", section, text: fact.text, refs: fact.refs };
    const report = apply(doc, [op]);
    if (report.accepted && report.results.length > 0) {
      const newId = report.results[0].entry_id;
      if (newId) newIds.push(newId);
    }
  }
  return newIds;
}

export function renderExisting(doc: Document): string {
  if (doc.allEntries().length === 0) return "(empty — first run)";
  return serialize(doc).trim();
}

export function chunkWithRefHeader(chunkText: string, allowed: ReadonlySet<string>): string {
  if (allowed.size === 0) return chunkText;
  const refs = [...allowed].sort().map((ref) => `- ${ref}`).join("\n");
  return `# Chunk-local citeable refs\n${refs}\n\n${chunkText}`;
}

export function defaultL3Title(slot: L3Slot): string {
  return (
    {
      recent: "Recent summary",
      profile: "User profile",
      scope: "Knowledge scope",
      preferences: "Preferences",
    } as const
  )[slot];
}

// ── Internals ───────────────────────────────────────────────────────────

function emptyResult(layer: UpdateLayer, key: string, noNewInput: boolean): UpdateResult {
  return { layer, key, chunksProcessed: 0, factsAdded: 0, refsDropped: 0, newEntryIds: [], noNewInput };
}

function byTsThenId(a: Entity, b: Entity): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function emit(deps: ConsolidatorDeps, event: Record<string, unknown>): void {
  try {
    deps.onEvent?.(event);
  } catch {
    // event consumer failures never abort a run
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
