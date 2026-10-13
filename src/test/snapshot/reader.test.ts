// src/test/snapshot/reader.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import "../vscode-mock";
import * as vscode from "vscode";
import { readTraceEntities } from "../../snapshot/reader";

const enc = new TextEncoder();
const file = (name: string): [string, vscode.FileType] => [name, vscode.FileType.File];
const dir = (name: string): [string, vscode.FileType] => [name, vscode.FileType.Directory];
const storage = { fsPath: "/gs", toString: () => "file:///gs" } as never;

beforeEach(() => {
  vi.mocked(vscode.workspace.fs.readDirectory).mockReset();
  vi.mocked(vscode.workspace.fs.readFile).mockReset();
});

describe("readTraceEntities（按学号）", () => {
  it("无身份 → 空数组，不做任何 IO", async () => {
    expect(await readTraceEntities(storage, "chat", null)).toEqual([]);
    expect(vscode.workspace.fs.readDirectory).not.toHaveBeenCalled();
  });

  it("非法学号 → 空数组", async () => {
    expect(await readTraceEntities(storage, "chat", "../x")).toEqual([]);
  });

  it("读 trace/<studentId>/<surface>/ 下的 jsonl 并解析", async () => {
    vi.mocked(vscode.workspace.fs.readDirectory).mockResolvedValue([
      file("2026-10-12.jsonl"),
      file("2026-10-13.jsonl"),
      file("other.txt"),
    ]);
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async (uri: unknown) => {
      const p = (uri as { path: string }).path;
      if (p.endsWith("2026-10-12.jsonl")) {
        return enc.encode('{"id":"chat:e1","ts":"t","surface":"chat","kind":"user_message","payload":{}}\n');
      }
      return Promise.reject(new Error("missing"));
    });
    const entities = await readTraceEntities(storage, "chat", "2024001");
    expect(entities).toHaveLength(1);
  });
});
