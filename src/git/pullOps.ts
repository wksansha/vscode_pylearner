import type { GitClient } from "./gitClient";
import { clearUntrackedCollisions, PLUGIN_AUTO_FILES } from "./gitEnv";

/** spec 4.3：先同步自己（多电脑防覆盖——落后分支直接拉 main 会用原始题面覆盖他机提交的学生代码），再只新增 */
export async function pullNewOnly(git: GitClient, studentId: string): Promise<{ pulled: string[] }> {
  const branch = `student-${studentId}`;
  await git.run(["fetch", "origin"]);
  // 首用守卫：远端学生分支尚不存在（首次 push 才创建）→ 跳过 rebase（否则 invalid upstream 会让首用拉取必败）
  const upstream = await git.run(["rev-parse", "--verify", `origin/${branch}`]).catch(() => "");
  if (upstream.trim()) {
    // 自产文件碰撞清理：rebase 落分支树前清掉本地未跟踪副本（分支 tracked 时会触发 git 安全拦截）
    await clearUntrackedCollisions(git, `origin/${branch}`, PLUGIN_AUTO_FILES);
    await git.run(["rebase", `origin/${branch}`]);   // 本地落后时 fast-forward 收敛；有离线提交时 rebase
  }
  const out = await git.run(["diff", "--diff-filter=A", "--name-only", "HEAD", "origin/main"]);
  const paths = out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (paths.length === 0) return { pulled: [] };
  // main 新增文件恰为白名单自产文件（旧污染场景）时同样清道；学生自建同名文件不在白名单，仍保守报错
  await clearUntrackedCollisions(git, "origin/main", paths);
  await git.run(["checkout", "origin/main", "--", ...paths]);
  await git.run(["commit", "-m", `pull: ${paths.length} new file(s) from main`]);
  return { pulled: paths };
}

/** 拉取远端学生分支最新提交（spec 4.6 切换第 3 步；远端分支不存在时由调用方先探测跳过） */
export async function pullStudentBranch(git: GitClient, studentId: string): Promise<void> {
  await git.run(["pull", "origin", `student-${studentId}`]);
}
