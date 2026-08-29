import { describe, it, expect } from "vitest";
import {
  META_VERSION,
  newL2Meta,
  newL3Meta,
  diffNewRefs,
  parseL2Meta,
  serializeL2Meta,
  parseL3Meta,
  serializeL3Meta,
} from "../../memory/meta";

describe("new meta factories", () => {
  it("creates empty L2 meta", () => {
    expect(newL2Meta()).toEqual({ last_update_at: null, seen_entity_refs: [] });
  });
  it("creates empty L3 meta", () => {
    expect(newL3Meta()).toEqual({ last_update_at: null, seen_l2_entry_ids: {} });
  });
});

describe("diffNewRefs", () => {
  it("returns refs not present in seen", () => {
    const seen = new Set(["e:1", "e:2"]);
    expect(diffNewRefs(["e:1", "e:3", "e:4"], seen)).toEqual(["e:3", "e:4"]);
  });
  it("returns [] when all seen", () => {
    expect(diffNewRefs(["e:1"], new Set(["e:1"]))).toEqual([]);
  });
});

describe("L2 meta (de)serialization", () => {
  it("round-trips through JSON", () => {
    const meta = { last_update_at: "2026-08-29T10:00:00Z", seen_entity_refs: ["e:2", "e:1"] };
    const json = JSON.stringify(serializeL2Meta(meta));
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(META_VERSION);
    expect(parseL2Meta(parsed)).toEqual({
      last_update_at: "2026-08-29T10:00:00Z",
      seen_entity_refs: ["e:1", "e:2"], // sorted
    });
  });

  it("returns fresh meta on missing/corrupt input", () => {
    expect(parseL2Meta(null)).toEqual(newL2Meta());
    expect(parseL2Meta(42)).toEqual(newL2Meta());
    expect(parseL2Meta({ seen_entity_refs: "nope" })).toEqual(newL2Meta());
  });

  it("drops non-string refs", () => {
    expect(parseL2Meta({ seen_entity_refs: ["e:1", 5, "e:2"] })).toEqual({
      last_update_at: null,
      seen_entity_refs: ["e:1", "e:2"],
    });
  });
});

describe("L3 meta (de)serialization", () => {
  it("round-trips through JSON", () => {
    const meta = {
      last_update_at: "2026-08-29T10:00:00Z",
      seen_l2_entry_ids: { python: ["m_a", "m_b"], git: ["m_c"] },
    };
    const parsed = parseL3Meta(JSON.parse(JSON.stringify(serializeL3Meta(meta))));
    expect(parsed.last_update_at).toBe("2026-08-29T10:00:00Z");
    expect(parsed.seen_l2_entry_ids.python).toEqual(["m_a", "m_b"]);
    expect(parsed.seen_l2_entry_ids.git).toEqual(["m_c"]);
  });

  it("returns fresh meta on missing/corrupt input", () => {
    expect(parseL3Meta(null)).toEqual(newL3Meta());
    expect(parseL3Meta("x")).toEqual(newL3Meta());
    expect(parseL3Meta({ seen_l2_entry_ids: ["not", "a", "map"] })).toEqual(newL3Meta());
  });

  it("drops non-string ids within a surface", () => {
    expect(
      parseL3Meta({ seen_l2_entry_ids: { python: ["m_a", 3, "m_b"] } })
    ).toEqual({
      last_update_at: null,
      seen_l2_entry_ids: { python: ["m_a", "m_b"] },
    });
  });
});
