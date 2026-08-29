// Merge mode — no-LLM footnote consolidation on a single doc.
//
// The `serialize` function already emits the ref-keyed footnote layout and
// collapses N entries citing the same source into one footnote label. Merge
// makes that a first-class, idempotent pass and adds the one piece of
// cleanup that isn't implicit in a parse→serialize round-trip:
//
//   * L3 legacy ref migration — pre-pivot L3 docs cited L2 entries by their
//     `m_<ULID>` id. The current design wants surface-level provenance only
//     ("which L2 md did this synthesize from"). For each `m_<ULID>` ref we
//     scan every L2 doc for the owning entry and substitute the surface
//     name. Unresolvable ids are dropped silently; the next update re-
//     synthesizes from current L2 text.
//
// Merge is invoked automatically after a successful update (and after
// dedup), controlled by `merge.autoAfterUpdate` / `merge.autoAfterDedup`.
// It makes no LLM calls.
//
// Pure helper (`migrateL3LegacyRefs`) is exported for unit tests.

import { Document, serialize } from "./document";
import { isEntryId } from "./ids";
import type { Layer } from "./lineDoc";

export interface MergeDeps {
  loadDoc(layer: Layer, key: string): Promise<Document | null>;
  saveDoc(layer: Layer, key: string, doc: Document): Promise<void>;
  loadAllL2Docs(): Promise<Record<string, Document>>;
  onEvent?(event: Record<string, unknown>): void;
}

export interface MergeResult {
  layer: Layer;
  key: string;
  /** True when the pass changed the serialized bytes (and re-wrote the doc). */
  rewrote: boolean;
  legacyL3RefsMigrated: number;
  noDoc: boolean;
}

export async function runMerge(
  deps: MergeDeps,
  layer: Layer,
  key: string
): Promise<MergeResult> {
  const doc = await deps.loadDoc(layer, key);
  if (!doc || doc.allEntries().length === 0) {
    emit(deps, { stage: "done", no_doc: true, rewrote: false });
    return { layer, key, rewrote: false, legacyL3RefsMigrated: 0, noDoc: true };
  }

  const before = serialize(doc);
  let migrated = 0;
  if (layer === "L3") {
    migrated = migrateL3LegacyRefs(doc, await buildL2OwnerMap(deps));
  }
  const after = serialize(doc);
  const rewrote = before !== after;

  if (rewrote) {
    await deps.saveDoc(layer, key, doc);
  }
  emit(deps, { stage: "done", rewrote, legacy_l3_refs_migrated: migrated });
  return { layer, key, rewrote, legacyL3RefsMigrated: migrated, noDoc: false };
}

/**
 * Resolve legacy `m_<ULID>` L3 refs to their owning surface names.
 *
 * Returns the number of entry refs migrated. Unresolvable ids (entry
 * deleted, or never existed) are dropped.
 */
export function migrateL3LegacyRefs(
  doc: Document,
  l2Owner: ReadonlyMap<string, string>
): number {
  let migrated = 0;
  for (const entry of doc.allEntries()) {
    if (entry.refs.length === 0) continue;
    const newRefs: string[] = [];
    const seen = new Set<string>();
    for (const ref of entry.refs) {
      if (isEntryId(ref)) {
        migrated += 1;
        const resolved = l2Owner.get(ref);
        if (resolved === undefined || seen.has(resolved)) continue;
        seen.add(resolved);
        newRefs.push(resolved);
      } else {
        if (seen.has(ref)) continue;
        seen.add(ref);
        newRefs.push(ref);
      }
    }
    entry.refs = newRefs;
  }
  return migrated;
}

// ── Internals ───────────────────────────────────────────────────────────

async function buildL2OwnerMap(deps: MergeDeps): Promise<Map<string, string>> {
  const owner = new Map<string, string>();
  const docs = await deps.loadAllL2Docs();
  for (const [surface, doc] of Object.entries(docs)) {
    for (const entry of doc.allEntries()) {
      if (!owner.has(entry.id)) owner.set(entry.id, surface);
    }
  }
  return owner;
}

function emit(deps: MergeDeps, event: Record<string, unknown>): void {
  try {
    deps.onEvent?.(event);
  } catch {
    // event consumer failures never abort a pass
  }
}
