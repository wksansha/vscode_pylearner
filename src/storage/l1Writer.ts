import * as vscode from "vscode";
import { ulid } from "ulidx";
import type { Surface } from "../constants";
import type { TraceEvent } from "../events/types";
import { makeEvent } from "../events/types";

export class L1Writer {
  private baseUri: vscode.Uri;
  private locks: Map<string, Promise<void>> = new Map();

  constructor(storageUri: vscode.Uri) {
    this.baseUri = vscode.Uri.joinPath(storageUri, "trace");
  }

  async append(
    surface: Surface,
    kind: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const event = makeEvent(surface, kind, payload, () => ulid(), () =>
      new Date().toISOString()
    );
    await this.writeEvent(event);
  }

  private async writeEvent(event: TraceEvent): Promise<void> {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dirUri = vscode.Uri.joinPath(this.baseUri, event.surface);
    const fileUri = vscode.Uri.joinPath(dirUri, `${today}.jsonl`);
    const line = JSON.stringify(event) + "\n";

    // Serialize writes per surface to avoid interleaving
    const prev = this.locks.get(event.surface) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        await vscode.workspace.fs.createDirectory(dirUri);
      } catch {
        // directory exists
      }
      const encoder = new TextEncoder();
      let existing: Uint8Array;
      try {
        existing = await vscode.workspace.fs.readFile(fileUri);
      } catch {
        existing = new Uint8Array(0);
      }
      const combined = new Uint8Array(existing.length + encoder.encode(line).length);
      combined.set(existing, 0);
      combined.set(encoder.encode(line), existing.length);
      await vscode.workspace.fs.writeFile(fileUri, combined);
    });
    this.locks.set(event.surface, next);
    await next;
  }
}
