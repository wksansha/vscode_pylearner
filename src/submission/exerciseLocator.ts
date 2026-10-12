// src/submission/exerciseLocator.ts
import { scanExerciseId } from "./exerciseHeader";

export interface LocatedExercise {
  exerciseId: string;
  kind: "file" | "project";
  entry?: string;                 // 项目：入口文件（缺省 main.py）
  projectDirFsPath?: string;      // 项目：week-XX/<dir> 绝对路径
}

export interface LocatorDeps {
  rootFsPath: string;
  join: (dir: string, rel: string) => string;
  readFile: (fsPath: string) => Promise<string | null>;
}

/** 读项目 manifest；缺 exerciseId / 非法 → null（spec §5.2：项目题定位走 exercise.json） */
export async function readExerciseManifest(
  deps: LocatorDeps, projectDirFsPath: string,
): Promise<{ exerciseId: string; entry: string } | null> {
  const raw = await deps.readFile(deps.join(projectDirFsPath, "exercise.json"));
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as { exerciseId?: string; entry?: string };
    if (typeof m.exerciseId !== "string" || !m.exerciseId) return null;
    return { exerciseId: m.exerciseId, entry: typeof m.entry === "string" && m.entry ? m.entry : "main.py" };
  } catch {
    return null;
  }
}

const WEEK_SEG_RE = /[\\/]week-(\d{2})[\\/]/;

/** 定位当前文件所属 exercise：优先头部 id（单文件）；否则按 week-XX/<dir>/exercise.json（项目） */
export async function resolveExercise(
  deps: LocatorDeps, filePath: string, content: string,
): Promise<LocatedExercise | null> {
  const headerId = scanExerciseId(content);
  if (headerId) return { exerciseId: headerId, kind: "file" };

  const norm = filePath.replace(/\//g, "\\");
  const root = deps.rootFsPath.replace(/\//g, "\\").replace(/[\\/]+$/, "");
  if (!norm.startsWith(root + "\\")) return null;
  const rel = norm.slice(root.length + 1);          // week-03\<...>
  const m = rel.match(/^week-\d{2}\\([^\\]+)\\(.+)$/);
  if (!m) return null;                               // week 目录一级 .py（无头部 id）或目录外 → 非 exercise
  const projectDirFsPath = deps.join(deps.join(root, rel.split("\\")[0]), m[1]);
  const manifest = await readExerciseManifest(deps, projectDirFsPath);
  if (!manifest) return null;
  return { exerciseId: manifest.exerciseId, kind: "project", entry: manifest.entry, projectDirFsPath };
}
