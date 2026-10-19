import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { createGitClient, type ExecFn, type GitClient } from "./gitClient";

const execFileAsync = promisify(execFile) as unknown as ExecFn;

/** 仓库环境原语（认证 URL 组装 / git 探测 / clone 引导）——git 命令组装只出现在 src/git/ 内 */

/** https://host/u/r.git → https://<学号>:<gitSecret>@host/u/r.git（Basic 认证，凭证原样嵌入，不做 URL 编码） */
export function remoteWithBasic(repoUrl: string, studentId: string, gitSecret: string): string {
  return repoUrl.replace("://", `://${studentId}:${gitSecret}@`);
}

/** git CLI 探测：git --version 退出 0 → true（机房机器缺 Git 时给安装引导，spec §8） */
export async function probeGit(exec: ExecFn = execFileAsync): Promise<boolean> {
  try {
    await exec("git", ["--version"], { cwd: process.cwd() });
    return true;
  } catch {
    return false;
  }
}

/** cwd 是否已初始化为 git 工作树（rev-parse --is-inside-work-tree 退出 0） */
export async function isGitWorkTree(cwd: string, exec: ExecFn = execFileAsync): Promise<boolean> {
  try {
    await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * 课堂仓库首次引导（spec 4.1）：workspace 根为空或仅含 .vscode 时的等价 clone。
 * git clone 要求目标目录为空（存在 .vscode 即失败），故用 init + remote add + fetch + checkout
 * 等价实现：本地得到完整工作树与跟踪 origin/main 的 main 分支，学生分支随后自 origin/main 创建。
 * token 随 URL 进入 .git/config 的 origin（读取通道）；push 一律用显式带凭证的 URL（见 commitOps）。
 */
export async function bootstrapClone(cwd: string, url: string, exec: ExecFn = execFileAsync): Promise<void> {
  const git: GitClient = createGitClient(cwd, exec);
  await git.run(["init"]);
  // 中文文件名不做 quote 转义：diff --name-only 清单与 checkout 路径可直用（转义会破坏文件清单匹配）
  await git.run(["config", "core.quotepath", "false"]);
  await git.run(["remote", "add", "origin", url]);
  await git.run(["fetch", "origin"]);
  await git.run(["checkout", "-B", "main", "origin/main"]);
  // spec 4.1：引导完成即确保 .gitignore 存在，防 __pycache__ 等缓存垃圾被 add -A 归档并触发删除检测噪音。
  // 已存在时（题库 main 自带）不得覆写——覆写会让 tracked 文件变"已修改"，后续拉取的 rebase 必被脏工作区拒绝
  const gitignorePath = path.join(cwd, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, "__pycache__/\n*.pyc\n.venv/\n", "utf8");
  }
}

/** F2：committer 身份写仓库 local config——机房批量安装的 git 默认无全局 user.name/email，
 * commit --author 只覆盖 author，committer 缺失时 git 拒绝提交（"Please tell me who you are"）。
 * 跟随当前身份调用（bootstrap 后首次 + 身份页换学号后的每次 resolveGitEnv），幂等。 */
export async function configureCommitter(git: GitClient, studentId: string): Promise<void> {
  await git.run(["config", "user.name", studentId]);
  await git.run(["config", "user.email", `${studentId}@classroom`]);
}

/** origin 指向刷新为带当前学生凭证的 URL（换机/换人后读取凭证跟随本人；origin 不存在时由调用方忽略失败） */
export async function updateOriginUrl(git: GitClient, url: string): Promise<void> {
  await git.run(["remote", "set-url", "origin", url]);
}
