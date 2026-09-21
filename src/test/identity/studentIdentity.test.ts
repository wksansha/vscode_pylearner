import { describe, it, expect } from "vitest";
import {
  loadStudentIdentity,
  hasStudentIdentity,
  saveStudentIdentity,
  migrateLegacyIdentity,
  validateStudentId,
  validateStudentName,
  type KeyValueStore,
} from "../../identity/studentIdentity";
import { STATE_KEYS } from "../../constants";

function fakeStore(initial: Record<string, unknown> = {}): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    get: (key: string) => data.get(key),
    update: (key: string, value: unknown) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

describe("studentIdentity（存储/校验）", () => {
  it("空存储 → 身份为 null", () => {
    const id = loadStudentIdentity(fakeStore());
    expect(id.studentId).toBeNull();
    expect(id.studentName).toBeNull();
    expect(hasStudentIdentity(fakeStore())).toBe(false);
  });

  it("保存后可读取（trim）", async () => {
    const store = fakeStore();
    await saveStudentIdentity(store, { studentId: " 20240101 ", studentName: " 张三 " });
    expect(loadStudentIdentity(store)).toEqual({ studentId: "20240101", studentName: "张三" });
    expect(hasStudentIdentity(store)).toBe(true);
  });

  it("非法类型/空值不算已设置", () => {
    expect(hasStudentIdentity(fakeStore({ [STATE_KEYS.studentId]: "" }))).toBe(false);
    expect(hasStudentIdentity(fakeStore({ [STATE_KEYS.studentId]: 123 }))).toBe(false);
  });

  it("校验：非空、≤32 字符", () => {
    expect(validateStudentId("   ")).toBeDefined();
    expect(validateStudentId("20240101")).toBeUndefined();
    expect(validateStudentId("x".repeat(33))).toBeDefined();
    expect(validateStudentName("")).toBeDefined();
    expect(validateStudentName("张三")).toBeUndefined();
    expect(validateStudentName("n".repeat(33))).toBeDefined();
  });

  it("迁移：globalState 为空且 secrets 有值 → 拷贝；已有值 → 不动", async () => {
    const emptyState = fakeStore();
    const secretsWithLegacy = {
      get: async (key: string) => key === "pylearner.student.id" ? "20240999" : "旧名字",
    };
    expect(await migrateLegacyIdentity(emptyState, secretsWithLegacy, {
      studentId: "pylearner.student.id",
      studentName: "pylearner.student.name",
    })).toBe(true);
    expect(loadStudentIdentity(emptyState)).toEqual({ studentId: "20240999", studentName: "旧名字" });

    // 已有身份时不再迁移
    const filled = fakeStore({ [STATE_KEYS.studentId]: "20240101", [STATE_KEYS.studentName]: "张三" });
    expect(await migrateLegacyIdentity(filled, secretsWithLegacy, {
      studentId: "pylearner.student.id",
      studentName: "pylearner.student.name",
    })).toBe(false);
    expect(loadStudentIdentity(filled).studentId).toBe("20240101");

    // secrets 里没有 → 不迁移
    expect(await migrateLegacyIdentity(fakeStore(), { get: async () => undefined }, {
      studentId: "pylearner.student.id",
      studentName: "pylearner.student.name",
    })).toBe(false);
  });
});
