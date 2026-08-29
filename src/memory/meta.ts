// Per-doc consolidator metadata (`*.meta.json` files).
//
// For each L2/L3 markdown doc we keep a sidecar JSON capturing the set of
// upstream ids "seen" at the last update. The update flow diffs that set
// against live state to compute "what's new since last update" — a purely
// id-based diff is robust against mtime / time-zone / replays.
//
// This module holds the pure types + (de)serialization + diff logic. Disk
// I/O (atomic temp + rename) lives in store.ts. Missing/corrupt files read
// back as "first run" (empty seen set), never a crash.

export const META_VERSION = 1;

export interface L2Meta {
  last_update_at: string | null;
  seen_entity_refs: string[];
}

export interface L3Meta {
  last_update_at: string | null;
  seen_l2_entry_ids: Record<string, string[]>;
}

export function newL2Meta(): L2Meta {
  return { last_update_at: null, seen_entity_refs: [] };
}

export function newL3Meta(): L3Meta {
  return { last_update_at: null, seen_l2_entry_ids: {} };
}

/** Ids in `current` not present in `seen` (the "new since last update" set). */
export function diffNewRefs(current: readonly string[], seen: ReadonlySet<string>): string[] {
  return current.filter((r) => !seen.has(r));
}

// --- JSON (de)serialization (pure) ---

export function parseL2Meta(raw: unknown): L2Meta {
  const data = raw as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return newL2Meta();
  const refs = data.seen_entity_refs;
  return {
    last_update_at: typeof data.last_update_at === "string" ? data.last_update_at : null,
    seen_entity_refs: Array.isArray(refs)
      ? refs.filter((r): r is string => typeof r === "string")
      : [],
  };
}

export function serializeL2Meta(meta: L2Meta): Record<string, unknown> {
  return {
    version: META_VERSION,
    last_update_at: meta.last_update_at,
    seen_entity_refs: [...meta.seen_entity_refs].sort(),
  };
}

export function parseL3Meta(raw: unknown): L3Meta {
  const data = raw as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return newL3Meta();
  const map: Record<string, string[]> = {};
  const rawMap = data.seen_l2_entry_ids;
  if (rawMap && typeof rawMap === "object" && !Array.isArray(rawMap)) {
    for (const [surface, ids] of Object.entries(rawMap as Record<string, unknown>)) {
      if (Array.isArray(ids)) {
        map[surface] = ids.filter((r): r is string => typeof r === "string");
      }
    }
  }
  return {
    last_update_at: typeof data.last_update_at === "string" ? data.last_update_at : null,
    seen_l2_entry_ids: map,
  };
}

export function serializeL3Meta(meta: L3Meta): Record<string, unknown> {
  const map: Record<string, string[]> = {};
  for (const [surface, ids] of Object.entries(meta.seen_l2_entry_ids)) {
    map[surface] = [...ids].sort();
  }
  return { version: META_VERSION, last_update_at: meta.last_update_at, seen_l2_entry_ids: map };
}
