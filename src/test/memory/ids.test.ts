import { describe, it, expect } from "vitest";
import {
  newEntryId,
  newTraceId,
  isEntryId,
  isTraceId,
  isSnapshotRef,
  isShortnameRef,
  isValidRef,
} from "../../memory/ids";

describe("ids", () => {
  it("newEntryId generates a valid entry id", () => {
    const id = newEntryId();
    expect(id.startsWith("m_")).toBe(true);
    expect(isEntryId(id)).toBe(true);
  });

  it("newTraceId adds a surface prefix and validates", () => {
    const id = newTraceId("edit");
    expect(id.startsWith("edit:")).toBe(true);
    expect(isTraceId(id)).toBe(true);
  });

  it("isValidRef accepts all four reference forms", () => {
    expect(isValidRef("m_01HZK4ABCDEFGHJKMNPQRSTVWX")).toBe(true); // entry
    expect(isValidRef("edit:01HZK4ABCDEFGHJKMNPQRSTVWX")).toBe(true); // trace
    expect(isValidRef("chat:session-abc")).toBe(true); // snapshot
    expect(isValidRef("chat")).toBe(true); // shortname (L3 surface ref)
  });

  it("rejects malformed refs", () => {
    expect(isValidRef("")).toBe(false);
    expect(isValidRef("not-an-id")).toBe(false);
    expect(isValidRef("m_short")).toBe(false);
    expect(isValidRef("Chat")).toBe(false); // shortnames are lowercase
  });

  it("isShortnameRef uses the P1 surface whitelist", () => {
    expect(isShortnameRef("chat")).toBe(true);
    expect(isShortnameRef("run")).toBe(true);
    expect(isShortnameRef("notebook")).toBe(false); // not a P1 surface
  });

  it("isSnapshotRef accepts ids with embedded punctuation but not bare names", () => {
    expect(isSnapshotRef("chat:session-abc")).toBe(true);
    expect(isSnapshotRef("chat")).toBe(false);
  });
});
