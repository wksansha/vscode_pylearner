// src/submission/projectSnapshot.ts
import { resolveExercise, type LocatorDeps } from "./exerciseLocator";
import { listProjectFiles, type ProjectFs, type SubmissionFile } from "./projectFiles";

export interface SnapshotDeps { locator: LocatorDeps; projectFs: ProjectFs }

export interface ProjectSnapshot { exerciseId: string; files: SubmissionFile[]; entryContent: string }

/** 当前文件属于项目练习 → 全量快照（排除 exercise.json）+ 入口内容；否则 null */
export async function buildProjectSnapshot(deps: SnapshotDeps, filePath: string, content: string): Promise<ProjectSnapshot | null> {
  const located = await resolveExercise(deps.locator, filePath, content);
  if (!located || located.kind !== "project" || !located.projectDirFsPath) return null;
  const files = await listProjectFiles(deps.projectFs, located.projectDirFsPath);
  if (!files || files.length === 0) return null;
  const entryFile = files.find((f) => f.path === (located.entry ?? "main.py"));
  if (!entryFile) return null;
  return { exerciseId: located.exerciseId, files, entryContent: entryFile.content };
}
