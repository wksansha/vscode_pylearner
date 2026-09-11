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
  // Dynamic topic sections the L2/L3 prompts steer the LLM toward
  // (prompts.ts DYNAMIC SECTIONS example list). Unknown sections fall back
  // to their English name via sectionLabel.
  "Import Syntax": "导入语法",
  "Variable Scope": "变量作用域",
  "Loop Control": "循环控制",
  "Function Definition": "函数定义",
  "Error Handling": "错误处理",
  "Data Structures": "数据结构",
  "String Manipulation": "字符串操作",
  "List Operations": "列表操作",
  "Dictionary Usage": "字典用法",
  "Control Flow": "流程控制",
  "Exception Handling": "异常处理",
  "Module System": "模块系统",
  "Type Hints": "类型注解",
  "Testing Practices": "测试实践",
  "Debugging Habits": "调试习惯",
  "Code Organization": "代码组织",
};

/** Translate a schema section name to its Chinese label (falls back to the
 *  original if the name is unknown, so new sections never crash the view). */
export function sectionLabel(name: string): string {
  return SECTION_LABELS[name] ?? name;
}