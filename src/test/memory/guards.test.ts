import { describe, it, expect } from "vitest";
import { BANNED_PHRASES, hasBanned, opText, filterBanned } from "../../memory/guards";
import type { Op } from "../../memory/ops";

const add = (text: string): Op => ({ op: "add", section: "habits", text, refs: ["e:1"] });
const edit = (text: string): Op => ({
  op: "edit",
  target_id: "m_0123456789ABCDEFGHJKMNPQRS",
  new_text: text,
  new_refs: ["e:1"],
});
const del: Op = { op: "delete", target_id: "m_0123456789ABCDEFGHJKMNPQRS", reason: "stale" };

describe("BANNED_PHRASES", () => {
  it("contains English and Chinese absolutes", () => {
    expect(BANNED_PHRASES).toContain("always");
    expect(BANNED_PHRASES).toContain("完美掌握");
  });
});

describe("hasBanned", () => {
  it("detects a banned phrase in plain text", () => {
    expect(hasBanned("The learner always writes tests")).toBe(true);
    expect(hasBanned("该学习者总是迟到")).toBe(true);
  });

  it("is case-insensitive for English phrases", () => {
    expect(hasBanned("the user ALWAYS checks in")).toBe(true);
  });

  it("does not flag a banned phrase inside quotes", () => {
    expect(hasBanned('user said "I always run tests"')).toBe(false);
    expect(hasBanned("用户说「我总是写测试」")).toBe(false);
  });

  it("flags a banned phrase outside quotes even when one is inside", () => {
    expect(hasBanned('user said "hi" and always fails')).toBe(true);
  });

  it("returns false for clean text", () => {
    expect(hasBanned("The learner writes tests on weekdays")).toBe(false);
  });
});

describe("opText", () => {
  it("reads add.text", () => {
    expect(opText(add("hello"))).toBe("hello");
  });
  it("reads edit.new_text", () => {
    expect(opText(edit("world"))).toBe("world");
  });
  it("returns empty for delete", () => {
    expect(opText(del)).toBe("");
  });
});

describe("filterBanned", () => {
  it("drops ops with banned text but keeps clean ones", () => {
    const ops: Op[] = [add("clean fact"), edit("user always skips"), del];
    const result = filterBanned(ops);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ op: "add" });
    expect(result[1]).toMatchObject({ op: "delete" });
  });

  it("keeps an op whose banned phrase is fully quoted", () => {
    const result = filterBanned([add('user wrote "I never skip"')]);
    expect(result).toHaveLength(1);
  });
});
