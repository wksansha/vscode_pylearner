import type { GitClient, GitError } from "./gitClient";
import { assertCurrentBranch } from "./branchOps";

/** porcelain 状态行删除检测（X=暂存区 Y=工作区，任一位为 D 即删除条目）。
 * 覆盖 D␣/␣D/MD/AD 全部组合（Task 345 遗留缺口：旧正则 /(^| )D / 漏 MD = 暂存修改+工作区删除）。 */
export function countDeleted(status: string): number {
  return status.split("\n").filter((l) => l.length >= 2 && (l[0] === "D" || l[1] === "D")).length;
}

/** 工作区未提交变更条数（porcelain 非空行）——换机确认弹窗展示用 */
export async function countLocalChanges(git: GitClient): Promise<number> {
  const status = await git.run(["status", "--porcelain"]);
  return status.split("\n").filter((l) => l.trim()).length;
}

export interface SubmitDeps {
  git: GitClient; studentId: string; studentName: string;
  remoteWithBasic: () => string;
  confirmDelete?: (n: number) => Promise<boolean>;   // spec 4.4 第 2 步：删除检测确认
}
export type SubmitResult = { kind: "ok" } | { kind: "nothing" } | { kind: "branchMismatch" } | { kind: "deleteCancelled" } | { kind: "rebaseConflict" } | { kind: "pushFailed" };

export async function submitAll(deps: SubmitDeps): Promise<SubmitResult> {
  const { git, studentId, studentName } = deps;
  const branch = `student-${studentId}`;
  if (!(await assertCurrentBranch(git, studentId))) return { kind: "branchMismatch" };
  const status = await git.run(["status", "--porcelain"]);
  const deletedCount = countDeleted(status);
  if (deletedCount > 0) {
    const ok = deps.confirmDelete ? await deps.confirmDelete(deletedCount) : true;
    if (!ok) return { kind: "deleteCancelled" };
  }
  await git.run(["add", "-A"]);
  try {
    await git.run(["commit", "-m", `submit: workspace by ${studentId} ${studentName}`,
      `--author=${studentId} ${studentName} <${studentId}@classroom>`]);
  } catch (err) {
    const e = err as GitError;
    if (/nothing to commit/.test(`${e.stdout}${e.stderr}`)) return { kind: "nothing" };
    throw err;
  }
  await git.run(["fetch", "origin"]);
  // 首推守卫：远端学生分支尚不存在（首次 push 才创建）→ 跳过 rebase（否则 invalid upstream 被误判为 rebaseConflict，首推永远失败）
  const upstream = await git.run(["rev-parse", "--verify", `origin/${branch}`]).catch(() => "");
  if (upstream.trim()) {
    try {
      await git.run(["rebase", `origin/${branch}`]);
    } catch {
      await git.run(["rebase", "--abort"]);
      return { kind: "rebaseConflict" };
    }
  }
  const commitHash = (await git.run(["rev-parse", "HEAD"])).trim();
  let files: string[] = [];
  try {
    const before = (await git.run(["rev-parse", `origin/${branch}`])).trim();
    files = (await git.run(["diff", "--name-only", before, "HEAD"])).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { /* 远端无分支（首推）→ 全量清单 */ files = (await git.run(["ls-files"])).split("\n").filter(Boolean); }
  try {
    await git.run(["push", deps.remoteWithBasic(), `HEAD:refs/heads/${branch}`]);
  } catch {
    return { kind: "pushFailed" };
  }
  return { kind: "ok" };
}
