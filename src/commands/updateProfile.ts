// "Update learner profile" command — runs the L1→L2→L3 pipeline.
//
// Binds the pure consolidation deps (update.ts) to the real disk + LLM sides:
// trace JSONL (snapshot/reader) → L2 md (memory/store) → L3 profile md, with
// the LLM routed through the existing LlmRouter. On success it opens the
// generated profile.md in the editor as a preview.

import * as vscode from "vscode";
import { CMD_IDS, SECRET_KEYS, CONSOLIDATION_SURFACES } from "../constants";
import type { LlmRouter } from "../llm/router";
import { callLlmWithRetry, DEFAULT_RETRY_CONFIG } from "../llm/retry";
import * as store from "../memory/store";
import { updateL2, updateL3, type ConsolidatorDeps } from "../memory/update";
import { translateL3Doc } from "../memory/translate";
import type { Document } from "../memory/document";
import { readTraceEntities } from "../snapshot/reader";
import { synthesizeOverview, type OverviewDeps } from "../memory/overview";
import { l3File, l3MetaFile, overviewFile } from "../memory/paths";

function makeDeps(storageUri: vscode.Uri, router: LlmRouter, apiKey: string, onEvent?: (event: Record<string, unknown>) => void, log?: (msg: string) => void): ConsolidatorDeps {
  return {
    readEntities: (surface) => readTraceEntities(storageUri, surface),
    loadAllL2Docs: async () => {
      const docs: Record<string, Document> = {};
      for (const surface of CONSOLIDATION_SURFACES) {
        const doc = await store.loadL2Doc(storageUri, surface);
        if (doc) docs[surface] = doc;
      }
      return docs;
    },
    loadL2Meta: (surface) => store.loadL2Meta(storageUri, surface),
    saveL2Meta: (surface, meta) => store.saveL2Meta(storageUri, surface, meta),
    loadL3Meta: (slot) => store.loadL3Meta(storageUri, slot),
    saveL3Meta: (slot, meta) => store.saveL3Meta(storageUri, slot, meta),
    loadL2Doc: (surface) => store.loadL2Doc(storageUri, surface),
    saveL2Doc: (surface, doc) => store.saveL2Doc(storageUri, surface, doc),
    loadL3Doc: (slot) => store.loadL3Doc(storageUri, slot),
    saveL3Doc: (slot, doc) => store.saveL3Doc(storageUri, slot, doc),
    callLlm: (system, user, context?: string) => completeViaRouter(router, apiKey, system, user, context, onEvent, log),
    onEvent,
  };
}

/** Overview pass deps: reuses the consolidator's LLM & L3 loader, adds only
 *  the free-form overview text sink. ConsolidatorDeps stays untouched. */
function makeOverviewDeps(deps: ConsolidatorDeps, storageUri: vscode.Uri): OverviewDeps {
  return {
    loadL3Doc: deps.loadL3Doc,
    callLlm: deps.callLlm,
    saveOverviewText: (text) => store.saveOverview(storageUri, "profile", text),
    onEvent: deps.onEvent,
  };
}

/** Collect the streamed chunks from a router backend into one response string. */
async function completeViaRouter(
  router: LlmRouter,
  apiKey: string,
  system: string,
  user: string,
  context?: string,
  onEvent?: (event: Record<string, unknown>) => void,
  log?: (msg: string) => void
): Promise<string> {
  // Refresh the router's cached config before resolving — the Update command
  // runs outside the chat path, so without this it would use the config
  // snapshot taken at extension activation (stale provider/model/baseUrl).
  const callStart = Date.now();
  const label = context ?? "unknown";
  log?.(`[pylearner:llm] START ${label}`);
  router.refreshConfig();
  const backend = router.resolve(apiKey);
  const result = await callLlmWithRetry(
    async (signal) => {
      const chunks: string[] = [];
      await backend.chat(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        (text) => chunks.push(text),
        signal
      );
      return chunks.join("");
    },
    // 300s per attempt (~25% headroom over rebuild-profile.ts's 240s):
    // glm-4.6v observably needs up to 239s on a large consolidation chunk
    // (diag chunk3), and a timeout is NOT retried — one slow call must not
    // fail the run.
    { ...DEFAULT_RETRY_CONFIG, timeoutMs: 300_000, baseDelayMs: 2_000 },
    (attempt, elapsedMs, timedOut, errorMsg) => {
      // per-attempt timing emitted to the pipeline's onEvent stream
      log?.(`[pylearner:llm] attempt ${attempt} of [${label}] ${timedOut ? "TIMEOUT" : errorMsg ? "FAIL" : "done"} (${elapsedMs}ms)`);
      onEvent?.({
        stage: "llm_attempt",
        context: label,
        attempt,
        elapsed_ms: elapsedMs,
        timed_out: timedOut,
        error: errorMsg ?? "",
      });
    }
  );

  const elapsed = Date.now() - callStart;
  if (result.ok) {
    log?.(`[pylearner:llm] OK ${label} (${elapsed}ms)`);
  } else {
    log?.(`[pylearner:llm] FAIL ${label} (${elapsed}ms): ${result.timedOut ? "TIMEOUT" : result.error}`);
  }

  if (!result.ok) {
    const prefix = result.timedOut
      ? `LLM call timed out after ${result.attempts} attempt(s) [${label}]`
      : `LLM call failed after ${result.attempts} attempt(s) [${label}]`;
    throw new Error(`${prefix}: ${result.error}`);
  }
  return result.text ?? "";
}

/** Run the full L1→L2→L3 pipeline: every L2 surface, then the profile L3 slot. */
export async function runProfileUpdate(
  storageUri: vscode.Uri,
  secrets: vscode.SecretStorage,
  router: LlmRouter,
  onEvent?: (event: Record<string, unknown>) => void,
  cancellationToken?: vscode.CancellationToken,
  log?: (msg: string) => void
): Promise<void> {
  const pipelineStart = Date.now();
  const apiKey = (await secrets.get(SECRET_KEYS.llmApiKey)) ?? "";
  const deps = makeDeps(storageUri, router, apiKey, onEvent, log);

  // Track timing for summary
  const stageTimes: Array<{ stage: string; elapsed_ms: number }> = [];
  const originalOnEvent = onEvent;
  onEvent = (event: Record<string, unknown>) => {
    // Capture stage timing for final summary
    if (event.stage && event.elapsed_ms !== undefined) {
      stageTimes.push({ stage: String(event.stage), elapsed_ms: Number(event.elapsed_ms) });
    }
    originalOnEvent?.(event);
  };

  // Helper to check cancellation
  const checkCancelled = () => {
    if (cancellationToken?.isCancellationRequested) {
      throw new Error("cancelled");
    }
  };

  checkCancelled();
  // Consolidate only the active surfaces, in parallel, to reduce total runtime
  const l2Start = Date.now();
  const surfaceResults = await Promise.all(CONSOLIDATION_SURFACES.map(surface => updateL2(deps, surface)));
  const l2Elapsed = Date.now() - l2Start;
  stageTimes.push({ stage: "all_L2_complete", elapsed_ms: l2Elapsed });

  checkCancelled();
  const l3Start = Date.now();
  const result = await updateL3(deps, "profile");
  const l3Elapsed = Date.now() - l3Start;
  stageTimes.push({ stage: "L3_complete", elapsed_ms: l3Elapsed });

  // The consolidation LLM reasons in English; the displayed profile must be
  // in Chinese, so translate the stored doc's prose as the final step — and
  // only when the doc actually grew, so a no-op update doesn't burn a call.
  // Incremental translation: only translate newly added entries (result.newEntryIds),
  // saving significant LLM budget for small updates.
  if (result.factsAdded > 0) {
    checkCancelled();
    const translateStart = Date.now();
    await translateL3Doc(deps, "profile", result.newEntryIds);
    const translateElapsed = Date.now() - translateStart;
    stageTimes.push({ stage: "translate_complete", elapsed_ms: translateElapsed });
  }

  // Teacher overview: one LLM call synthesizing the updated profile. Runs when
  // facts were added or when no overview exists yet (previous failure / first
  // run). Best-effort — never fails the pipeline.
  const overviewExists = (await store.loadOverview(storageUri, "profile")) !== null;
  if (result.factsAdded > 0 || !overviewExists) {
    checkCancelled();
    const overviewStart = Date.now();
    try {
      await synthesizeOverview(makeOverviewDeps(deps, storageUri), "profile");
      stageTimes.push({ stage: "overview_complete", elapsed_ms: Date.now() - overviewStart });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.(`[pylearner:overview] failed: ${msg}`);
      onEvent?.({ stage: "overview_failed", error: msg });
    }
  }

  // Final timing summary — write to Output Channel for diagnostics
  const totalElapsed = Date.now() - pipelineStart;
  log?.(`\n[pylearner:timing] === Pipeline Timing Summary ===`);
  log?.(`[pylearner:timing] Total: ${totalElapsed}ms`);
  for (const { stage, elapsed_ms } of stageTimes) {
    log?.(`[pylearner:timing]   ${stage}: ${elapsed_ms}ms`);
  }
  log?.(`[pylearner:timing] ================================\n`);
}

export function registerUpdateProfileCommand(
  context: vscode.ExtensionContext,
  routerFactory: () => LlmRouter,
  outputChannel: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand(CMD_IDS.updateProfile, async () => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Updating learner profile…",
        cancellable: true,
      },
      async (progress, token) => {
        try {
          const router = routerFactory();
          await runProfileUpdate(
            context.globalStorageUri,
            context.secrets,
            router,
            (event) => {
              // Emit progress events for the UI
              if (event.stage) {
                progress.report({ message: `Stage: ${event.stage}` });
              }
            },
            token,
            (msg) => outputChannel.appendLine(msg)
          );
          // The profile is rendered in the Profile panel (student/teacher
          // view). The raw audit copy with entry ids/footnotes lives at
          // l3/profile.md and is reachable via "Open profile" if needed —
          // it does not open automatically on every update.
          vscode.window.showInformationMessage("Python Learner: profile updated.");
        } catch (err) {
          // Check if user cancelled
          if ((err as Error).message?.includes('cancel')) {
            vscode.window.showInformationMessage("Profile update cancelled.");
          } else {
            vscode.window.showErrorMessage(
              `Profile update failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    );
  });
}

/**
 * Drop the synthesized L3 profile (md + seen-id sidecar) so the next Update
 * re-synthesizes it from scratch. The update pipeline is incremental — it
 * only processes L2 entries not yet reflected in the profile — so a bad
 * first synthesis (weak model, sloppy output) never rewrites itself without
 * this. L1 trace and L2 memory are untouched.
 */
export async function resetProfile(storageUri: vscode.Uri): Promise<void> {
  for (const uri of [
    l3File(storageUri, "profile"),
    l3MetaFile(storageUri, "profile"),
    overviewFile(storageUri, "profile"),
  ]) {
    try {
      await vscode.workspace.fs.delete(uri);
    } catch {
      // Missing file is fine — the goal is "no synthesized profile".
    }
  }
}

export function registerResetProfileCommand(
  context: vscode.ExtensionContext,
  routerFactory: () => LlmRouter,
  outputChannel: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand(CMD_IDS.resetProfile, async () => {
    const answer = await vscode.window.showWarningMessage(
      "Reset the learner profile? It will be deleted and regenerated from all L2 memory.",
      { modal: true },
      "Reset",
      "Cancel"
    );
    if (answer !== "Reset") return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Resetting and regenerating learner profile…",
        cancellable: true,
      },
      async (progress, token) => {
        try {
          const router = routerFactory();
          await resetProfile(context.globalStorageUri);
          await runProfileUpdate(
            context.globalStorageUri,
            context.secrets,
            router,
            (event) => {
              // Emit progress events for the UI
              if (event.stage) {
                progress.report({ message: `Stage: ${event.stage}` });
              }
            },
            token,
            (msg) => outputChannel.appendLine(msg)
          );
          vscode.window.showInformationMessage("Python Learner: profile reset and updated.");
        } catch (err) {
          // Check if user cancelled
          if ((err as Error).message?.includes('cancel')) {
            vscode.window.showInformationMessage("Profile reset cancelled.");
          } else {
            vscode.window.showErrorMessage(
              `Profile reset failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    );
  });
}
