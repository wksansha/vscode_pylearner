import { describe, it, expect } from "vitest";
import { shouldAutoRefresh } from "../../memory/settings";

const CFG = { minNewEntities: 20, cooldownMs: 300_000 };

describe("shouldAutoRefresh", () => {
  it("fires when both threshold and cooldown are met", () => {
    expect(shouldAutoRefresh(20, 300_000, CFG)).toBe(true);
    expect(shouldAutoRefresh(40, 600_000, CFG)).toBe(true);
  });

  it("holds when below the new-event threshold", () => {
    expect(shouldAutoRefresh(19, 600_000, CFG)).toBe(false);
  });

  it("holds when still inside the cooldown window", () => {
    expect(shouldAutoRefresh(100, 299_999, CFG)).toBe(false);
  });

  it("treats both boundaries as inclusive", () => {
    expect(shouldAutoRefresh(20, 300_000, CFG)).toBe(true);
  });
});
