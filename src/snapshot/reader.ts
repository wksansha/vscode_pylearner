// I/O entry point: read L1 trace JSONL for a surface → `Entity[]`.
//
// Kept separate from the pure mapping in `adapter.ts` so that the mapping is
// unit-testable without the `vscode` module. This is the only L1 read path
// the consolidation flow needs (trace events are append-only; the id-set diff
// against `*.meta.json` decides what is "new since last update").

import * as vscode from "vscode";
import type { Surface } from "../constants";
import { parseTraceLine, traceEventToEntity } from "./adapter";
import type { Entity } from "./entity";

export async function readTraceEntities(
  storageUri: vscode.Uri,
  surface: Surface
): Promise<Entity[]> {
  const dirUri = vscode.Uri.joinPath(storageUri, "trace", surface);
  let entries: Array<[string, vscode.FileType]>;
  try {
    entries = await vscode.workspace.fs.readDirectory(dirUri);
  } catch {
    return [];
  }

  const jsonlFiles = entries
    .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".jsonl"))
    .map(([name]) => name)
    .sort();

  const entities: Entity[] = [];
  for (const name of jsonlFiles) {
    const fileUri = vscode.Uri.joinPath(dirUri, name);
    let data: Uint8Array;
    try {
      data = await vscode.workspace.fs.readFile(fileUri);
    } catch {
      continue;
    }
    const text = new TextDecoder().decode(data);
    for (const line of text.split("\n")) {
      const event = parseTraceLine(line);
      if (event && event.surface === surface) {
        entities.push(traceEventToEntity(event));
      }
    }
  }
  return entities;
}
