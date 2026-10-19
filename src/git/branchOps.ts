import type { GitClient } from "./gitClient";

export async function ensureStudentBranch(git: GitClient, studentId: string): Promise<void> {
  const branch = `student-${studentId}`;
  await git.run(["fetch", "origin"]);
  const remote = await git.run(["rev-parse", "--verify", `origin/${branch}`]).catch(() => "");
  const local = await git.run(["branch", "--list", branch]);
  if (!local.trim()) {
    // 远端已有学生分支 → 基于它建并显式 --track（换电脑场景，保住历史；不带 --track 会继承 main 的
    //   upstream，裸 git pull / VS Code 同步按钮会把 main 合进学生分支）；
    // 否则自 origin/main 建（新学生首用）且 --no-track——远端分支尚不存在，无可配对，宁缺勿错
    await git.run(
      remote.trim()
        ? ["branch", "--track", branch, `origin/${branch}`]
        : ["branch", "--no-track", branch, "origin/main"],
    );
  } else if (remote.trim()) {
    // 存量工作区修复：旧版本建分支继承了 main 的配对（branch.<branch>.merge=refs/heads/main），
    // 纠正为配对自己的远端分支（幂等：配对正确时零开销；缺省/配错均修复，防裸 pull 合入 main）
    const mergeRef = (await git.run(["config", `branch.${branch}.merge`]).catch(() => "")).trim();
    if (mergeRef !== `refs/heads/${branch}`) {
      await git.run(["branch", "--set-upstream-to", `origin/${branch}`, branch]).catch(() => {});
    }
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

/** 学期更替清空（spec roster §3.1）：工作区回到 origin/main 全新基线。
 * clean -fdx 含 ignored 缓存（比换机路径的 -fdX 更彻底，学期更替语义=全新电脑）；-e .vscode 排除保留运行配置。
 * 未跟踪的学生自建文件将被清除——旧代码已在服务器分支归档，此语义已在确认弹窗向学生明示。 */
export async function resetToMainBaseline(git: GitClient): Promise<void> {
  await git.run(["fetch", "origin"]);
  await git.run(["reset", "--hard", "origin/main"]);
  await git.run(["clean", "-fdx", "-e", ".vscode"]);
}
