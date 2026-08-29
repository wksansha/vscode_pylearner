// Path resolution for the three-layer memory subsystem.
//
// Layout under the per-workspace global storage root::
//
//     trace/<surface>/<YYYY-MM-DD>.jsonl   (L1, append-only — written by P0)
//     l2/<surface>.md                      (L2, per-surface facts)
//     l2/<surface>.meta.json               (L2 seen-id sidecar)
//     l3/<slot>.md                         (L3, cross-surface profile)
//     l3/<slot>.meta.json                  (L3 seen-id sidecar)
//
// Pure string helpers are exported separately so the logic is unit-testable
// without the `vscode` module; the `vscode.Uri` wrappers are used at runtime.

import * as vscode from "vscode";

export type L3Slot = "recent" | "profile" | "scope" | "preferences";
export const L3_SLOTS: readonly L3Slot[] = ["recent", "profile", "scope", "preferences"];

export function l2FileName(surface: string): string {
  return `${surface}.md`;
}

export function l2MetaFileName(surface: string): string {
  return `${surface}.meta.json`;
}

export function l3FileName(slot: L3Slot): string {
  return `${slot}.md`;
}

export function l3MetaFileName(slot: L3Slot): string {
  return `${slot}.meta.json`;
}

// ── vscode.Uri wrappers ──────────────────────────────────────────────────

export function l2File(storageUri: vscode.Uri, surface: string): vscode.Uri {
  return vscode.Uri.joinPath(storageUri, "l2", l2FileName(surface));
}

export function l2MetaFile(storageUri: vscode.Uri, surface: string): vscode.Uri {
  return vscode.Uri.joinPath(storageUri, "l2", l2MetaFileName(surface));
}

export function l3File(storageUri: vscode.Uri, slot: L3Slot): vscode.Uri {
  return vscode.Uri.joinPath(storageUri, "l3", l3FileName(slot));
}

export function l3MetaFile(storageUri: vscode.Uri, slot: L3Slot): vscode.Uri {
  return vscode.Uri.joinPath(storageUri, "l3", l3MetaFileName(slot));
}
