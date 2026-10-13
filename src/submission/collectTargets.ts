// src/submission/collectTargets.ts
//
// 路径处理说明：Windows（反斜杠）语义，与 exerciseLocator/projectFiles 一致——课堂学生机为 Windows/麒麟内网环境。
import { scanExerciseId } from "./exerciseHeader";
import { readExerciseManifest, type LocatorDeps } from "./exerciseLocator";

export interface WorkspaceFs {
  readDirectory(fsPath: string): Promise<[string, { isDirectory: boolean }][] | null>;
  readFile(fsPath: string): Promise<string | null>;
}

export interface SubmissionTarget {
  label: string;            // 展示名：week-03/01-hello.py 或 week-05/weather-app
  filePath: string;         // 锚点文件绝对路径（单文件=自身；项目=入口文件）
  content: string;          // 锚点文件内容（submitCode 以此定位）
}

// 周段 \d+ 宽容：接受非补零目录名（week-5，跟随教师仓库实际目录）
const WEEK_DIR_RE = /^week-\d+$/;

/** 从 label 提取周号数值（week-2/... → 2）；无周段 → 排最后 */
const weekNumOf = (label: string): number => {
  const m = label.match(/^week-(\d+)\//);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

/**
 * 遍历工作区 week-XX 目录，收集全部提交目标：
 * 一级 .py（头部 id）+ 含 exercise.json 的项目目录（锚点=入口文件）。
 * 不与 lastHashes 去重——幂等跳过由 submitCode 负责。
 */
export async function collectSubmissionTargets(fs: WorkspaceFs, rootFsPath: string): Promise<SubmissionTarget[]> {
  const rootEntries = await fs.readDirectory(rootFsPath);
  if (!rootEntries) return [];
  const locatorDeps: LocatorDeps = {
    rootFsPath,
    join: (dir, rel) => dir + "\\" + rel,   // Windows 语义（与 exerciseLocator 一致）
    readFile: (p) => fs.readFile(p),
  };
  const targets: SubmissionTarget[] = [];
  for (const [weekName, weekType] of rootEntries) {
    if (!weekType.isDirectory || !WEEK_DIR_RE.test(weekName)) continue;
    const weekDirFsPath = `${rootFsPath}\\${weekName}`;
    const entries = await fs.readDirectory(weekDirFsPath);
    if (!entries) continue;
    for (const [name, type] of entries) {
      const abs = `${weekDirFsPath}\\${name}`;
      if (!type.isDirectory) {
        if (!name.endsWith(".py")) continue;
        const content = await fs.readFile(abs);
        if (content === null || !scanExerciseId(content)) continue;   // 无头部 id → 非课堂练习
        targets.push({ label: `${weekName}/${name}`, filePath: abs, content });
      } else {
        const manifest = await readExerciseManifest(locatorDeps, abs);
        if (!manifest) continue;                                       // 缺/坏 exercise.json → 非项目练习
        const entryPath = `${abs}\\${manifest.entry}`;
        const entryContent = await fs.readFile(entryPath);
        if (entryContent === null) {
          console.warn(`[pylearner] 跳过 ${weekName}/${name}：入口文件缺失（${manifest.entry}）`);
          continue;
        }
        targets.push({ label: `${weekName}/${name}`, filePath: entryPath, content: entryContent });
      }
    }
  }
  // 排序：周号数值升序（兼容非补零 week-5，避免 week-10 排在 week-2 前）+ 周内按名称
  targets.sort((a, b) => {
    const d = weekNumOf(a.label) - weekNumOf(b.label);
    if (d !== 0) return d;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
  return targets;
}
