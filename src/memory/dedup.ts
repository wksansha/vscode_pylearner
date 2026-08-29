// Dedup mode — iterative line-level merge / delete over the full doc.
//
// Each iteration:
//   1. Render the full md as a line-numbered view (footnote-stripped).
//   2. One LLM call returns `{"edits": [...]}` (replace + delete only —
//      the dedup prompt forbids inserts).
//   3. Apply in reverse line order.
//   4. If the LLM returned zero edits, stop early (saves tokens).
//
// The configured `iterations` is the upper bound, not a quota.
//
// Dedup is invoked automatically after a successful `updateL2`/`updateL3`
// (controlled by `dedup.autoAfterUpdate`), mirroring DeepTutor.

import { Document } from "./document";
import {
  applyEdits,
  parseEditsPayload,
  renderNumbered,
  renderView,
  type Layer,
} from "./lineDoc";
import { buildDedupSystem, buildDedupUser } from "./prompts";
import { MEMORY_SETTINGS } from "./settings";

export interface DedupDeps {
  loadDoc(layer: Layer, key: string): Promise<Document | null>;
  saveDoc(layer: Layer, key: string, doc: Document): Promise<void>;
  callLlm(system: string, user: string): Promise<string>;
  onEvent?(event: Record<string, unknown>): void;
}

export interface DedupResult {
  layer: Layer;
  key: string;
  iterationsRun: number;
  editsApplied: number;
  /** Replaces where the LLM omitted refs and the engine preserved the
   *  entry's existing citations (provenance-preserving fallback). */
  refsPreserved: number;
  convergedEarly: boolean;
  noDoc: boolean;
}

export interface DedupOptions {
  iterations?: number;
  userLabel?: string;
}

export async function runDedup(
  deps: DedupDeps,
  layer: Layer,
  key: string,
  opts: DedupOptions = {}
): Promise<DedupResult> {
  const iterations = Math.max(1, opts.iterations ?? MEMORY_SETTINGS.dedup.iterations);
  const userLabel = opts.userLabel ?? "anonymous";
  const today = new Date().toISOString().slice(0, 10);

  const loaded = await deps.loadDoc(layer, key);
  if (!loaded || loaded.allEntries().length === 0) {
    emit(deps, { stage: "done", no_doc: true, edits_applied: 0 });
    return {
      layer,
      key,
      iterationsRun: 0,
      editsApplied: 0,
      refsPreserved: 0,
      convergedEarly: true,
      noDoc: true,
    };
  }

  let doc = loaded;
  let totalApplied = 0;
  let totalRefsPreserved = 0;
  let iterationsRun = 0;
  let convergedEarly = false;

  for (let turn = 0; turn < iterations; turn++) {
    iterationsRun = turn + 1;
    const view = renderView(doc);
    emit(deps, {
      stage: "progress",
      mode: "dedup",
      turn: iterationsRun,
      total: iterations,
      lines: view.lines.length,
    });

    const system = buildDedupSystem(userLabel, today);
    const user = buildDedupUser(renderNumbered(view), iterationsRun, iterations);
    const raw = await deps.callLlm(system, user);
    const edits = parseEditsPayload(raw);

    if (edits.length === 0) {
      convergedEarly = true;
      emit(deps, { stage: "facts_extracted", turn: iterationsRun, edits: 0 });
      break;
    }

    const { doc: next, report } = applyEdits(doc, edits);
    doc = next;
    totalApplied += report.applied.length;
    const refsPreserved = report.applied.filter((r) => r.refsPreserved).length;
    totalRefsPreserved += refsPreserved;
    if (report.applied.length > 0) {
      await deps.saveDoc(layer, key, doc);
    }
    emit(deps, {
      stage: "op_applied",
      turn: iterationsRun,
      applied: report.applied.length,
      rejected: report.rejected.length,
      refs_preserved: refsPreserved,
    });
  }

  emit(deps, {
    stage: "done",
    edits_applied: totalApplied,
    refs_preserved: totalRefsPreserved,
    iterations_run: iterationsRun,
    converged_early: convergedEarly,
  });
  return {
    layer,
    key,
    iterationsRun,
    editsApplied: totalApplied,
    refsPreserved: totalRefsPreserved,
    convergedEarly,
    noDoc: false,
  };
}

function emit(deps: DedupDeps, event: Record<string, unknown>): void {
  try {
    deps.onEvent?.(event);
  } catch {
    // event consumer failures never abort a pass
  }
}
