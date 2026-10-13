// src/test/archive/batcher.test.ts
import { describe, it, expect } from "vitest";
import {
  planBatches,
  type ArchiveFs,
  type BatchIdentity,
} from "../../archive/batcher";
import { OFFSETS_FILE } from "../../archive/archiveState";

const enc = new TextEncoder();
const IDENTITY: BatchIdentity = { studentId: "2024001", studentName: "张三", classId: "default" };
const line = (i: number) => `{"id":"chat:e${i}","ts":"t","surface":"chat","kind":"user_message","payload":{}}\n`;

function memFs(files: Record<string, string>): ArchiveFs {
  const store = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(files)) store.set(k, enc.encode(v));
  return {
    async listDirs(rel) {
      const prefix = rel ? rel + "/" : "";
      const names = new Set<string>();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const seg = rest.split("/")[0];
        if (seg && rest.includes("/")) names.add(seg);
      }
      return [...names];
    },
    async listFiles(rel) {
      const prefix = rel + "/";
      return [...store.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map((k) => k.slice(prefix.length));
    },
    async readFileBytes(rel) {
      return store.get(rel) ?? null;
    },
    async writeFileBytes(rel, data) {
      store.set(rel, data);
    },
  };
}
const getIdentity = async (id: string): Promise<BatchIdentity | null> =>
  id === "2024001" ? IDENTITY : null;

describe("planBatches", () => {
  it("全新文件 → 从 0 全量一批，位点 key 正确", async () => {
    const files: Record<string, string> = {
      "2024001/.identity.json": JSON.stringify(IDENTITY),
      "2024001/chat/2026-10-13.jsonl": line(1) + line(2),
    };
    const { jobs, offsets } = await planBatches(memFs(files), {}, getIdentity);
    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.fileKey).toBe("2024001/chat/2026-10-13.jsonl");
    expect(j.identity).toEqual(IDENTITY);
    expect(j.surface).toBe("chat");
    expect(j.date).toBe("2026-10-13");
    expect(j.events.map((e) => e.id)).toEqual(["chat:e1", "chat:e2"]);
    expect(j.startOffset).toBe(0);
    expect(j.endOffset).toBe(j.fileEnd);
    expect(offsets).toEqual({});
  });

  it("增量：位点已归档前半 → 只产出后半", async () => {
    const files: Record<string, string> = {
      "2024001/chat/2026-10-13.jsonl": line(1) + line(2) + line(3),
    };
    const first = enc.encode(line(1)).length;
    const { jobs } = await planBatches(memFs(files), { "2024001/chat/2026-10-13.jsonl": first }, getIdentity);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].events.map((e) => e.id)).toEqual(["chat:e2", "chat:e3"]);
    expect(jobs[0].startOffset).toBe(first);
  });

  it("unknown/ 与旧布局顶层 surface 目录跳过；非法学号目录跳过", async () => {
    const files: Record<string, string> = {
      "unknown/edit/2026-10-13.jsonl": line(1),
      "edit/2026-10-13.jsonl": line(1), // 旧布局顶层
      "2024001/chat/2026-10-13.jsonl": line(2),
      "../evil/chat/2026-10-13.jsonl": line(3), // memFs 不含非法键则无影响
    };
    const { jobs } = await planBatches(memFs(files), {}, getIdentity);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].fileKey).toBe("2024001/chat/2026-10-13.jsonl");
  });

  it("identity.json 缺失 → 该学号整目录跳过", async () => {
    const files: Record<string, string> = {
      "2024002/chat/2026-10-13.jsonl": line(1),
      "2024001/chat/2026-10-13.jsonl": line(2),
    };
    const { jobs } = await planBatches(memFs(files), {}, getIdentity);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].identity.studentId).toBe("2024001");
  });

  it(">200 事件切多批，位点按批推进", async () => {
    let content = "";
    for (let i = 0; i < 250; i++) content += line(i);
    const files: Record<string, string> = {
      "2024001/chat/2026-10-13.jsonl": content,
    };
    const { jobs } = await planBatches(memFs(files), {}, getIdentity);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].events).toHaveLength(200);
    expect(jobs[1].events).toHaveLength(50);
    expect(jobs[0].endOffset).toBe(jobs[1].startOffset);
    expect(jobs[1].endOffset).toBe(jobs[0].fileEnd);
  });

  it("坏行跳过（不产出事件）但位点字节仍推进", async () => {
    const bad = "not-json\n";
    const files: Record<string, string> = {
      "2024001/chat/2026-10-13.jsonl": bad + line(1),
    };
    const { jobs } = await planBatches(memFs(files), {}, getIdentity);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].events.map((e) => e.id)).toEqual(["chat:e1"]);
    expect(jobs[0].endOffset).toBe(enc.encode(bad + line(1)).length);
  });

  it("文件比位点小（异常）→ 从 0 全量重传并在返回 offsets 中重置", async () => {
    const files: Record<string, string> = {
      "2024001/chat/2026-10-13.jsonl": line(9),
    };
    const { jobs, offsets } = await planBatches(
      memFs(files),
      { "2024001/chat/2026-10-13.jsonl": 99999 },
      getIdentity
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].startOffset).toBe(0);
    expect(offsets["2024001/chat/2026-10-13.jsonl"]).toBe(0);
  });

  it("尾部不完整行（写盘中）不产出、位点不含", async () => {
    const partial = line(1) + '{"id":"chat:e2","ts":"t",';
    const files: Record<string, string> = {
      "2024001/chat/2026-10-13.jsonl": partial,
    };
    const { jobs } = await planBatches(memFs(files), {}, getIdentity);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].events.map((e) => e.id)).toEqual(["chat:e1"]);
    expect(jobs[0].endOffset).toBe(enc.encode(line(1)).length);
  });

  it("位点状态文件 OFFSETS_FILE 不参与扫描", async () => {
    const files: Record<string, string> = {
      [OFFSETS_FILE]: "{}",
      "2024001/chat/2026-10-13.jsonl": line(1),
    };
    const { jobs } = await planBatches(memFs(files), {}, getIdentity);
    expect(jobs).toHaveLength(1);
  });
});
