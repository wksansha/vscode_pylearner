// src/test/archive/legacyMigrate.test.ts
// 旧平铺 L1 数据迁移：内存 fs 覆盖无身份中止、正常迁移、目标追加、幂等重跑、目录排除。
import { describe, it, expect } from "vitest";
import {
  findLegacyDirs,
  migrateLegacyTrace,
  MIGRATED_SUFFIX,
  type LegacyMigrateFs,
  type LegacyIdentity,
} from "../../archive/legacyMigrate";

const enc = new TextEncoder();
const dec = new TextDecoder();
const ID: LegacyIdentity = { studentId: "2024001", studentName: "张三", classId: "default" };
const line = (i: number) => `{"id":"run:e${i}","ts":"t","surface":"run","kind":"execution_success","payload":{}}\n`;
const MIGRATED_RUN_KEY = "run" + MIGRATED_SUFFIX + "/2026-10-13.jsonl";   // 改名备份后的键

/** 内存 fs：以文件键模拟目录树；renameDir 整体搬移前缀 */
function memFs(files: Record<string, string>): LegacyMigrateFs {
  const store = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(files)) store.set(k, enc.encode(v));
  const fs: LegacyMigrateFs = {
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
    async renameDir(from, to) {
      const fromP = from + "/", toP = to + "/";
      const moved = [...store.keys()].filter((k) => k.startsWith(fromP));
      if (moved.length === 0) throw new Error("ENOENT: " + from);
      for (const k of moved) {
        const v = store.get(k)!;
        store.delete(k);
        store.set(toP + k.slice(fromP.length), v);
      }
    },
  };
  return fs;
}

/** 从 memFs 读取若干键的内容快照（辅助断言「不动任何文件」） */
async function snapshot(fs: LegacyMigrateFs, keys: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const k of keys) {
    const b = await fs.readFileBytes(k);
    out[k] = b ? dec.decode(b) : null;
  }
  return out;
}

describe("findLegacyDirs", () => {
  it("只取 SURFACES 名目录：unknown/学号目录/*.migrated 均排除", async () => {
    const fs = memFs({
      "run/2026-10-13.jsonl": line(1),
      "edit/2026-10-13.jsonl": line(1),
      "unknown/edit/2026-10-13.jsonl": line(1),
      "2024001/run/2026-10-13.jsonl": line(1),
      [MIGRATED_RUN_KEY]: line(1),
    });
    const dirs = await findLegacyDirs(fs);
    expect(dirs.sort()).toEqual(["edit", "run"]);
  });

  it("trace/ 不存在 → 空数组", async () => {
    expect(await findLegacyDirs(memFs({}))).toEqual([]);
  });
});

describe("migrateLegacyTrace", () => {
  it("无学号或无姓名 → no-identity，不动任何文件", async () => {
    const fs = memFs({ "run/2026-10-13.jsonl": line(1) });
    const before = await snapshot(fs, ["run/2026-10-13.jsonl"]);
    expect(await migrateLegacyTrace(fs, { studentId: null, studentName: null }, ["run"])).toEqual({ kind: "no-identity" });
    expect(await migrateLegacyTrace(fs, { studentId: "2024001", studentName: null }, ["run"])).toEqual({ kind: "no-identity" });
    expect(await snapshot(fs, ["run/2026-10-13.jsonl"])).toEqual(before);
  });

  it("无平铺目录 → no-legacy", async () => {
    const fs = memFs({ "2024001/run/2026-10-13.jsonl": line(1) });
    expect(await migrateLegacyTrace(fs, ID, [])).toEqual({ kind: "no-legacy" });
  });

  it("正常迁移：追加到学号目录 + 写身份快照 + 平铺目录改名备份", async () => {
    const src = line(1) + line(2);
    const fs = memFs({
      "run/2026-10-13.jsonl": src,
      "diag/2026-10-14.jsonl": line(3),
      "run/notes.txt": "not a trace file",
    });
    const r = await migrateLegacyTrace(fs, ID, ["run", "diag"]);
    expect(r).toEqual({
      kind: "done",
      surfaces: ["run", "diag"],
      files: 2,
      renamed: ["run", "diag"],
      renameFailed: [],
    });
    expect(dec.decode((await fs.readFileBytes("2024001/run/2026-10-13.jsonl"))!)).toBe(src);
    expect(dec.decode((await fs.readFileBytes("2024001/diag/2026-10-14.jsonl"))!)).toBe(line(3));
    expect(JSON.parse(dec.decode((await fs.readFileBytes("2024001/.identity.json"))!)))
      .toEqual({ studentId: "2024001", studentName: "张三", classId: "default" });
    // 平铺目录已改名备份，且非日期文件随目录一起搬走（不迁移内容但保留原物）
    expect(await fs.readFileBytes("run/2026-10-13.jsonl")).toBeNull();
    expect(dec.decode((await fs.readFileBytes("run" + MIGRATED_SUFFIX + "/notes.txt"))!)).toBe("not a trace file");
  });

  it("目标文件已存在 → 追加且保证换行分隔", async () => {
    const fs = memFs({
      "run/2026-10-13.jsonl": line(2),
      "2024001/run/2026-10-13.jsonl": line(1),
      "edit/2026-10-13.jsonl": line(3),
      // 目标已有内容但不以 \n 结尾（半行）→ 先补换行再追加，避免粘连
      "2024001/edit/2026-10-13.jsonl": '{"id":"edit:e0"',
    });
    await migrateLegacyTrace(fs, ID, ["run", "edit"]);
    expect(dec.decode((await fs.readFileBytes("2024001/run/2026-10-13.jsonl"))!)).toBe(line(1) + line(2));
    expect(dec.decode((await fs.readFileBytes("2024001/edit/2026-10-13.jsonl"))!))
      .toBe('{"id":"edit:e0"\n' + line(3));
  });

  it("幂等重跑：改名失败后重跑重复追加事件行（服务端按事件 id 去重，安全）", async () => {
    const base = memFs({ "run/2026-10-13.jsonl": line(1) });
    const logMsgs: string[] = [];
    const fs: LegacyMigrateFs = { ...base, renameDir: async () => { throw new Error("EBUSY"); } };
    const first = await migrateLegacyTrace(fs, ID, ["run"], (m) => logMsgs.push(m));
    expect(first).toMatchObject({ kind: "done", renamed: [], renameFailed: ["run"] });
    expect(logMsgs).toHaveLength(1);
    // 重跑：目录仍在原地被再次找到，事件行重复追加——服务端按 id 幂等去重
    const second = await migrateLegacyTrace(fs, ID, ["run"], (m) => logMsgs.push(m));
    expect(second).toMatchObject({ kind: "done", files: 1 });
    expect(dec.decode((await fs.readFileBytes("2024001/run/2026-10-13.jsonl"))!)).toBe(line(1) + line(1));
  });

  it("classId 透传进身份快照；缺省补 default", async () => {
    const fs = memFs({ "run/2026-10-13.jsonl": line(1) });
    await migrateLegacyTrace(fs, { ...ID, classId: "c2" }, ["run"]);
    expect(JSON.parse(dec.decode((await fs.readFileBytes("2024001/.identity.json"))!)).classId).toBe("c2");
    const fs2 = memFs({ "run/2026-10-13.jsonl": line(1) });
    await migrateLegacyTrace(fs2, { studentId: "2024001", studentName: "张三" }, ["run"]);
    expect(JSON.parse(dec.decode((await fs2.readFileBytes("2024001/.identity.json"))!)).classId).toBe("default");
  });

  it("空文件与非日期命名文件不迁移（目录仍改名备份）", async () => {
    const fs = memFs({
      "run/2026-10-13.jsonl": "",
      "run/2026-10-14.jsonl.tmp": line(1),
      "run/2026-10-15.jsonl": line(2),
    });
    const r = await migrateLegacyTrace(fs, ID, ["run"]);
    expect(r).toEqual({ kind: "done", surfaces: ["run"], files: 1, renamed: ["run"], renameFailed: [] });
    expect(await fs.readFileBytes("2024001/run/2026-10-13.jsonl")).toBeNull();
    expect(dec.decode((await fs.readFileBytes("2024001/run/2026-10-15.jsonl"))!)).toBe(line(2));
  });
});
