import type { GitClient } from "./gitClient";
import { assertCurrentBranch } from "./branchOps";

/** spec 4.5 ①：工作区是否有未提交修改（status --porcelain 非空）——同步命令的告知性确认依据 */
export async function hasLocalChanges(git: GitClient): Promise<boolean> {
  const status = await git.run(["status", "--porcelain"]);
  return status.trim().length > 0;
}

export type SyncResult = { kind: "ok"; stashed: boolean } | { kind: "rebaseConflict" };

/**
 * spec 4.5 同步作业三步：让工作区与远端自己分支的最新已提交状态一致。
 * ⓪ 分支断言（对齐 spec 4.4 提交第 1 步）：当前分支 != student-<学号> 直接抛错拒绝，
 *   防 checkout student-X -- . 把分支内容写进错误分支的工作区（错误语义同 pullNewOnly：向上抛给命令层）；
 * ① 未提交修改 → stash push -u（自动备份，零丢失兜底，教师可从 stash 找回）
 * ② fetch + rebase origin/student-<学号>（同拉取的收敛步骤，防从落后分支同步出旧状态）
 * ③ checkout student-<学号> -- .（整个工作区还原为已提交状态：删过的找回、改乱的还原）
 */
export async function syncToRemoteState(git: GitClient, studentId: string): Promise<SyncResult> {
  const branch = `student-${studentId}`;
  if (!(await assertCurrentBranch(git, studentId))) {
    throw new Error(`当前分支不是 ${branch}，同步已取消（请勿手动切换分支）`);
  }
  const dirty = (await git.run(["status", "--porcelain"])).trim().length > 0;
  if (dirty) await git.run(["stash", "push", "-u", "-m", `sync backup ${new Date().toISOString()}`]);
  await git.run(["fetch", "origin"]);
  try {
    await git.run(["rebase", `origin/${branch}`]);
  } catch {
    // abort 自身可能失败（如新学生首用远端分支不存在，本就无 rebase 可中止）→ 吞掉，避免掩盖冲突语义
    await git.run(["rebase", "--abort"]).catch(() => {});
    return { kind: "rebaseConflict" };
  }
  await git.run(["checkout", branch, "--", "."]);
  return { kind: "ok", stashed: dirty };
}
