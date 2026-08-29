// On-disk persistence for L2/L3 markdown docs + their meta sidecars.
//
// The consolidation flow reads/writes through this store. Writes are atomic
// (temp file + rename) so a crash mid-write never leaves a half-written doc.
// Missing/corrupt files read back as "first run" — never a thrown error.

import * as vscode from "vscode";
import { parse, serialize, Document } from "./document";
import type { L2Meta, L3Meta } from "./meta";
import { parseL2Meta, parseL3Meta, serializeL2Meta, serializeL3Meta } from "./meta";
import { l2File, l2MetaFile, l3File, l3MetaFile, type L3Slot } from "./paths";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readText(uri: vscode.Uri): Promise<string | null> {
  try {
    return decoder.decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return null;
  }
}

async function readJson(uri: vscode.Uri): Promise<unknown> {
  const text = await readText(uri);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeTextAtomic(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
  const tmp = vscode.Uri.parse(uri.toString() + ".tmp");
  try {
    await vscode.workspace.fs.writeFile(tmp, encoder.encode(text));
    // Write to a sibling temp file, then rename over the target. rename is
    // atomic on the same filesystem, so a crash mid-write leaves either the
    // old bytes or the new bytes — never a half-written doc.
    await vscode.workspace.fs.rename(tmp, uri, { overwrite: true });
  } catch {
    // If the rename failed, best-effort remove the temp file.
    try {
      await vscode.workspace.fs.delete(tmp);
    } catch {}
    throw new Error("atomic write failed");
  }
}

// ── L2 ──────────────────────────────────────────────────────────────────

export async function loadL2Doc(storageUri: vscode.Uri, surface: string): Promise<Document | null> {
  const text = await readText(l2File(storageUri, surface));
  if (text === null) return null;
  return parse(text);
}

export async function saveL2Doc(storageUri: vscode.Uri, surface: string, doc: Document): Promise<void> {
  await writeTextAtomic(l2File(storageUri, surface), serialize(doc));
}

export async function loadL2Meta(storageUri: vscode.Uri, surface: string): Promise<L2Meta> {
  const raw = await readJson(l2MetaFile(storageUri, surface));
  return parseL2Meta(raw);
}

export async function saveL2Meta(storageUri: vscode.Uri, surface: string, meta: L2Meta): Promise<void> {
  await writeTextAtomic(l2MetaFile(storageUri, surface), JSON.stringify(serializeL2Meta(meta), null, 2));
}

// ── L3 ──────────────────────────────────────────────────────────────────

export async function loadL3Doc(storageUri: vscode.Uri, slot: L3Slot): Promise<Document | null> {
  const text = await readText(l3File(storageUri, slot));
  if (text === null) return null;
  return parse(text);
}

export async function saveL3Doc(storageUri: vscode.Uri, slot: L3Slot, doc: Document): Promise<void> {
  await writeTextAtomic(l3File(storageUri, slot), serialize(doc));
}

export async function loadL3Meta(storageUri: vscode.Uri, slot: L3Slot): Promise<L3Meta> {
  const raw = await readJson(l3MetaFile(storageUri, slot));
  return parseL3Meta(raw);
}

export async function saveL3Meta(storageUri: vscode.Uri, slot: L3Slot, meta: L3Meta): Promise<void> {
  await writeTextAtomic(l3MetaFile(storageUri, slot), JSON.stringify(serializeL3Meta(meta), null, 2));
}
