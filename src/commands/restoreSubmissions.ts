import * as vscode from "vscode";
import { loadStudentIdentity } from "../identity/studentIdentity";

/** 服务端提交行（GET /api/submissions/student/:id 返回，按 submitted_at 降序） */
interface SubmissionRow {
  exerciseId: string;
  code: string;
  submittedAt: number;
}

/** GET /api/assignments/published 行（恢复只用到 week/exercises → 本地路径映射） */
interface PublishedLite {
  id: string;
  week: number;
  exercises: { id: string; filename: string }[];
}

export interface RestoreDeps {
  teacherUrl: () => string;
  getStudentId: () => string | null;
  fetchImpl?: typeof fetch;
  /** 读工作区相对路径文件；null = 不存在 */
  readFile: (rel: string) => Promise<string | null>;
  writeFile: (rel: string, content: string) => Promise<void>;
  /** 计划写入前确认；不提供则直接写入 */
  confirm?: (plan: { rel: string }[]) => Promise<boolean>;
}

export interface RestoreResult {
  restored: string[];   // 已覆盖/新写
  identical: string[];  // 本地内容与服务端最新提交一致，跳过
  unmapped: string[];   // exerciseId 不在已发布列表（题目可能已下线）
  cancelled?: boolean;
}

/** 每个练习取最近一次提交（服务端已按 submitted_at 降序，首次出现即最新） */
export function latestByExercise(rows: SubmissionRow[]): Map<string, SubmissionRow> {
  const map = new Map<string, SubmissionRow>();
  for (const r of rows) if (!map.has(r.exerciseId)) map.set(r.exerciseId, r);
  return map;
}

export async function restoreSubmissions(deps: RestoreDeps): Promise<RestoreResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const studentId = deps.getStudentId();
  if (!studentId) throw new Error("identity-missing");

  const listRes = await doFetch(`${deps.teacherUrl()}/api/assignments/published`);
  if (!listRes.ok) throw new Error(`获取作业列表失败（${listRes.status}）`);
  const published = (await listRes.json()) as PublishedLite[];
  const pathOf = new Map<string, string>();
  for (const a of published) {
    for (const ex of a.exercises) {
      pathOf.set(ex.id, `week-${String(a.week).padStart(2, "0")}/${ex.filename}`);
    }
  }

  const subRes = await doFetch(
    `${deps.teacherUrl()}/api/submissions/student/${encodeURIComponent(studentId)}`
  );
  if (!subRes.ok) throw new Error(`获取提交记录失败（${subRes.status}）`);
  const rows = (await subRes.json()) as SubmissionRow[];

  const result: RestoreResult = { restored: [], identical: [], unmapped: [] };
  const plan: { rel: string; code: string }[] = [];
  for (const [exerciseId, sub] of latestByExercise(rows)) {
    const rel = pathOf.get(exerciseId);
    if (!rel) { result.unmapped.push(exerciseId); continue; }
    const local = await deps.readFile(rel);
    if (local === sub.code) { result.identical.push(rel); continue; }
    plan.push({ rel, code: sub.code });
  }

  if (plan.length > 0 && deps.confirm) {
    const ok = await deps.confirm(plan);
    if (!ok) return { ...result, cancelled: true };
  }
  for (const p of plan) {
    await deps.writeFile(p.rel, p.code);
    result.restored.push(p.rel);
  }
  return result;
}

/** 恢复命令（教师兜底渠道的对称功能）：从服务端拉回本人每个练习的最近一次提交 */
export function makeRestoreCommand(
  deps: { teacherUrl: () => string; globalState: { get(key: string): unknown; update(key: string, value: unknown): PromiseLike<void> } },
  vscode: typeof import("vscode")
) {
  return async (): Promise<void> => {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      vscode.window.showWarningMessage("请先打开课堂文件夹（文件 → 打开文件夹），再恢复提交");
      return;
    }
    try {
      const r = await restoreSubmissions({
        teacherUrl: deps.teacherUrl,
        getStudentId: () => loadStudentIdentity(deps.globalState).studentId,
        readFile: async (rel) => {
          try {
            const buf = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root.uri, rel));
            return new TextDecoder().decode(buf);
          } catch {
            return null;
          }
        },
        writeFile: async (rel, content) => {
          const target = vscode.Uri.joinPath(root.uri, rel);
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
          await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
        },
        confirm: async (plan) => {
          const names = plan.map((p) => p.rel).join("\n");
          const pick = await vscode.window.showWarningMessage(
            `将从服务端恢复 ${plan.length} 个作业文件（覆盖为你的最近一次提交）：\n${names}`,
            { modal: true },
            "恢复",
            "取消"
          );
          return pick === "恢复";
        },
      });
      if (r.cancelled) {
        vscode.window.showInformationMessage("已取消恢复");
        return;
      }
      const parts = [`已恢复 ${r.restored.length} 个`];
      if (r.identical.length > 0) parts.push(`${r.identical.length} 个与本地一致`);
      if (r.unmapped.length > 0) parts.push(`${r.unmapped.length} 个提交找不到对应练习（题目可能已下线）`);
      vscode.window.showInformationMessage(parts.join(" · "));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(
        msg === "identity-missing" ? "请先在身份页设置学号与姓名" : `恢复失败：${msg}`
      );
    }
  };
}
