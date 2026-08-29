import { describe, it, expect } from "vitest";
import {
  parseTraceLine,
  entityIdFromEventId,
  fingerprintOf,
  labelOf,
  contentOf,
  traceEventToEntity,
} from "../../snapshot/adapter";
import type { TraceEvent } from "../../events/types";

const EVENT: TraceEvent = {
  id: "edit:01HZK4ABCDEFGHJKMNPQRSTVWX",
  ts: "2026-08-29T00:00:00.000Z",
  surface: "edit",
  kind: "file_save",
  payload: { file: "main.py" },
};

describe("parseTraceLine", () => {
  it("parses a valid JSONL line", () => {
    const ev = parseTraceLine(JSON.stringify(EVENT));
    expect(ev?.id).toBe(EVENT.id);
    expect(ev?.surface).toBe("edit");
  });

  it("returns null on invalid JSON", () => {
    expect(parseTraceLine("not json {")).toBeNull();
  });

  it("returns null on missing required fields", () => {
    expect(parseTraceLine('{"foo": 1}')).toBeNull();
  });

  it("returns null on blank lines", () => {
    expect(parseTraceLine("   ")).toBeNull();
  });
});

describe("entityIdFromEventId", () => {
  it("strips the surface prefix", () => {
    expect(entityIdFromEventId("edit:abc")).toBe("abc");
  });
  it("returns the whole id when no colon", () => {
    expect(entityIdFromEventId("abc")).toBe("abc");
  });
});

describe("fingerprintOf", () => {
  it("is deterministic", () => {
    expect(fingerprintOf(EVENT)).toBe(fingerprintOf(EVENT));
  });
  it("differs across content", () => {
    expect(fingerprintOf(EVENT)).not.toBe(fingerprintOf({ ...EVENT, kind: "other" }));
  });
});

describe("labelOf", () => {
  it("prefers the file payload field", () => {
    expect(labelOf(EVENT)).toBe("file_save main.py");
  });
  it("falls back to kind when no preferred field", () => {
    expect(labelOf({ ...EVENT, payload: { n: 1 } })).toBe("file_save");
  });
});

describe("contentOf", () => {
  it("renders kind header and payload fields", () => {
    const out = contentOf(EVENT);
    expect(out).toContain("### file_save");
    expect(out).toContain("file: main.py");
  });
});

describe("traceEventToEntity", () => {
  it("maps id/ts/content/metadata", () => {
    const entity = traceEventToEntity(EVENT);
    expect(entity.id).toBe("01HZK4ABCDEFGHJKMNPQRSTVWX");
    expect(entity.ts).toBe(EVENT.ts);
    expect(entity.content).toContain("file_save");
    expect(entity.metadata.kind).toBe("file_save");
  });

  it("carries session_id into metadata when present", () => {
    const entity = traceEventToEntity({ ...EVENT, session_id: "sess-1" });
    expect(entity.metadata.session_id).toBe("sess-1");
  });
});
