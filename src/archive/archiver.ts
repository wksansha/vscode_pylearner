// src/archive/archiver.ts
// 归档调度器：仅激活后延迟 10s 归档一次（spec §4.4，无定时器/事件驱动，零后台常驻）。
// 每轮：读位点 → batcher 扫描切批 → 按批 POST /api/trace/archive → 2xx/400 推进位点。
// 触发频率只影响服务器数据新鲜度；本地 JSONL 是事实源，断网/崩溃后下轮自动补传（spec §2/§6）。
import * as vscode from "vscode";
import { parseOffsets, serializeOffsets, OFFSETS_FILE } from "./archiveState";
import {
  planBatches,
  type ArchiveFs,
  type BatchIdentity,
} from "./batcher";

const STARTUP_DELAY_MS = 10_000;

/** 与服务端一致的 classId 字符集；非法值落 default，避免脏数据整批 400 拒收（spec §4.6） */
const CLASS_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface TraceArchiverDeps {
  globalStorageUri: vscode.Uri;
  /** 每次触发时读取（跟随配置变化），复用 pylearner.teacher.url */
  teacherUrl: () => string;
  /** 归档开关，复用 pylearner.teacher.enabled（spec §4.7） */
  isEnabled: () => boolean;
  log?: (msg: string) => void;
}

export interface TraceArchiver extends vscode.Disposable {
  /** 立即执行一轮（测试/手动入口） */
  runOnce(): Promise<void>;
}

export function createTraceArchiver(deps: TraceArchiverDeps): TraceArchiver {
  const traceRoot = vscode.Uri.joinPath(deps.globalStorageUri, "trace");
  const child = (rel: string): vscode.Uri =>
    vscode.Uri.joinPath(traceRoot, ...rel.split("/"));

  // ArchiveFs 的 vscode.workspace.fs 运行时适配（rel → Uri）
  const fsx: ArchiveFs = {
    async listDirs(rel) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(child(rel));
        return entries.filter(([, t]) => t === vscode.FileType.Directory).map(([n]) => n);
      } catch {
        return [];
      }
    },
    async listFiles(rel) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(child(rel));
        return entries.filter(([, t]) => t === vscode.FileType.File).map(([n]) => n);
      } catch {
        return [];
      }
    },
    async readFileBytes(rel) {
      try {
        return await vscode.workspace.fs.readFile(child(rel));
      } catch {
        return null;
      }
    },
    async writeFileBytes(rel, data) {
      const parent = rel.split("/").slice(0, -1).join("/");
      if (parent) {
        try {
          await vscode.workspace.fs.createDirectory(child(parent));
        } catch {
          // exists
        }
      }
      await vscode.workspace.fs.writeFile(child(rel), data);
    },
  };

  /** 学号目录 → 批次身份；.identity.json 缺失/损坏/与目录不符 → null（跳过该学号） */
  async function readIdentity(studentId: string): Promise<BatchIdentity | null> {
    const raw = await fsx.readFileBytes(`${studentId}/.identity.json`);
    if (!raw) return null;
    try {
      const p = JSON.parse(new TextDecoder().decode(raw)) as Partial<BatchIdentity>;
      if (p.studentId !== studentId || !p.studentName) return null;
      return {
        studentId,
        studentName: p.studentName,
        // 非法 classId（越权字符/损坏数据）按 default 上报，防止该目录全部事件被 400 拒收
        classId:
          typeof p.classId === "string" && p.classId && CLASS_ID_PATTERN.test(p.classId)
            ? p.classId
            : "default",
      };
    } catch {
      return null;
    }
  }

  let running = false;

  async function saveOffsets(offsets: Record<string, number>): Promise<void> {
    await fsx.writeFileBytes(OFFSETS_FILE, new TextEncoder().encode(serializeOffsets(offsets)));
  }

  async function runOnce(): Promise<void> {
    if (running || !deps.isEnabled()) return;
    running = true;
    try {
      const stateRaw = await fsx.readFileBytes(OFFSETS_FILE);
      const stored = parseOffsets(stateRaw ? new TextDecoder().decode(stateRaw) : null);
      const plan = await planBatches(fsx, stored, readIdentity);
      const offsets = plan.offsets;
      if (plan.jobs.length === 0) return;

      const url = deps.teacherUrl().replace(/\/+$/, "") + "/api/trace/archive";
      let dirty = false;
      for (const job of plan.jobs) {
        // 同文件前面的批次已因 400 跳尾 → 后续批次跳过
        if ((offsets[job.fileKey] ?? 0) >= job.fileEnd) continue;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              student_id: job.identity.studentId,
              student_name: job.identity.studentName,
              class_id: job.identity.classId,
              surface: job.surface,
              date: job.date,
              events: job.events,
            }),
          });
          if (res.ok) {
            offsets[job.fileKey] = job.endOffset;
            dirty = true;
          } else if (res.status === 400) {
            // 数据本身有问题，重试无意义 → 跳到扫描时文件尾（spec §4.6）
            offsets[job.fileKey] = job.fileEnd;
            dirty = true;
            deps.log?.(`[archive] 400 拒收 ${job.fileKey}，位点跳到文件尾`);
          } else {
            // 5xx/其它 → 本轮中止，位点不动，下轮续传
            deps.log?.(`[archive] 上报失败 ${res.status} ${job.fileKey}，本轮中止`);
            break;
          }
        } catch (err) {
          deps.log?.(`[archive] 网络异常，本轮中止：${err instanceof Error ? err.message : String(err)}`);
          break;
        } finally {
          if (dirty) {
            try {
              await saveOffsets(offsets);
            } catch (err) {
              deps.log?.(`[archive] 位点写入失败：${err instanceof Error ? err.message : String(err)}`);
            }
            dirty = false;
          }
        }
      }
    } finally {
      running = false;
    }
  }

  // 仅激活后延迟 10s 归档一次（spec §4.4）；无定时器/事件驱动，零后台常驻
  const startup = setTimeout(() => {
    void runOnce().catch((err: unknown) =>
      deps.log?.(`[archive] 启动归档失败：${err instanceof Error ? err.message : String(err)}`)
    );
  }, STARTUP_DELAY_MS);

  return {
    runOnce,
    dispose() {
      clearTimeout(startup);
    },
  };
}
