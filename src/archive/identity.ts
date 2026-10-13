// 归档相关的学号目录名规则（纯函数，不 import vscode）。
// 本地布局：trace/<studentId>/<surface>/<date>.jsonl；未设身份/学号非法 → trace/unknown/（永不归档）。
import { SURFACES } from "../constants";

export const UNKNOWN_DIR = "unknown";

const STUDENT_DIR_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_LEN = 32; // 与 validateStudentId 的 MAX_LEN 对齐

/** 学号 → 本地 trace 子目录名；不合法（空/超长/非法字符/与保留字或 surface 名冲突）一律 unknown */
export function studentDirName(studentId: string | null | undefined): string {
  if (!studentId) return UNKNOWN_DIR;
  const v = studentId.trim();
  if (!v || v.length > MAX_LEN || !STUDENT_DIR_PATTERN.test(v)) return UNKNOWN_DIR;
  if (v === UNKNOWN_DIR || (SURFACES as readonly string[]).includes(v)) return UNKNOWN_DIR;
  return v;
}

/** trace/ 顶层目录名是否为可归档学号目录（排除 unknown、旧布局顶层 surface 目录、非法名） */
export function isArchivableDirName(name: string): boolean {
  if (name === UNKNOWN_DIR) return false;
  if ((SURFACES as readonly string[]).includes(name)) return false;
  return name.length <= MAX_LEN && STUDENT_DIR_PATTERN.test(name);
}
