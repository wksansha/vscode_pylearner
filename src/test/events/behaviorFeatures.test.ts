import { describe, it, expect } from "vitest";
import {
  extractTypingSession,
  normalizeDiagMsg,
  detectConstructs,
  type BehaviorChangeRecord,
  type BehaviorDiagSnapshot,
} from "../../events/behaviorFeatures";

const multiLineFile = [
  "x = 1", "y = 2", "z = 3", "a = 4", "b = 5",
  "c = 6", "d = 7", "e = 8", "f = 9", "g = 10", "h = 11",
  "for i in range(10)", "    print(i)", "",
].join("\n");

describe("extractTypingSession: fast-typing-with-random-errors", () => {
  // 手滑:秒级删改重打、错误分散、结尾无未解决错误
  const changes: BehaviorChangeRecord[] = [
    { t: 0, line: 1, ins: 1, del: 0 },
    { t: 400, line: 1, ins: 0, del: 1 },
    { t: 700, line: 1, ins: 1, del: 0 },
    { t: 1100, line: 5, ins: 1, del: 0 },
    { t: 1500, line: 8, ins: 1, del: 0 },
    { t: 1600, line: 8, ins: 0, del: 1 },
    { t: 2000, line: 8, ins: 1, del: 0 },
  ];
  const diagnostics: BehaviorDiagSnapshot[] = [
    { t: 500, errors: ["name 'x' is not defined (main.py, line 1)"] },
    { t: 1200, errors: ["TypeError: bad operand type (main.py, line 5)"] },
    { t: 1900, errors: [] },
  ];

  const payload = extractTypingSession({
    file: "main.py",
    startMs: 0,
    endMs: 3000,
    endedBy: "editor_switch",
    truncated: false,
    changes,
    diagnostics,
    finalText: "x = 1",
  });

  it("has low hesitations and no paste reliance", () => {
    expect(payload.typing.hesitations_5s).toBe(0);
    expect(payload.paste_like_inserts).toBe(0);
    expect(payload.typing.gap_median_ms).toBeLessThan(1000);
  });

  it("aggregates scattered errors without recurrence and no unresolved", () => {
    expect(payload.diagnostics.errors_seen).toHaveLength(2);
    expect(payload.diagnostics.errors_seen[0].recurred).toBe(0);
    expect(payload.diagnostics.errors_seen[0].fixed).toBe(true);
    expect(payload.diagnostics.unresolved).toBe(0);
  });

  it("computes typing totals", () => {
    expect(payload.typing.changes).toBe(7);
    expect(payload.typing.insert_chars).toBe(5);
    expect(payload.typing.delete_chars).toBe(2);
    expect(payload.duration_ms).toBe(3000);
    expect(payload.ended_by).toBe("editor_switch");
  });
});

describe("extractTypingSession: for-loop struggle (spec §四 walkthrough)", () => {
  const changes: BehaviorChangeRecord[] = [
    { t: 0, line: 12, ins: 10, del: 0 },
    { t: 40_000, line: 12, ins: 0, del: 6 },
    { t: 42_000, line: 12, ins: 8, del: 0 },
    { t: 120_000, line: 13, ins: 12, del: 0 },
    { t: 222_000, line: 12, ins: 0, del: 1 },
    { t: 240_000, line: 12, ins: 4, del: 0 },
    { t: 260_000, line: 5, ins: 2, del: 0 },
  ];
  const diagnostics: BehaviorDiagSnapshot[] = [
    { t: 120_000, errors: ["expected ':' (main.py, line 12)"] },
    { t: 165_000, errors: [] },
    { t: 300_000, errors: ["expected ':' (main.py, line 13)"] }, // 不同行号 → 同一错误复发
  ];

  const payload = extractTypingSession({
    file: "main.py",
    startMs: 0,
    endMs: 560_000, // idle 结束:最后变更 260s + 空闲 300s
    endedBy: "idle",
    truncated: false,
    changes,
    diagnostics,
    finalText: multiLineFile,
  });

  it("clusters hot regions on the 3-line bucket containing the for loop", () => {
    // 桶按 3 行划分:行 12 → 桶 10-12(5 touches),行 13 → 桶 13-15(1),
    // 行 5 → 桶 4-6(1);top-3 全保留,touches 并列时按起始行升。
    expect(payload.hot_regions).toHaveLength(3);
    expect(payload.hot_regions[0].lines).toBe("10-12");
    expect(payload.hot_regions[1].lines).toBe("4-6");
    expect(payload.hot_regions[2].lines).toBe("13-15");
    expect(payload.hot_regions[0].touches).toBe(5);
    expect(payload.hot_regions[0].insert_chars).toBe(22);
    expect(payload.hot_regions[0].delete_chars).toBe(7);
    expect(payload.hot_regions[0].constructs).toContain("for");
    expect(payload.hot_regions[0].final_text).toContain("for i in range(10)");
    expect(payload.hot_regions[0].final_text).toContain("\n");
  });

  it("counts the trailing idle gap into max gap and hesitations", () => {
    // gaps: 40000,2000,78000,102000,18000,20000 + 尾随 300000
    expect(payload.typing.max_gap_ms).toBe(300_000);
    expect(payload.typing.hesitations_5s).toBe(6);
    // median of [2000,18000,20000,40000,78000,102000,300000] → idx 3 = 40000
    expect(payload.typing.gap_median_ms).toBe(40_000);
    // p90 nearest-rank: ceil(0.9*7)-1 = idx 6 → 300000
    expect(payload.typing.gap_p90_ms).toBe(300_000);
  });

  it("aggregates recurrence across different line numbers", () => {
    const seen = payload.diagnostics.errors_seen;
    expect(seen).toHaveLength(1);
    expect(seen[0].msg).toBe("expected ':'");
    expect(seen[0].first_rel_ms).toBe(120_000);
    expect(seen[0].fixed).toBe(true);
    expect(seen[0].latency_ms).toBe(45_000); // 165s 消失 - 120s 首现
    expect(seen[0].recurred).toBe(1);        // 300s 复发一次
    expect(payload.diagnostics.unresolved).toBe(1); // 结束时最后快照仍有错误
  });
});

describe("extractTypingSession: paste-heavy session", () => {
  it("counts inserts >= 5 chars as paste-like (incl. long IME comments)", () => {
    const payload = extractTypingSession({
      file: "main.py",
      startMs: 0,
      endMs: 60_000,
      endedBy: "editor_close",
      truncated: false,
      changes: [
        { t: 0, line: 1, ins: 40, del: 0 },
        { t: 30_000, line: 2, ins: 60, del: 0 },
        { t: 60_000, line: 3, ins: 20, del: 0 }, // IME 中文注释长插入,同样计入
      ],
      diagnostics: [],
      finalText: "# 注释\n# 注释\n# 注释",
    });
    expect(payload.paste_like_inserts).toBe(3);
  });

  it("does not count <= 4 char inserts (typing aids: brackets, auto-indent)", () => {
    const payload = extractTypingSession({
      file: "main.py",
      startMs: 0,
      endMs: 10_000,
      endedBy: "editor_close",
      truncated: false,
      changes: [
        { t: 0, line: 1, ins: 4, del: 0 },
        { t: 5_000, line: 1, ins: 1, del: 0 },
        { t: 9_000, line: 1, ins: 2, del: 0 },
      ],
      diagnostics: [],
      finalText: "x = (",
    });
    expect(payload.paste_like_inserts).toBe(0);
  });
});

describe("extractTypingSession: edge cases", () => {
  it("handles a single change (no gaps) without crashing", () => {
    const payload = extractTypingSession({
      file: "main.py",
      startMs: 0,
      endMs: 5_000,
      endedBy: "editor_close",
      truncated: false,
      changes: [{ t: 0, line: 1, ins: 3, del: 0 }],
      diagnostics: [],
      finalText: "abc",
    });
    expect(payload.typing.gap_median_ms).toBe(0);
    expect(payload.typing.gap_p90_ms).toBe(0);
    expect(payload.typing.max_gap_ms).toBe(0);
    expect(payload.typing.hesitations_5s).toBe(0);
    expect(payload.diagnostics.errors_seen).toEqual([]);
    expect(payload.diagnostics.unresolved).toBe(0);
  });

  it("does not count trailing idle gap for non-idle endings", () => {
    const payload = extractTypingSession({
      file: "main.py",
      startMs: 0,
      endMs: 400_000,
      endedBy: "editor_switch",
      truncated: false,
      changes: [
        { t: 0, line: 1, ins: 2, del: 0 },
        { t: 100_000, line: 1, ins: 2, del: 0 },
      ],
      diagnostics: [],
      finalText: "ab",
    });
    // gaps 只有 [100000];尾随 300s 不计入
    expect(payload.typing.max_gap_ms).toBe(100_000);
    expect(payload.typing.hesitations_5s).toBe(1);
  });

  it("flags truncated sessions and keeps change count at the cap boundary", () => {
    const changes: BehaviorChangeRecord[] = Array.from({ length: 5001 }, (_, i) => ({
      t: i,
      line: 1,
      ins: 1,
      del: 0,
    }));
    const payload = extractTypingSession({
      file: "main.py",
      startMs: 0,
      endMs: 6000,
      endedBy: "idle",
      truncated: true, // tracker 超上限后置位;features 只透传
      changes,
      diagnostics: [],
      finalText: "a",
    });
    expect(payload.truncated).toBe(true);
    expect(payload.typing.changes).toBe(5001); // features 不截断,截断是 tracker 的职责
  });
});

describe("normalizeDiagMsg", () => {
  it("strips file/line location suffixes and lowercases", () => {
    expect(normalizeDiagMsg("expected ':' (main.py, line 12)")).toBe("expected ':'");
    expect(normalizeDiagMsg("SyntaxError: invalid syntax (main.py, line 3)")).toBe(
      "syntaxerror: invalid syntax"
    );
  });

  it("aggregates the same error across different files and lines", () => {
    expect(normalizeDiagMsg("expected ':' (a.py, line 1)")).toBe(
      normalizeDiagMsg("expected ':' (b.py, line 99)")
    );
  });

  it("returns null for empty-after-normalization messages", () => {
    expect(normalizeDiagMsg("   ")).toBeNull();
    expect(normalizeDiagMsg("(main.py, line 3)")).toBeNull();
  });
});

describe("detectConstructs", () => {
  it("detects for-loops and f-strings in a region", () => {
    const text = 'for i in range(10):\n    print(f"item {i}")';
    const tags = detectConstructs(text);
    expect(tags).toContain("for");
    expect(tags).toContain("f-string");
    expect(tags).not.toContain("while");
  });

  it("matches multiple constructs and keeps the fixed order", () => {
    const tags = detectConstructs("data = {k: v for k, v in items}\nslice = xs[1:5]");
    expect(tags).toEqual(["for", "dict", "slicing"]);
  });

  it("does not mistake keywords inside identifiers (if → f-string)", () => {
    expect(detectConstructs('if("x"):')).not.toContain("f-string");
  });
});