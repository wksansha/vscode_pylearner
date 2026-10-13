// src/archive/batcher.ts
// 扫描本地按学号分目录的 L1 JSONL，对比位点产出上传批次。
// 纯逻辑 + 注入 fs（ArchiveFs），运行时由 archiver.ts 适配 vscode.workspace.fs，测试用内存实现（spec §4.2/§4.5）。
import { SURFACES, type Surface } from "../constants";
import type { TraceEvent } from "../events/types";
import { isArchivableDirName } from "./identity";
import { offsetsKey, type ArchiveOffsets } from "./archiveState";

export const MAX_EVENTS_PER_BATCH = 200;
export const MAX_BATCH_BYTES = 512 * 1024;

/** batcher 所需的最小文件系统能力（rel 为相对 trace/ 的 "/" 分隔路径） */
export interface ArchiveFs {
  /** 列子目录名；目录不存在返回 [] */
  listDirs(rel: string): Promise<string[]>;
  /** 列文件名；目录不存在返回 [] */
  listFiles(rel: string): Promise<string[]>;
  /** 读整个文件字节；不存在返回 null */
  readFileBytes(rel: string): Promise<Uint8Array | null>;
  writeFileBytes(rel: string, data: Uint8Array): Promise<void>;
}

export interface BatchIdentity {
  studentId: string;
  studentName: string;
  classId: string;
}

export interface UploadJob {
  /** 位点 key："<studentId>/<surface>/<date>.jsonl" */
  fileKey: string;
  relPath: string;
  identity: BatchIdentity;
  surface: Surface;
  date: string;
  events: TraceEvent[];
  batchBytes: number;
  startOffset: number;
  /** 本批推完后的位点 */
  endOffset: number;
  /** 扫描时文件总长（400 跳尾目标，spec §4.6） */
  fileEnd: number;
}

const encoder = new TextEncoder();

async function planFile(
  fs: ArchiveFs,
  rel: string,
  fileKey: string,
  offsets: ArchiveOffsets,
  identity: BatchIdentity,
  surface: Surface,
  date: string
): Promise<UploadJob[]> {
  const bytes = await fs.readFileBytes(rel);
  if (!bytes || bytes.length === 0) return [];
  let start = offsets[fileKey] ?? 0;
  if (start > bytes.length) {
    // 文件比位点小（异常，理论只追加）→ 全量重传；服务器按 id 幂等（spec §4.5）
    offsets[fileKey] = 0;
    start = 0;
  }
  if (start >= bytes.length) return [];

  const tail = new TextDecoder().decode(bytes.subarray(start));
  // 尾部不完整行（正在写盘）回退到上一个 \n；位点不推进到不完整行
  const usable = tail.endsWith("\n") ? tail : tail.slice(0, tail.lastIndexOf("\n") + 1);
  if (!usable) return [];

  const fileEnd = bytes.length;
  const jobs: UploadJob[] = [];
  let cur: TraceEvent[] = [];
  let curBytes = 0;
  let cursor = start;

  const flush = () => {
    if (cur.length === 0) return;
    jobs.push({
      fileKey, relPath: rel, identity, surface, date,
      events: cur, batchBytes: curBytes,
      startOffset: cursor, endOffset: cursor + curBytes, fileEnd,
    });
    cursor += curBytes;
    cur = [];
    curBytes = 0;
  };

  // usable 以 \n 结尾，split 后最后一段必为空，丢弃
  const segments = usable.split("\n");
  segments.pop();
  for (const seg of segments) {
    const lineBytes = encoder.encode(seg + "\n").length;
    if (cur.length >= MAX_EVENTS_PER_BATCH || (cur.length > 0 && curBytes + lineBytes > MAX_BATCH_BYTES)) {
      flush();
    }
    curBytes += lineBytes; // 坏行的字节也计入位点推进（内容已损坏，重试无意义）
    if (!seg.trim()) continue;
    try {
      cur.push(JSON.parse(seg) as TraceEvent);
    } catch {
      // 坏行跳过
    }
  }
  flush();
  return jobs;
}

/**
 * 扫描所有可归档学号目录（跳过 unknown/旧布局顶层目录），为每个学号读 .identity.json
 * 取批次身份；缺失/损坏 → 跳过该学号下轮重试（spec §4.3/§6）。
 * 返回的 offsets 是含"文件缩小重置"修正后的副本，archiver 应以其为后续推进基底。
 */
export async function planBatches(
  fs: ArchiveFs,
  offsets: ArchiveOffsets,
  getIdentity: (studentId: string) => Promise<BatchIdentity | null>
): Promise<{ jobs: UploadJob[]; offsets: ArchiveOffsets }> {
  const eff: ArchiveOffsets = { ...offsets };
  const jobs: UploadJob[] = [];
  for (const dirName of await fs.listDirs("")) {
    if (!isArchivableDirName(dirName)) continue;
    const identity = await getIdentity(dirName);
    if (!identity) continue;
    for (const surface of SURFACES) {
      const surfaceRel = `${dirName}/${surface}`;
      for (const name of await fs.listFiles(surfaceRel)) {
        if (!name.endsWith(".jsonl")) continue;
        const date = name.slice(0, -".jsonl".length);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        jobs.push(
          ...(await planFile(fs, `${surfaceRel}/${name}`, offsetsKey(dirName, surface, date), eff, identity, surface, date))
        );
      }
    }
  }
  return { jobs, offsets: eff };
}
