// Snapshot data types.
//
// An `Entity` is one unit of L1 content for a surface — for
// vscode-pylearner, one trace event (edit/run/chat/debug/diag) lifted from
// the append-only JSONL written by L1Writer. `ChangeEntry` describes how a
// set of entities changed across refreshes (added/modified/removed).
//
// These types are intentionally pure with no I/O. The adapter builds
// `Entity[]`; consumers diff by id-set (trace events are immutable, so the
// only possible change kind is "added").

export interface Entity {
  /** Stable id — the ULID portion of the trace event id (ref is `<surface>:<id>`). */
  id: string;
  /** Short human-readable label for change logs / debug output. */
  label: string;
  /** ISO-8601 timestamp, or "" when unavailable. */
  ts: string;
  /** Human-readable body fed to the LLM for consolidation. */
  content: string;
  /** Extra provenance fields (kind, session_id, …). */
  metadata: Record<string, unknown>;
  /** Stable fingerprint of the entity's content (stable for immutable trace events). */
  fingerprint: string;
}

export type ChangeKind = "added" | "modified" | "removed";

export interface ChangeEntry {
  ts: string;
  kind: ChangeKind;
  entityId: string;
  label: string;
  prevFingerprint: string | null;
  newFingerprint: string | null;
}
