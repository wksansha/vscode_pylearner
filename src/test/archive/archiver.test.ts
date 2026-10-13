// src/test/archive/archiver.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "../vscode-mock";
import * as vscode from "vscode";
import { createTraceArchiver } from "../../archive/archiver";

const enc = new TextEncoder();
const IDENTITY = { studentId: "2024001", studentName: "张三", classId: "default" };
const line = (i: number) => `{"id":"chat:e${i}","ts":"t","surface":"chat","kind":"user_message","payload":{}}\n`;
// edit 文件 1 条、chat 文件 2 条 → 共 2 个上传批次（edit 批先于 chat 批，SURFACES 顺序）
const EDIT_KEY = "2024001/edit/2026-10-13.jsonl";
const CHAT_KEY = "2024001/chat/2026-10-13.jsonl";

function seedFs() {
  vi.mocked(vscode.workspace.fs.readDirectory).mockImplementation(async (uri: unknown) => {
    const p = (uri as { path: string }).path;
    if (p === "/gs/trace") return [["2024001", vscode.FileType.Directory]];
    if (p === "/gs/trace/2024001") return [[".identity.json", vscode.FileType.File]];
    if (p === "/gs/trace/2024001/edit") return [["2026-10-13.jsonl", vscode.FileType.File]];
    if (p === "/gs/trace/2024001/chat") return [["2026-10-13.jsonl", vscode.FileType.File]];
    return [];
  });
  vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async (uri: unknown) => {
    const p = (uri as { path: string }).path;
    if (p === "/gs/trace/2024001/.identity.json") return enc.encode(JSON.stringify(IDENTITY));
    if (p === "/gs/trace/2024001/edit/2026-10-13.jsonl") return enc.encode(line(1));
    if (p === "/gs/trace/2024001/chat/2026-10-13.jsonl") return enc.encode(line(1) + line(2));
    if (p.endsWith("archive-state.json")) return enc.encode("{}");
    throw new Error("missing: " + p);
  });
  vi.mocked(vscode.workspace.fs.createDirectory).mockResolvedValue(undefined);
  vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
}

function makeArchiver() {
  return createTraceArchiver({
    globalStorageUri: { fsPath: "/gs", toString: () => "file:///gs" } as never,
    teacherUrl: () => "http://t:3000/",
    isEnabled: () => true,
  });
}

const stubFetch = (impl: (...a: unknown[]) => unknown) => {
  // vitest 4 的 vi.stubGlobal 返回 vi 工具对象而非被 stub 的 mock，需显式返回 spy
  const fetchMock = vi.fn(impl) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
};
const stateWrites = () =>
  vi.mocked(vscode.workspace.fs.writeFile).mock.calls.filter((c) => (c[0] as { path: string }).path.endsWith("archive-state.json"));
const lastOffsets = () =>
  JSON.parse(new TextDecoder().decode(stateWrites().at(-1)![1] as Uint8Array));

beforeEach(() => {
  vi.clearAllMocks();
  seedFs();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TraceArchiver.runOnce", () => {
  it("2xx → 两批全部上传，批次字段齐全，位点推进并落 archive-state.json", async () => {
    const fetchMock = stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const archiver = makeArchiver();
    await archiver.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url1, init1] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url1).toBe("http://t:3000/api/trace/archive");
    expect(JSON.parse(init1.body as string)).toMatchObject({
      student_id: "2024001", student_name: "张三", class_id: "default", surface: "edit", date: "2026-10-13",
    });
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).events).toHaveLength(2);
    expect(lastOffsets()[EDIT_KEY]).toBe(enc.encode(line(1)).length);
    expect(lastOffsets()[CHAT_KEY]).toBe(enc.encode(line(1) + line(2)).length);
    archiver.dispose();
  });

  it("5xx → 本轮中止：第一批失败后第二批不再 fetch，位点不动", async () => {
    const fetchMock = stubFetch(() => new Response("err", { status: 500 }));
    const archiver = makeArchiver();
    await archiver.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stateWrites()).toHaveLength(0);
    archiver.dispose();
  });

  it("400 → 该文件位点跳到扫描时文件尾，其余文件继续", async () => {
    const fetchMock = stubFetch(() => new Response("bad", { status: 400 }));
    const archiver = makeArchiver();
    await archiver.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastOffsets()[EDIT_KEY]).toBe(enc.encode(line(1)).length);
    expect(lastOffsets()[CHAT_KEY]).toBe(enc.encode(line(1) + line(2)).length);
    archiver.dispose();
  });

  it("网络异常 → 本轮中止，位点不动", async () => {
    const fetchMock = stubFetch(() => { throw new Error("ECONNREFUSED"); });
    const archiver = makeArchiver();
    await archiver.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stateWrites()).toHaveLength(0);
    archiver.dispose();
  });

  it("isEnabled=false → 不扫描不上传", async () => {
    const fetchMock = stubFetch(() => new Response("{}", { status: 200 }));
    const archiver = createTraceArchiver({
      globalStorageUri: { fsPath: "/gs", toString: () => "file:///gs" } as never,
      teacherUrl: () => "http://t:3000",
      isEnabled: () => false,
    });
    await archiver.runOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.readDirectory).not.toHaveBeenCalled();
    archiver.dispose();
  });

  it("identity.json 缺失 → 学号跳过，无 fetch", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(new Error("missing"));
    const fetchMock = stubFetch(() => new Response("{}", { status: 200 }));
    const archiver = makeArchiver();
    await archiver.runOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    archiver.dispose();
  });

  it("双学号跨身份归档 → 两目录文件均上传，且各请求携带所在目录自身身份（spec §2）", async () => {
    const ID2 = { studentId: "2024002", studentName: "李四", classId: "c2" };
    // 自包含 seed：两学号各一目录，各一份 .identity.json + 一个 chat 文件（互不相同的事件 id）
    vi.mocked(vscode.workspace.fs.readDirectory).mockImplementation(async (uri: unknown) => {
      const p = (uri as { path: string }).path;
      if (p === "/gs/trace") return [["2024001", vscode.FileType.Directory], ["2024002", vscode.FileType.Directory]];
      if (p === "/gs/trace/2024001" || p === "/gs/trace/2024002") return [[".identity.json", vscode.FileType.File]];
      if (p === "/gs/trace/2024001/chat" || p === "/gs/trace/2024002/chat") return [["2026-10-13.jsonl", vscode.FileType.File]];
      return [];
    });
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async (uri: unknown) => {
      const p = (uri as { path: string }).path;
      if (p === "/gs/trace/2024001/.identity.json") return enc.encode(JSON.stringify(IDENTITY));
      if (p === "/gs/trace/2024002/.identity.json") return enc.encode(JSON.stringify(ID2));
      if (p === "/gs/trace/2024001/chat/2026-10-13.jsonl") return enc.encode(line(1));
      if (p === "/gs/trace/2024002/chat/2026-10-13.jsonl") return enc.encode(line(11) + line(12));
      if (p.endsWith("archive-state.json")) return enc.encode("{}");
      throw new Error("missing: " + p);
    });
    const fetchMock = stubFetch(() => new Response("{}", { status: 200 }));
    const archiver = makeArchiver();
    await archiver.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(
      ([, init]) => JSON.parse(init.body as string)
    );
    // 无"当前登录"概念：每个请求体携带其所在目录的身份，而非全局身份
    const byStudent = new Map(bodies.map((b) => [b.student_id as string, b]));
    expect(byStudent.get("2024001")).toMatchObject({
      student_id: "2024001", student_name: "张三", class_id: "default",
    });
    expect(byStudent.get("2024002")).toMatchObject({
      student_id: "2024002", student_name: "李四", class_id: "c2",
    });
    expect(byStudent.get("2024002")!.events).toHaveLength(2);
    archiver.dispose();
  });

  it("identity.json 学号与目录不符 → 该学号整体跳过，正常学号仍上传（防串档）", async () => {
    const MISMATCH = { studentId: "9999999", studentName: "王五", classId: "default" };
    // 自包含 seed：2024003 的 .identity.json 学号与目录名不一致；2024001 为正常对照
    vi.mocked(vscode.workspace.fs.readDirectory).mockImplementation(async (uri: unknown) => {
      const p = (uri as { path: string }).path;
      if (p === "/gs/trace") return [["2024001", vscode.FileType.Directory], ["2024003", vscode.FileType.Directory]];
      if (p === "/gs/trace/2024001" || p === "/gs/trace/2024003") return [[".identity.json", vscode.FileType.File]];
      if (p === "/gs/trace/2024001/edit" || p === "/gs/trace/2024001/chat" || p === "/gs/trace/2024003/chat") {
        return [["2026-10-13.jsonl", vscode.FileType.File]];
      }
      return [];
    });
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async (uri: unknown) => {
      const p = (uri as { path: string }).path;
      if (p === "/gs/trace/2024001/.identity.json") return enc.encode(JSON.stringify(IDENTITY));
      if (p === "/gs/trace/2024003/.identity.json") return enc.encode(JSON.stringify(MISMATCH));
      if (p === "/gs/trace/2024001/edit/2026-10-13.jsonl") return enc.encode(line(1));
      if (p === "/gs/trace/2024001/chat/2026-10-13.jsonl") return enc.encode(line(1) + line(2));
      if (p === "/gs/trace/2024003/chat/2026-10-13.jsonl") return enc.encode(line(9));
      if (p.endsWith("archive-state.json")) return enc.encode("{}");
      throw new Error("missing: " + p);
    });
    const fetchMock = stubFetch(() => new Response("{}", { status: 200 }));
    const archiver = makeArchiver();
    await archiver.runOnce();
    // 仅 2024001 的 edit+chat 两批；2024003 无任何 fetch
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(
      ([, init]) => JSON.parse(init.body as string)
    );
    expect(bodies.every((b) => b.student_id === "2024001")).toBe(true);
    archiver.dispose();
  });
});
