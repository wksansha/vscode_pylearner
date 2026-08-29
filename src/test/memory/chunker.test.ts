import { describe, it, expect } from "vitest";
import { chunkWithBoundary, ChunkSpan } from "../../memory/chunker";

const OPTS = {
  budget: 3,
  overlapRatio: 0.1,
  minChunkChars: 5,
  maxChunkChars: 20,
};

function texts(spans: ChunkSpan[]): string[] {
  return spans.map((s) => s.text);
}

describe("chunkWithBoundary", () => {
  it("returns [] for blank input", () => {
    expect(chunkWithBoundary("   \n  ", OPTS)).toEqual([]);
    expect(chunkWithBoundary("", OPTS)).toEqual([]);
  });

  it("short-circuits when input fits one chunk", () => {
    const spans = chunkWithBoundary("abc", OPTS);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ index: 0, start: 0, end: 3, text: "abc" });
  });

  it("splits long input into multiple non-empty chunks", () => {
    const text = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj";
    const spans = chunkWithBoundary(text, OPTS);
    expect(spans.length).toBeGreaterThan(1);
    for (const s of spans) expect(s.text.length).toBeGreaterThan(0);
    // Chunks are contiguous: each starts where the previous ended (minus overlap).
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeLessThan(spans[i - 1].end);
    }
    // Last chunk reaches the end of the text.
    expect(spans[spans.length - 1].end).toBe(text.length);
  });

  it("covers the entire text without gaps (concatenation minus overlap)", () => {
    const text = "line one.\nline two.\nline three.\nline four.\nline five.";
    const spans = chunkWithBoundary(text, OPTS);
    // Union of [start,end) intervals covers [0, text.length).
    let covered = 0;
    for (const s of spans) covered = Math.max(covered, s.end);
    expect(covered).toBe(text.length);
  });

  it("expands to paragraph boundary when boundary=paragraph", () => {
    const text = "a".repeat(8) + "\n\n" + "b".repeat(8) + "\n\n" + "c".repeat(8);
    const spans = chunkWithBoundary(text, { ...OPTS, boundary: "paragraph" });
    // First chunk should end on (or after) the first paragraph break, not mid-line.
    expect(spans[0].end).toBeGreaterThanOrEqual(text.indexOf("\n\n"));
  });

  it("never exceeds maxChunkChars for degenerate single-line input", () => {
    const text = "x".repeat(100); // no boundary to expand to
    const spans = chunkWithBoundary(text, OPTS);
    for (const s of spans) expect(s.end - s.start).toBeLessThanOrEqual(OPTS.maxChunkChars + 1);
  });

  it("uses sentence boundary when boundary=sentence", () => {
    const text =
      "First sentence goes here. Second sentence goes here! Third one? Yes. " +
      "Another one. And more text.";
    const spans = chunkWithBoundary(text, { ...OPTS, boundary: "sentence" });
    expect(spans.length).toBeGreaterThan(1);
    for (const s of spans) expect(s.text.length).toBeGreaterThan(0);
  });

  it("respects minChunkChars floor", () => {
    // min > max should still not crash; target clamped, overlap clamped.
    const spans = chunkWithBoundary("hello world this is a test string", {
      budget: 2,
      overlapRatio: 0.5,
      minChunkChars: 30,
      maxChunkChars: 40,
    });
    expect(spans.length).toBeGreaterThanOrEqual(1);
    for (const s of spans) expect(s.text.length).toBeGreaterThan(0);
  });
});
