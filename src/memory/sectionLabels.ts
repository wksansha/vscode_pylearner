// Chinese labels for the English section names used as schema keys in
// L2/L3 documents. The on-disk section names stay English (they are the
// stable keys the parser/serializer round-trip on), but every view that
// reaches a human — profile panel, raw audit dump — renders them in Chinese.
//
// Two views of the same document:
//   renderRaw()     — labels + every entry + entry-id anchors + footnotes
//                     (audit trail; what you get when you open profile.md)
//   renderDisplay() — labels, no Identity section, no ids/footnotes
//                     (what a teacher or student reads)

const SECTION_LABELS: Record<string, string> = {
  // L3 profile slot sections
  Identity: "身份信息",
  "Learning style": "学习风格",
  "Knowledge level": "知识水平",
  // L3 scope slot sections
  Familiar: "已掌握",
  Practicing: "练习中",
  Unsure: "不确定",
  // L3 recent slot sections
  "This week": "本周",
  Earlier: "更早",
  // L3 preferences slot
  Preferences: "偏好",
  // L2 edit sections
  Patterns: "模式",
  Habits: "习惯",
  Topics: "主题",
  // L2 run sections
  "Error patterns": "错误模式",
  // L2 chat sections
  Misconceptions: "误解",
  Mastery: "掌握",
  // L2 diag sections
  Issues: "问题",
};

/** Translate a schema section name to its Chinese label (falls back to the
 *  original if the name is unknown, so new sections never crash the view). */
export function sectionLabel(name: string): string {
  return SECTION_LABELS[name] ?? name;
}