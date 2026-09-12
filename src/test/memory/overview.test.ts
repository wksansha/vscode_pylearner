import { describe, it, expect } from "vitest";
import { l3OverviewFileName } from "../../memory/paths";
import { parse, renderDisplay, pickProfileView } from "../../memory/document";

const U1 = "01HZK4ABCDEFGHJKMNPQRSTVWX";
const SAMPLE = `# Python Learner Profile

## Strengths
- Uses list comprehensions frequently [^1] <!--m_${U1}-->

---

[^1]: edit:${U1}
`;

describe("overview storage + view selection", () => {
  it("names the overview file after the slot", () => {
    expect(l3OverviewFileName("profile")).toBe("profile-overview.md");
  });

  it("pickProfileView prefers the overview when present", () => {
    const doc = parse(SAMPLE);
    const overview = "## 总评\n\n处于入门初期。";
    expect(pickProfileView(overview, doc)).toBe(overview);
  });

  it("falls back to renderDisplay when overview is null or blank", () => {
    const doc = parse(SAMPLE);
    expect(pickProfileView(null, doc)).toBe(renderDisplay(doc));
    expect(pickProfileView("   \n  ", doc)).toBe(renderDisplay(doc));
  });

  it("returns null when both overview and doc are missing", () => {
    expect(pickProfileView(null, null)).toBeNull();
  });
});
