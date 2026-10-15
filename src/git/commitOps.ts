import type { GitClient, GitError } from "./gitClient";
import { assertCurrentBranch } from "./branchOps";

export interface SubmitDeps {
  git: GitClient; studentId: string; studentName: string;
  remoteWithToken: () => string;
  confirmDelete?: (n: number) => Promise<boolean>;   // spec 4.4 第 2 步：删除检测确认
  notify: (p: { studentId: string; studentName: string; commitHash: string; files: string[]; pushedAt: number }) => Promise<void>;
}
export type SubmitResult = { kind: "ok" } | { kind: "nothing" } | { kind: "branchMismatch" } | { kind: "deleteCancelled" } | { kind: "rebaseConflict" } | { kind: "pushFailed" };

export async function submitAll(deps: SubmitDeps): Promise<SubmitResult> {
  const { git, studentId, studentName } = deps;
  const branch = `student-${studentId}`;
  if (!(await assertCurrentBranch(git, studentId))) return { kind: "branchMismatch" };
  const status = await git.run(["status", "--porcelain"]);
  const deleted = status.split("\n").filter((l) => /(^| )D /.test(l));
  if (deleted.length > 0) {
    const ok = deps.confirmDelete ? await deps.confirmDelete(deleted.length) : true;
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
  try {
    await git.run(["rebase", `origin/${branch}`]);
  } catch {
    await git.run(["rebase", "--abort"]);
    return { kind: "rebaseConflict" };
  }
  const commitHash = (await git.run(["rev-parse", "HEAD"])).trim();
  let files: string[] = [];
  try {
    const before = (await git.run(["rev-parse", `origin/${branch}`])).trim();
    files = (await git.run(["diff", "--name-only", before, "HEAD"])).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { /* 远端无分支（首推）→ 全量清单 */ files = (await git.run(["ls-files"])).split("\n").filter(Boolean); }
  try {
    await git.run(["push", deps.remoteWithToken(), `HEAD:refs/heads/${branch}`]);
  } catch {
    return { kind: "pushFailed" };
  }
  await deps.notify({ studentId, studentName, commitHash, files, pushedAt: Date.now() }).catch(() => {});
  return { kind: "ok" };
}
