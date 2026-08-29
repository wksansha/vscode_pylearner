// Op-emit guards: banned-phrase filter.
//
// The L3 objectivity guard drops any op whose text contains an absolutist
// phrase (outside quoted user verbatim 「…」 / "…"). The quote exemption
// matters because verbatim user quotations may legitimately contain
// otherwise-banned absolutes — quoting the user is fact, not judgment.

import type { Op } from "./ops";

// Banned absolute phrases, bilingual. Tune against real prompt regressions.
export const BANNED_PHRASES: readonly string[] = [
  // English absolutes
  "deeply",
  "truly",
  "mastered",
  "expert in",
  "passionate",
  "loves",
  "hates",
  "always",
  "never",
  "fully understands",
  // Chinese absolutes
  "深刻",
  "彻底",
  "完美掌握",
  "完美理解",
  "完全理解",
  "完全掌握",
  "专家",
  "热爱",
  "总是",
  "从来不",
];

const _QUOTED_RE = /「[^」]*」|"[^"]*"/g;

/** True iff a banned phrase appears outside every quoted region. */
export function hasBanned(text: string): boolean {
  const stripped = text.replace(_QUOTED_RE, "").toLowerCase();
  return BANNED_PHRASES.some((phrase) => stripped.includes(phrase));
}

export function opText(op: Op): string {
  if (op.op === "add") return op.text;
  if (op.op === "edit") return op.new_text;
  return "";
}

/** Drop ops whose text contains banned absolutist phrasing. */
export function filterBanned(ops: Op[]): Op[] {
  return ops.filter((op) => {
    const text = opText(op);
    return !(text && hasBanned(text));
  });
}
