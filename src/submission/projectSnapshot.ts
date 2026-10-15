// src/submission/projectSnapshot.ts
import { resolveProject, type LocatorDeps } from "./exerciseLocator";
import { listProjectFiles, type ProjectFs, type SubmissionFile } from "./projectFiles";

export interface SnapshotDeps { locator: LocatorDeps; projectFs: ProjectFs }

export interface ProjectSnapshot { files: SubmissionFile[]; entryContent: string }

/** 当前文件属于项目目录 → 全量快照（排除 exercise.json）+ 入口内容；否则 null（单文件题无需快照） */
export async function buildProjectSnapshot(deps: SnapshotDeps, filePath: string, _content: string): Promise<ProjectSnapshot | null> {
  const located = await resolveProject(deps.locator, filePath);
  if (!located) return null;
  const files = await listProjectFiles(deps.projectFs, located.projectDirFsPath);
  if (!files || files.length === 0) return null;
  const entryFile = files.find((f) => f.path === located.entry);
  if (!entryFile) return null;
  return { files, entryContent: entryFile.content };
}
