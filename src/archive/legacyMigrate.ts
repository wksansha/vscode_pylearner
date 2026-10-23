// src/archive/legacyMigrate.ts
// 旧版平铺 L1 布局一次性迁移：trace/<surface>/<date>.jsonl → trace/<学号>/<surface>/<date>.jsonl，
// 迁移后交给现有归档机制（batcher/archiver）自动上传。
// 纯逻辑 + 注入 fs（参考 batcher.ts 的 ArchiveFs 模式）：运行时由 extension.ts 适配 vscode.workspace.fs，测试用内存实现。
// 幂等性：迁移中途失败后重跑，同一份源文件可能被重复追加到目标——事件行自带全局唯一 id，
// 服务端按事件 id 幂等去重，重复追加安全无害。
import { SURFACES } from "../constants";

/** 已迁移平铺目录的备份后缀（改名保留，便于排查；findLegacyDirs 不再扫到） */
export const MIGRATED_SUFFIX = ".migrated";

/** 迁移所需的最小文件系统能力（rel 为相对 trace/ 的 "/" 分隔路径） */
export interface LegacyMigrateFs {
  /** 列子目录名；目录不存在返回 [] */
  listDirs(rel: string): Promise<string[]>;
  /** 列文件名；目录不存在返回 [] */
  listFiles(rel: string): Promise<string[]>;
  /** 读整个文件字节；不存在返回 null */
  readFileBytes(rel: string): Promise<Uint8Array | null>;
  /** 写整个文件字节（覆写，父目录不存在则创建） */
  writeFileBytes(rel: string, data: Uint8Array): Promise<void>;
  /** 目录改名（备份已迁移的平铺目录用） */
  renameDir(fromRel: string, toRel: string): Promise<void>;
}

/** 迁移目标身份（来自 globalState 当前身份；classId 缺省由快照层补 default） */
export interface LegacyIdentity {
  studentId: string | null;
  studentName: string | null;
  classId?: string;
}

export type MigrateResult =
  | { kind: "no-identity" }
  | { kind: "no-legacy" }
  | {
      kind: "done";
      /** 本次迁移的平铺 surface 目录 */
      surfaces: string[];
      /** 追加迁移的文件数 */
      files: number;
      /** 成功改名为 *.migrated 备份的目录 */
      renamed: string[];
      /** 改名失败的目录（仅记日志不致命，重跑按事件 id 幂等补齐） */
      renameFailed: string[];
    };

/**
 * 扫描 trace/ 顶层：旧平铺目录 = 目录名恰为 surface 名（SURFACES 常量）。
 * unknown / 标准学号目录（isArchivableDirName）/ *.migrated 备份均不在 SURFACES 中，天然排除。
 */
export async function findLegacyDirs(fs: LegacyMigrateFs): Promise<string[]> {
  const dirs = await fs.listDirs("");
  return dirs.filter((name) => (SURFACES as readonly string[]).includes(name));
}

const encoder = new TextEncoder();
// 旧布局的练习文件即 <YYYY-MM-DD>.jsonl 命名，其余文件（异常产物）不迁移
const LEGACY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const LF = 0x0a;

/**
 * 迁移主体：对每个平铺目录的每个日期文件，追加写入 trace/<学号>/<surface>/<date>.jsonl
 * （目标已存在则追加，追加前保证目标以 \n 结尾避免粘连半行）；全部文件追加成功后
 * 写/更新 <学号>/.identity.json 身份快照；最后把平铺目录改名为 <surface>.migrated 备份
 * （改名失败仅记日志不致命）。
 */
export async function migrateLegacyTrace(
  fs: LegacyMigrateFs,
  identity: LegacyIdentity,
  legacyDirs: string[],
  log?: (msg: string) => void
): Promise<MigrateResult> {
  // 无学号/姓名不迁移（事件将落 unknown/ 永不归档，先让用户去设置身份）
  if (!identity.studentId || !identity.studentName) return { kind: "no-identity" };
  const dirs = legacyDirs.filter((d) => (SURFACES as readonly string[]).includes(d));
  if (dirs.length === 0) return { kind: "no-legacy" };

  const studentId = identity.studentId;
  let files = 0;
  for (const dir of dirs) {
    for (const name of await fs.listFiles(dir)) {
      if (!LEGACY_FILE.test(name)) continue;
      const src = await fs.readFileBytes(`${dir}/${name}`);
      if (!src || src.length === 0) continue;
      const targetRel = `${studentId}/${dir}/${name}`;
      const existing = (await fs.readFileBytes(targetRel)) ?? new Uint8Array(0);
      // 目标已有内容且不以 \n 结尾 → 先补一个换行再追加，避免与已有半行粘连
      const needSep = existing.length > 0 && existing[existing.length - 1] !== LF;
      // 源文件不以 \n 结尾 → 补一个换行保证行完整（多余空行会被归档扫描跳过）
      const needSrcNl = src[src.length - 1] !== LF;
      const merged = new Uint8Array(existing.length + (needSep ? 1 : 0) + src.length + (needSrcNl ? 1 : 0));
      let off = 0;
      merged.set(existing, off);
      off += existing.length;
      if (needSep) merged[off++] = LF;
      merged.set(src, off);
      off += src.length;
      if (needSrcNl) merged[off++] = LF;
      await fs.writeFileBytes(targetRel, merged);
      files++;
    }
  }

  // 全部文件追加成功后写/刷新学号目录身份快照（格式与 l1Writer 的 .identity.json 一致）
  const snapshot = {
    studentId,
    studentName: identity.studentName,
    classId: identity.classId || "default",
  };
  await fs.writeFileBytes(`${studentId}/.identity.json`, encoder.encode(JSON.stringify(snapshot) + "\n"));

  const renamed: string[] = [];
  const renameFailed: string[] = [];
  for (const dir of dirs) {
    try {
      await fs.renameDir(dir, dir + MIGRATED_SUFFIX);
      renamed.push(dir);
    } catch (err) {
      // 改名失败仅记日志不致命：目录仍在原地会被 findLegacyDirs 重新找到，
      // 重跑会重复追加事件行——服务端按事件 id 幂等去重，安全
      renameFailed.push(dir);
      log?.(`[legacyMigrate] ${dir} 改名备份失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { kind: "done", surfaces: dirs, files, renamed, renameFailed };
}
