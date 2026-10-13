import { describe, it, expect } from "vitest";
import {
  UNKNOWN_DIR,
  studentDirName,
  isArchivableDirName,
} from "../../archive/identity";
import {
  offsetsKey,
  parseOffsets,
  serializeOffsets,
} from "../../archive/archiveState";

describe("studentDirName", () => {
  it("合法学号原样返回", () => {
    expect(studentDirName("2024001")).toBe("2024001");
    expect(studentDirName("abc_123-X")).toBe("abc_123-X");
  });
  it("空/未设身份 → unknown", () => {
    expect(studentDirName(null)).toBe(UNKNOWN_DIR);
    expect(studentDirName(undefined)).toBe(UNKNOWN_DIR);
    expect(studentDirName("")).toBe(UNKNOWN_DIR);
    expect(studentDirName("   ")).toBe(UNKNOWN_DIR);
  });
  it("非法字符（路径穿越/点/斜杠）→ unknown", () => {
    expect(studentDirName("../etc")).toBe(UNKNOWN_DIR);
    expect(studentDirName("2024.01")).toBe(UNKNOWN_DIR);
    expect(studentDirName("a/b")).toBe(UNKNOWN_DIR);
  });
  it("保留字与 surface 名冲突 → unknown", () => {
    expect(studentDirName("unknown")).toBe(UNKNOWN_DIR);
    expect(studentDirName("edit")).toBe(UNKNOWN_DIR);
    expect(studentDirName("diag")).toBe(UNKNOWN_DIR);
  });
  it("超长 → unknown", () => {
    expect(studentDirName("a".repeat(33))).toBe(UNKNOWN_DIR);
    expect(studentDirName("a".repeat(32))).toBe("a".repeat(32));
  });
});

describe("isArchivableDirName", () => {
  it("学号目录 true；unknown/旧布局 surface 目录/非法名 false", () => {
    expect(isArchivableDirName("2024001")).toBe(true);
    expect(isArchivableDirName("unknown")).toBe(false);
    expect(isArchivableDirName("edit")).toBe(false);
    expect(isArchivableDirName("../x")).toBe(false);
    expect(isArchivableDirName("a".repeat(33))).toBe(false);
  });
});

describe("archiveState", () => {
  it("offsetsKey 组装与 parse/serialize 往返", () => {
    expect(offsetsKey("2024001", "edit", "2026-10-13")).toBe("2024001/edit/2026-10-13.jsonl");
    const offsets = { "2024001/edit/2026-10-13.jsonl": 123 };
    expect(parseOffsets(serializeOffsets(offsets))).toEqual(offsets);
  });
  it("parseOffsets 容错：null/坏 JSON/非法值 → 空或过滤", () => {
    expect(parseOffsets(null)).toEqual({});
    expect(parseOffsets("not json")).toEqual({});
    expect(parseOffsets(JSON.stringify({ a: 1, b: "x", c: -1, d: Infinity }))).toEqual({ a: 1 });
  });
});
