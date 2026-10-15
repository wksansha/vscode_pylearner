// src/submission/exerciseLocator.ts
//
// 路径处理说明：本文件路径处理当前按 Windows（反斜杠）语义实现——课堂学生机为 Windows/麒麟内网环境。
// POSIX 支持留作后续任务（错误路径在 POSIX 下会静默退化为"非练习"，不崩溃）。
//
// 学生分支直连模型（spec 2.1）：练习定位权在服务端（按文件路径查表），学生端零识别。
// 本模块仅服务项目快照收集：判定「当前文件是否位于项目目录」（含 exercise.json 的子目录），
// 不再解析 exercise-id（文件头 exercise-id 注入机制整体退役）。

export interface LocatedProject {
  entry: string;                  // 项目入口（manifest.entry，缺省 main.py）
  projectDirFsPath: string;       // <root>/<作业目录>/<项目目录> 绝对路径
}

export interface LocatorDeps {
  rootFsPath: string;
  join: (dir: string, rel: string) => string;
  readFile: (fsPath: string) => Promise<string | null>;
}

/** 读项目 manifest（exercise.json）：合法 JSON 对象即项目标记（不再要求 exerciseId）；否则 null */
export async function readExerciseManifest(
  deps: LocatorDeps, projectDirFsPath: string,
): Promise<{ entry: string } | null> {
  const raw = await deps.readFile(deps.join(projectDirFsPath, "exercise.json"));
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as { entry?: string };
    if (typeof m !== "object" || m === null || Array.isArray(m)) return null;
    return { entry: typeof m.entry === "string" && m.entry ? m.entry : "main.py" };
  } catch {
    return null;
  }
}

/** 当前文件是否位于项目目录：<root>/<作业目录>/<项目目录>/... 且目录含 exercise.json；否则 null */
export async function resolveProject(deps: LocatorDeps, filePath: string): Promise<LocatedProject | null> {
  const norm = filePath.replace(/\//g, "\\");
  const root = deps.rootFsPath.replace(/\//g, "\\").replace(/[\\/]+$/, "");
  if (!root || !norm.startsWith(root + "\\")) return null;
  const segs = norm.slice(root.length + 1).split("\\");
  if (segs.length < 3) return null;                  // 一级作业目录 .py / 目录外 → 非项目
  const projectDirFsPath = deps.join(deps.join(root, segs[0]), segs[1]);
  const manifest = await readExerciseManifest(deps, projectDirFsPath);
  if (!manifest) return null;
  return { entry: manifest.entry, projectDirFsPath };
}
