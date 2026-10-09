/**
 * 学生身份（学号/姓名）—— 纯逻辑，不 import vscode，可被单元测试直接覆盖。
 *
 * 存储选 globalState（Memento）而非 SecretStorage：
 * - 身份不是机密，不需要加密
 * - SecretStorage 在 Linux 依赖系统钥匙环（libsecret），精简机房环境可能不可用
 * - Memento.get 是同步内存读，上报时直接读取，改完立即生效，无需额外缓存
 *
 * UI（身份设置 webview 页）见 identityPage.ts。
 */
import { STATE_KEYS } from "../constants";

/** 最小存储接口（vscode.Memento / SecretStorage 均天然满足，测试用假实现即可） */
export interface KeyValueStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface StudentIdentity {
  studentId: string | null;
  studentName: string | null;
}

export interface StudentIdentityInput {
  studentId: string;
  studentName: string;
}

const MAX_LEN = 32;

/** 返回错误信息；合法返回 undefined（vscode validateInput 约定） */
export function validateStudentId(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return "学号不能为空";
  if (v.length > MAX_LEN) return `学号不能超过 ${MAX_LEN} 个字符`;
  return undefined;
}

export function validateStudentName(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return "姓名不能为空";
  if (v.length > MAX_LEN) return `姓名不能超过 ${MAX_LEN} 个字符`;
  return undefined;
}

export function loadStudentIdentity(state: KeyValueStore): StudentIdentity {
  const read = (key: string): string | null => {
    const v = state.get(key);
    return typeof v === "string" && v.trim() !== "" ? v : null;
  };
  return { studentId: read(STATE_KEYS.studentId), studentName: read(STATE_KEYS.studentName) };
}

export function hasStudentIdentity(state: KeyValueStore): boolean {
  return loadStudentIdentity(state).studentId !== null;
}

export async function saveStudentIdentity(
  state: KeyValueStore,
  identity: StudentIdentityInput
): Promise<void> {
  await state.update(STATE_KEYS.studentId, identity.studentId.trim());
  await state.update(STATE_KEYS.studentName, identity.studentName.trim());
}

/**
 * 一次性迁移：旧版本把身份写在 SecretStorage（SECRET_KEYS.student*），
 * 若 globalState 还没有值而 secrets 有，则拷贝过来（secrets 中的旧值保留不清理，无害）。
 */
export async function migrateLegacyIdentity(
  state: KeyValueStore,
  secrets: { get(key: string): PromiseLike<string | undefined> },
  legacyKeys: { studentId: string; studentName: string }
): Promise<boolean> {
  if (hasStudentIdentity(state)) return false;
  const id = await secrets.get(legacyKeys.studentId);
  if (!id) return false;
  const name = (await secrets.get(legacyKeys.studentName)) || id;
  await saveStudentIdentity(state, { studentId: id, studentName: name });
  return true;
}
