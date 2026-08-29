import { describe, it, expect } from "vitest";
import { extractJsonObject, parseFacts } from "../../memory/parse";

describe("extractJsonObject", () => {
  it("extracts a bare JSON object", () => {
    expect(extractJsonObject('{"a": 1}')).toBe('{"a": 1}');
  });

  it("strips surrounding code fences", () => {
    expect(extractJsonObject('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it("finds the object amid prose framing", () => {
    const raw = 'Here is the result: {"a": 1} hope this helps';
    expect(extractJsonObject(raw)).toBe('{"a": 1}');
  });

  it("handles nested braces by finding first { and last }", () => {
    const raw = '{"outer": {"inner": 2}}';
    expect(extractJsonObject(raw)).toBe('{"outer": {"inner": 2}}');
  });

  it("returns null when no object present", () => {
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("[1, 2]")).toBeNull();
  });
});

describe("parseFacts", () => {
  it("parses a well-formed facts envelope", () => {
    const raw = JSON.stringify({
      facts: [
        { text: "uses pytest", section: "tools", refs: ["e:1", "e:2"] },
        { text: "prefers async", section: "preferences", refs: [] },
      ],
    });
    const facts = parseFacts(raw);
    expect(facts).toEqual([
      { text: "uses pytest", section: "tools", refs: ["e:1", "e:2"] },
      { text: "prefers async", section: "preferences", refs: [] },
    ]);
  });

  it("tolerates code fences and prose", () => {
    const raw = '```json\n{"facts":[{"text":"hi","section":"s","refs":["e:1"]}]}\n```';
    expect(parseFacts(raw)).toEqual([{ text: "hi", section: "s", refs: ["e:1"] }]);
  });

  it("skips malformed items", () => {
    const raw = JSON.stringify({
      facts: [
        { text: "", section: "s", refs: [] },
        { text: 42, section: "s", refs: [] },
        { text: "ok", section: "s", refs: ["e:1", 7, "e:2"] },
      ],
    });
    const facts = parseFacts(raw);
    expect(facts).toEqual([{ text: "ok", section: "s", refs: ["e:1", "e:2"] }]);
  });

  it("returns [] on invalid JSON", () => {
    expect(parseFacts("not json {")).toEqual([]);
    expect(parseFacts("")).toEqual([]);
  });

  it("returns [] when facts key missing or not an array", () => {
    expect(parseFacts('{"facts": "nope"}')).toEqual([]);
    expect(parseFacts('{"ops": []}')).toEqual([]);
  });

  it("trims text and section whitespace", () => {
    const raw = JSON.stringify({
      facts: [{ text: "  padded text  ", section: "  padded section  ", refs: [" e:1 "] }],
    });
    expect(parseFacts(raw)).toEqual([
      { text: "padded text", section: "padded section", refs: ["e:1"] },
    ]);
  });
});
