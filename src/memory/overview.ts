// Teacher-style overview pass: feed the consolidated L3 profile back to the
// LLM once and have it write a term assessment (narrative + dimension table)
// in a teacher's voice. Pure module — the disk and LLM sides are wired by
// each caller (updateProfile.ts, rebuild-profile.ts) via OverviewDeps, so
// ConsolidatorDeps stays frozen.

// Storage: l3/<slot>-overview.md, free-form markdown, no meta sidecar. The
// overview is rewritten whole on every pass — it never merges incrementally.

import { renderDisplay, type Document } from "./document";
import type { L3Slot } from "./paths";

export interface OverviewDeps {
  loadL3Doc(slot: L3Slot): Promise<Document | null>;
  callLlm(systemPrompt: string, userPrompt: string, context?: string): Promise<string>;
  saveOverviewText(text: string): Promise<void>;
  onEvent?(event: Record<string, unknown>): void;
}

export function buildOverviewSystem(today: string): string {
  return [
    "你是一名有经验的 Python 老师,为一名学生撰写阶段性学习评语,口吻像老师写给本人/家长看。",
    `今天日期:${today}`,
    "",
    "你会收到该学生的画像(分节知识点事实,每条带掌握度标签 🟢较好/🟡一般/🔴存在误区)。",
    "综合判断学生的学习情况并输出评语,硬性要求:",
    "1. 全部使用中文。",
    "2. 第一部分:一段 80-200 字的总评叙述,概括学习阶段、系统性薄弱点、已有的能力(如纠错意识)。",
    "3. 第二部分:一张 markdown 表格,表头固定为 | 维度 | 表现 | 判断 |。",
    "   - 维度:5±3 个,由画像分节语义归并(如「导入语法」与「语法错误(冒号)」可归并为「基础语法」)。",
    "   - 表现:引用画像中的具体证据(拼写错误、未定义变量清单、类型错误等),不写空话。",
    "   - 判断:只能用 🟢已掌握 / 🟡一般 / 🔴存在误区 三档。",
    "4. 只基于画像证据,不臆造画像中不存在的知识点。",
    "5. 禁止绝对化断言(如「完全不会」「永远记不住」),用具体行为描述。",
    "6. 不要逐条罗列画像原文,不要输出总评叙述和维度表以外的额外小节。",
  ].join("\n");
}

export function buildOverviewUser(profileDisplay: string): string {
  return [
    "# 学生画像(分节事实 + 掌握度标签)",
    "",
    profileDisplay.trim(),
    "",
    "请基于以上画像输出评语:先总评叙述,再维度表。",
  ].join("\n");
}

export async function synthesizeOverview(deps: OverviewDeps, slot: L3Slot): Promise<void> {
  const doc = await deps.loadL3Doc(slot);
  if (!doc || doc.allEntries().length === 0) {
    deps.onEvent?.({ stage: "overview_skipped", reason: "empty_profile" });
    return;
  }
  const system = buildOverviewSystem(new Date().toISOString().slice(0, 10));
  const user = buildOverviewUser(renderDisplay(doc));
  const text = await deps.callLlm(system, user, `L3:${slot}:overview`);
  if (!text.trim()) {
    throw new Error("overview LLM returned empty output");
  }
  await deps.saveOverviewText(text.trim());
  deps.onEvent?.({ stage: "overview_done" });
}