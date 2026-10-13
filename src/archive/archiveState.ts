// 归档位点（纯字符串逻辑，可脱离 vscode 单测）。
// 位点文件 trace/archive-state.json：{ "<studentId>/<surface>/<date>.jsonl": 已归档字节数 }
export type ArchiveOffsets = Record<string, number>;

export const OFFSETS_FILE = "archive-state.json";

export function offsetsKey(studentId: string, surface: string, date: string): string {
  return `${studentId}/${surface}/${date}.jsonl`;
}

/** 容错解析：缺文件/坏 JSON 返回空对象；非有限非负数字值丢弃 */
export function parseOffsets(json: string | null): ArchiveOffsets {
  if (!json) return {};
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const out: ArchiveOffsets = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number" && v >= 0 && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeOffsets(offsets: ArchiveOffsets): string {
  return JSON.stringify(offsets, null, 2);
}
