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
