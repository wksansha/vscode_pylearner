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
 * 插件自产文件白名单：这些文件由扩展生成/维护（.gitignore 引导兜底、.vscode/settings.json 关原生 Git UI），
 * 不承载学生数据。跨机器状态分裂（分支树 tracked、本地却是未跟踪副本）时，checkout/rebase 会被 git 的
 * "未跟踪文件将被覆盖"安全规则整单拦截——见 clearUntrackedCollisions。
 */
export const PLUGIN_AUTO_FILES = [".gitignore", ".vscode/settings.json"] as const;

/**
 * 清除白名单文件中「目标树已跟踪、本地却是未跟踪副本」的碰撞（git 安全规则会因此拒绝 checkout/rebase）。
 * 只动目标树 tracked ∩ 白名单的路径：clean -fx 不影响 tracked 文件，学生自建文件永不触碰；
 * 目标树未跟踪白名单文件时零动作（保留本地副本，防 __pycache__ 失去忽略规则）。幂等。
 */
export async function clearUntrackedCollisions(git: GitClient, treeish: string, paths: ReadonlyArray<string>): Promise<void> {
  if (paths.length === 0) return;
  const tracked = new Set(
    (await git.run(["ls-tree", "--name-only", treeish, "--", ...paths]))
      .split("\n").map((s) => s.trim()).filter(Boolean),
  );
  const hits = paths.filter((p) => tracked.has(p));
  if (hits.length > 0) await git.run(["clean", "-fx", "--", ...hits]);
}

/**
 * fetch 收敛（2026-10-28 性能优化）：remote.origin.fetch 只配 main + 本人分支两条显式 refspec，
 * 覆盖 git remote add 默认的全量通配（refs/heads/*）——课堂仓库全班共用一个仓库，学生越多分支越多，
 * 全量 fetch 会把其他所有学生的提交历史也下载下来（学生只用自己分支，纯浪费带宽，初始化随班级规模线性变慢）。
 * 收敛后每次 fetch origin 只传输 main 与本人分支。
 * 幂等：--replace-all 清空旧配置（含共享电脑换人后残留的前任分支 refspec）。
 * 本人分支 refspec 需先探测远端（2026-10-29 修复）：新学生远端分支尚不存在（首推前）时，配置里挂一条
 * 无匹配 refspec 会让 git fetch 直接 fatal「couldn't find remote ref refs/heads/student-<id>」（git 2.54
 * 实测，此前“仅告警不报错”的假设不成立，新学生初始化/拉取/提交全挂）——先 ls-remote 探测（不存在时
 * 返回空且退出 0，凭证随 origin URL），存在才加该条；学生首推后下次调用自动探测到并补上，
 * 断网探测失败同“不存在”处理，后续 fetch 自会暴露真实网络错误。
 */
export async function configureStudentFetchRefSpec(git: GitClient, studentId: string): Promise<void> {
  const branch = `student-${studentId}`;
  await git.run(["config", "--replace-all", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"]);
  const remoteHasBranch = (await git.run(["ls-remote", "origin", `refs/heads/${branch}`]).catch(() => "")).trim();
  if (remoteHasBranch) {
    await git.run(["config", "--add", "remote.origin.fetch", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  }
}

/**
 * 课堂仓库首次引导（spec 4.1）：workspace 根为空或仅含 .vscode 时的等价 clone。
 * git clone 要求目标目录为空（存在 .vscode 即失败），故用 init + remote add + fetch + checkout
 * 等价实现。落点（碰撞修复 2026-10-28）：远程学生分支已存在（换电脑/重装）→ 直接落到自己分支，
 * 与一键换机同语义——空目录上 checkout 分支树，自产文件不会以未跟踪状态撞上分支 tracked 版本；
 * 不存在（真新学生）→ 落 origin/main 基线，学生分支随后自 origin/main 创建。
 * token 随 URL 进入 .git/config 的 origin（读取通道）；push 一律用显式带凭证的 URL（见 commitOps）。
 */
export async function bootstrapClone(cwd: string, url: string, studentId: string, exec: ExecFn = execFileAsync): Promise<void> {
  const git: GitClient = createGitClient(cwd, exec);
  await git.run(["init"]);
  // 中文文件名不做 quote 转义：diff --name-only 清单与 checkout 路径可直用（转义会破坏文件清单匹配）
  await git.run(["config", "core.quotepath", "false"]);
  await git.run(["remote", "add", "origin", url]);
  await configureStudentFetchRefSpec(git, studentId);   // fetch 收敛：只拉 main + 本人分支，不背全班历史
  await git.run(["fetch", "origin"]);
  const branch = `student-${studentId}`;
  const remoteBranch = await git.run(["rev-parse", "--verify", `origin/${branch}`]).catch(() => "");
  if (remoteBranch.trim()) {
    await git.run(["checkout", "-B", branch, "--track", `origin/${branch}`]);
  } else {
    await git.run(["checkout", "-B", "main", "origin/main"]);
  }
  // spec 4.1：引导完成即确保 .gitignore 存在，防 __pycache__ 等缓存垃圾被 add -A 归档并触发删除检测噪音；
  // .vscode/ 规则防 disableNativeGitUi 写的 settings.json 被 add -A 收进分支（跨机器碰撞的污染源）。
  // 已存在时（题库 main / 学生分支自带）不得覆写——覆写会让 tracked 文件变"已修改"，后续拉取的 rebase 必被脏工作区拒绝
  const gitignorePath = path.join(cwd, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, "__pycache__/\n*.pyc\n.venv/\n.vscode/\n", "utf8");
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

/**
 * 隐藏 VS Code 原生 Git 界面：工作区 settings.json 写 git.enabled=false，关闭内置 Git 扩展
 * （左下角分支入口/源代码管理面板/命令面板 git 命令全消失）——摘掉"点几下就能切到他人分支
 * 全量复制代码"的便捷通道。本扩展 git 操作全部走 CLI 直调（GitClient），不受影响。
 * 幂等：读-合并-写，保留 .vscode/settings.json 里已有的其他配置；已是 false 时零写入。
 */
export function disableNativeGitUi(cwd: string): void {
  const dir = path.join(cwd, ".vscode");
  const file = path.join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // 文件不存在或含注释解析失败 → 从空重建（学生工作区的 settings 由扩展/VS Code 自动生成，无手工注释）
  }
  if (settings["git.enabled"] === false) return;
  settings["git.enabled"] = false;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
