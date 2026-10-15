import type { GitClient } from "./gitClient";

/** spec 4.3：先同步自己（多电脑防覆盖——落后分支直接拉 main 会用原始题面覆盖他机提交的学生代码），再只新增 */
export async function pullNewOnly(git: GitClient, studentId: string): Promise<{ pulled: string[] }> {
  await git.run(["fetch", "origin"]);
  await git.run(["rebase", `origin/student-${studentId}`]);   // 本地落后时 fast-forward 收敛；有离线提交时 rebase
  const out = await git.run(["diff", "--diff-filter=A", "--name-only", "HEAD", "origin/main"]);
  const paths = out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (paths.length === 0) return { pulled: [] };
  await git.run(["checkout", "origin/main", "--", ...paths]);
  await git.run(["commit", "-m", `pull: ${paths.length} new file(s) from main`]);
  return { pulled: paths };
}

/** 拉取远端学生分支最新提交（spec 4.6 切换第 3 步；远端分支不存在时由调用方先探测跳过） */
export async function pullStudentBranch(git: GitClient, studentId: string): Promise<void> {
  await git.run(["pull", "origin", `student-${studentId}`]);
}
