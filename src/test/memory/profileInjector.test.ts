import { describe, it, expect } from "vitest";
import { injectProfile } from "../../memory/profileInjector";

describe("injectProfile", () => {
  it("returns the base prompt unchanged when profile is empty", () => {
    expect(injectProfile("base", null)).toBe("base");
    expect(injectProfile("base", "   ")).toBe("base");
  });

  it("injects the profile into the system prompt", () => {
    const out = injectProfile("You are a Python tutor", "# Profile\n- Prefers examples");
    expect(out).toContain("## Learner Profile");
    expect(out).toContain("Prefers examples");
    expect(out.startsWith("You are a Python tutor")).toBe(true);
  });

  it("truncates the profile to the budget", () => {
    const long = "x".repeat(1000);
    const out = injectProfile("base", long, { profileBudget: 10 });
    expect(out).not.toContain("x".repeat(20));
    expect(out.length).toBeLessThan("base".length + 10 + 300);
  });
});
