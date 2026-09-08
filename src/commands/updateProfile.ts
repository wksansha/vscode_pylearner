// "Update learner profile" command — runs the L1→L2→L3 pipeline.
//
// Binds the pure consolidation deps (update.ts) to the real disk + LLM sides:
// trace JSONL (snapshot/reader) → L2 md (memory/store) → L3 profile md, with
// the LLM routed through the existing LlmRouter. On success it opens the
// generated profile.md in the editor as a preview.

import * as vscode from "vscode";
import { CMD_IDS, SECRET_KEYS, SURFACES } from "../constants";
import type { LlmRouter } from "../llm/router";
import { callLlmWithRetry } from "../llm/retry";
import * as store from "../memory/store";
import { updateL2, updateL3, type ConsolidatorDeps } from "../memory/update";
import { translateL3Doc } from "../memory/translate";
import type { Document } from "../memory/document";
import { readTraceEntities } from "../snapshot/reader";
import { l3File, l3MetaFile } from "../memory/paths";

function makeDeps(storageUri: vscode.Uri, router: LlmRouter, apiKey: string): ConsolidatorDeps {
  return {
    readEntities: (surface) => readTraceEntities(storageUri, surface),
    loadAllL2Docs: async () => {
      const docs: Record<string, Document> = {};
      for (const surface of SURFACES) {
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
    callLlm: (system, user) => completeViaRouter(router, apiKey, system, user),
  };
}

/** Collect the streamed chunks from a router backend into one response string. */
async function completeViaRouter(
  router: LlmRouter,
  apiKey: string,
  system: string,
  user: string
): Promise<string> {
  // Refresh the router's cached config before resolving — the Update command
  // runs outside the chat path, so without this it would use the config
  // snapshot taken at extension activation (stale provider/model/baseUrl).
  router.refreshConfig();
  const backend = router.resolve(apiKey);
  const result = await callLlmWithRetry(async (signal) => {
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
  });

  if (!result.ok) {
    const prefix = result.timedOut
      ? `LLM call timed out after ${result.attempts} attempt(s)`
      : `LLM call failed after ${result.attempts} attempt(s)`;
    throw new Error(`${prefix}: ${result.error}`);
  }
  return result.text;
}

/** Run the full L1→L2→L3 pipeline: every L2 surface, then the profile L3 slot. */
export async function runProfileUpdate(
  storageUri: vscode.Uri,
  secrets: vscode.SecretStorage,
  router: LlmRouter
): Promise<void> {
  const apiKey = (await secrets.get(SECRET_KEYS.llmApiKey)) ?? "";
  const deps = makeDeps(storageUri, router, apiKey);
  for (const surface of SURFACES) {
    await updateL2(deps, surface);
  }
  const result = await updateL3(deps, "profile");
  // The consolidation LLM reasons in English; the displayed profile must be
  // in Chinese, so translate the stored doc's prose as the final step — and
  // only when the doc actually grew, so a no-op update doesn't burn a call.
  if (result.factsAdded > 0) {
    await translateL3Doc(deps, "profile");
  }
}

export function registerUpdateProfileCommand(
  context: vscode.ExtensionContext,
  router: LlmRouter
): vscode.Disposable {
  return vscode.commands.registerCommand(CMD_IDS.updateProfile, async () => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Updating learner profile…",
        cancellable: false,
      },
      async () => {
        try {
          await runProfileUpdate(context.globalStorageUri, context.secrets, router);

          // The profile is rendered in the Profile panel (student/teacher
          // view). The raw audit copy with entry ids/footnotes lives at
          // l3/profile.md and is reachable via "Open profile" if needed —
          // it does not open automatically on every update.
          vscode.window.showInformationMessage("Python Learner: profile updated.");
        } catch (err) {
          vscode.window.showErrorMessage(
            `Profile update failed: ${err instanceof Error ? err.message : String(err)}`
          );
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
  for (const uri of [l3File(storageUri, "profile"), l3MetaFile(storageUri, "profile")]) {
    try {
      await vscode.workspace.fs.delete(uri);
    } catch {
      // Missing file is fine — the goal is "no synthesized profile".
    }
  }
}

export function registerResetProfileCommand(
  context: vscode.ExtensionContext,
  router: LlmRouter
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
        cancellable: false,
      },
      async () => {
        try {
          await resetProfile(context.globalStorageUri);
          await runProfileUpdate(context.globalStorageUri, context.secrets, router);
          vscode.window.showInformationMessage("Python Learner: profile reset and updated.");
        } catch (err) {
          vscode.window.showErrorMessage(
            `Profile reset failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    );
  });
}
