// Atomic add/edit/delete operations on memory documents.
//
// A batch of ops is validated as a whole and applied only if all ops pass.
// Conflicting ops (e.g. delete + edit on the same id within one batch)
// reject the entire batch — the LLM doesn't get to self-contradict.
//
// Pure functions; no I/O, no LLM.

import { Document, Entry } from "./document";
import { isEntryId, isValidRef, newEntryId } from "./ids";

export const MAX_TEXT_LEN = 240;
export const MAX_SECTION_LEN = 80;
export const DELETE_REASONS: ReadonlySet<string> = new Set([
  "contradicted",
  "superseded",
  "stale",
  "low-signal",
]);

export interface AddOp {
  op: "add";
  section: string;
  text: string;
  refs: string[];
}

export interface EditOp {
  op: "edit";
  target_id: string;
  new_text: string;
  new_refs: string[];
}

export interface DeleteOp {
  op: "delete";
  target_id: string;
  reason: string;
}

export type Op = AddOp | EditOp | DeleteOp;

export interface OpResult {
  op: Op;
  status: "applied";
  entry_id?: string; // populated for add ops
  detail: string;
}

export interface ApplyReport {
  accepted: boolean;
  results: OpResult[];
  reason: string;
}

export class OpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpValidationError";
  }
}

/** Throws OpValidationError on the first failing op. */
export function validate(doc: Document, ops: Op[]): void {
  const edits = new Set<string>();
  const deletes = new Set<string>();

  for (const op of ops) {
    if (op.op === "add") {
      if (!op.text || op.text.length > MAX_TEXT_LEN) {
        throw new OpValidationError(
          `add: text length must be 1..${MAX_TEXT_LEN} (got ${op.text.length})`
        );
      }
      if (!op.section || op.section.length > MAX_SECTION_LEN) {
        throw new OpValidationError(`add: invalid section ${JSON.stringify(op.section)}`);
      }
      if (op.refs.length === 0) {
        throw new OpValidationError("add: refs must be non-empty");
      }
      for (const ref of op.refs) {
        if (!isValidRef(ref)) throw new OpValidationError(`add: malformed ref ${JSON.stringify(ref)}`);
      }
    } else if (op.op === "edit") {
      if (!isEntryId(op.target_id)) {
        throw new OpValidationError(`edit: malformed target_id ${JSON.stringify(op.target_id)}`);
      }
      if (!doc.find(op.target_id)) {
        throw new OpValidationError(`edit: target_id ${op.target_id} not found`);
      }
      if (!op.new_text || op.new_text.length > MAX_TEXT_LEN) {
        throw new OpValidationError(
          `edit: text length must be 1..${MAX_TEXT_LEN} (got ${op.new_text.length})`
        );
      }
      if (op.new_refs.length === 0) {
        throw new OpValidationError("edit: refs must be non-empty");
      }
      for (const ref of op.new_refs) {
        if (!isValidRef(ref)) throw new OpValidationError(`edit: malformed ref ${JSON.stringify(ref)}`);
      }
      if (deletes.has(op.target_id)) {
        throw new OpValidationError(`batch conflict: edit and delete on same id ${op.target_id}`);
      }
      edits.add(op.target_id);
    } else {
      if (!isEntryId(op.target_id)) {
        throw new OpValidationError(`delete: malformed target_id ${JSON.stringify(op.target_id)}`);
      }
      if (!doc.find(op.target_id)) {
        throw new OpValidationError(`delete: target_id ${op.target_id} not found`);
      }
      if (!DELETE_REASONS.has(op.reason)) {
        throw new OpValidationError(
          `delete: reason must be one of ${[...DELETE_REASONS].sort().join(", ")}`
        );
      }
      if (edits.has(op.target_id)) {
        throw new OpValidationError(`batch conflict: edit and delete on same id ${op.target_id}`);
      }
      deletes.add(op.target_id);
    }
  }
}

/** Apply ops as an atomic batch. Mutates `doc` in place on success. */
export function apply(doc: Document, ops: Op[]): ApplyReport {
  try {
    validate(doc, ops);
  } catch (err) {
    if (err instanceof OpValidationError) {
      return { accepted: false, results: [], reason: err.message };
    }
    throw err;
  }

  const results: OpResult[] = [];
  for (const op of ops) {
    if (op.op === "add") {
      const newId = newEntryId();
      doc.sectionEntries(op.section).push({
        id: newId,
        section: op.section,
        text: op.text,
        refs: [...op.refs],
      } satisfies Entry);
      results.push({ op, status: "applied", entry_id: newId, detail: "" });
    } else if (op.op === "edit") {
      const entry = doc.find(op.target_id);
      // validate() guaranteed this exists; keep the invariant explicit.
      if (!entry) throw new Error("unreachable: validated entry missing");
      entry.text = op.new_text;
      entry.refs = [...op.new_refs];
      results.push({ op, status: "applied", detail: "" });
    } else {
      doc.remove(op.target_id);
      results.push({ op, status: "applied", detail: op.reason });
    }
  }

  return { accepted: true, results, reason: "" };
}
