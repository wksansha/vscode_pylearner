import type { GitClient } from "./gitClient";

/** spec 4.5 ①：工作区是否有未提交修改（status --porcelain 非空）——同步命令的告知性确认依据 */
export async function hasLocalChanges(git: GitClient): Promise<boolean> {
  const status = await git.run(["status", "--porcelain"]);
  return status.trim().length > 0;
}

export type SyncResult = { kind: "ok"; stashed: boolean } | { kind: "rebaseConflict" };

/**
 * spec 4.5 同步作业三步：让工作区与远端自己分支的最新已提交状态一致。
 * ① 未提交修改 → stash push -u（自动备份，零丢失兜底，教师可从 stash 找回）
 * ② fetch + rebase origin/student-<学号>（同拉取的收敛步骤，防从落后分支同步出旧状态）
 * ③ checkout student-<学号> -- .（整个工作区还原为已提交状态：删过的找回、改乱的还原）
 */
export async function syncToRemoteState(git: GitClient, studentId: string): Promise<SyncResult> {
  const branch = `student-${studentId}`;
  const dirty = (await git.run(["status", "--porcelain"])).trim().length > 0;
  if (dirty) await git.run(["stash", "push", "-u", "-m", `sync backup ${new Date().toISOString()}`]);
  await git.run(["fetch", "origin"]);
  try {
    await git.run(["rebase", `origin/${branch}`]);
  } catch {
    await git.run(["rebase", "--abort"]);
    return { kind: "rebaseConflict" };
  }
  await git.run(["checkout", branch, "--", "."]);
  return { kind: "ok", stashed: dirty };
}
