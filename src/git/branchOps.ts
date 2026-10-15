import type { GitClient } from "./gitClient";

export async function ensureStudentBranch(git: GitClient, studentId: string): Promise<void> {
  const branch = `student-${studentId}`;
  await git.run(["fetch", "origin"]);
  const local = await git.run(["branch", "--list", branch]);
  if (!local.trim()) {
    // 远端已有学生分支 → 基于它建（换电脑场景，保住历史）；否则自 origin/main 建（新学生首用）
    const remote = await git.run(["rev-parse", "--verify", `origin/${branch}`]).catch(() => "");
    await git.run(["branch", branch, remote.trim() ? `origin/${branch}` : "origin/main"]);
  }
  await git.run(["checkout", branch]);
}

export async function assertCurrentBranch(git: GitClient, studentId: string): Promise<boolean> {
  const cur = (await git.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  return cur === `student-${studentId}`;
}

/** 清除 ignored 缓存垃圾（spec 4.6 切换：clean -fdX 清掉前一位学生残留的 __pycache__ 等） */
export async function cleanIgnored(git: GitClient): Promise<void> {
  await git.run(["clean", "-fdX"]);
}

/** 远端学生分支是否已存在（rev-parse --verify origin/student-<id>；不存在/非仓库 → false） */
export async function remoteStudentBranchExists(git: GitClient, studentId: string): Promise<boolean> {
  const ref = await git.run(["rev-parse", "--verify", `origin/student-${studentId}`]).catch(() => "");
  return ref.trim().length > 0;
}
