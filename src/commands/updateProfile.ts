// "Update learner profile" command — runs the L1→L2→L3 pipeline.
//
// Binds the pure consolidation deps (update.ts) to the real disk + LLM sides:
// trace JSONL (snapshot/reader) → L2 md (memory/store) → L3 profile md, with
// the LLM routed through the existing LlmRouter. On success it opens the
// generated profile.md in the editor as a preview.

import * as vscode from "vscode";
import { CMD_IDS, SURFACES } from "../constants";
import type { LlmRouter } from "../llm/router";
import * as store from "../memory/store";
import { l3File } from "../memory/paths";
import { updateL2, updateL3, type ConsolidatorDeps } from "../memory/update";
import type { Document } from "../memory/document";
import { readTraceEntities } from "../snapshot/reader";

function makeDeps(storageUri: vscode.Uri, router: LlmRouter): ConsolidatorDeps {
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
    callLlm: (system, user) => completeViaRouter(router, system, user),
  };
}

/** Collect the streamed chunks from a router backend into one response string. */
async function completeViaRouter(
  router: LlmRouter,
  system: string,
  user: string
): Promise<string> {
  const backend = router.resolve();
  const chunks: string[] = [];
  const controller = new AbortController();
  await backend.chat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    (text) => chunks.push(text),
    controller.signal
  );
  return chunks.join("");
}

/** Run the full L1→L2→L3 pipeline: every L2 surface, then the profile L3 slot. */
export async function runProfileUpdate(
  storageUri: vscode.Uri,
  router: LlmRouter
): Promise<void> {
  const deps = makeDeps(storageUri, router);
  for (const surface of SURFACES) {
    await updateL2(deps, surface);
  }
  await updateL3(deps, "profile");
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
          await runProfileUpdate(context.globalStorageUri, router);

          // Open the profile as a preview.
          const profileUri = l3File(context.globalStorageUri, "profile");
          try {
            await vscode.window.showTextDocument(profileUri);
          } catch {
            // Profile doc may not exist yet if nothing was synthesized.
            vscode.window.showInformationMessage(
              "Python Learner: profile updated (no new facts to synthesize)."
            );
            return;
          }
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
