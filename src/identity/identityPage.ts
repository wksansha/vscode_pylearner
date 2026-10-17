import * as vscode from "vscode";
import { saveStudentIdentity, loadStudentIdentity, type KeyValueStore } from "./studentIdentity";
import { studentDirName, UNKNOWN_DIR } from "../archive/identity";
import { SECRET_KEYS, STATE_KEYS } from "../constants";

/** 离线兜底前置检查：学号必须能作为本地目录名/服务器路径段，否则事件将落 unknown/ 永不归档（spec §4.1） */
export function localIdErrorText(studentId: string): string | undefined {
  if (studentDirName(studentId) === UNKNOWN_DIR) {
    return "学号仅允许字母、数字、中划线、下划线（≤32 位，不可为保留字），请修改后重试";
  }
  return undefined;
}

export interface IdentityPageDeps {
  teacherUrl: () => string;
  fetchImpl?: typeof fetch;
  onSaved: (identity: { studentId: string; studentName: string }) => void;
  /** 一键换机（可选）：旧身份存在且学号变化时启用。
   * beforeSwitch = 确认 + 用旧身份 git 提交归档当前工作区（false = 中止，不保存新身份）；
   * afterSwitch = 保存新身份后 checkout 新分支并同步作业（见 switchFlow.ts，按新学号执行）。 */
  switchFlow?: {
    beforeSwitch: (oldId: string, newId: string) => Promise<boolean>;
    afterSwitch: (newId: string) => Promise<void>;
    /** 学期更替（spec roster §3）：previousIdInRoster=false 时触发；确认+清空工作区。
     * true=已清空可继续；false=中止。未接线时该分叉安全降级为中止（不误入归档死锁）。 */
    semesterReset?: (oldId: string, newId: string) => Promise<boolean>;
  };
}

/** A25 错误码→文案（与 server validateIdentity 的 message 逐字一致） */
export function identityErrorText(code: string): string {
  switch (code) {
    case "roster_empty": return "教师尚未导入名册，请联系教员后再试";
    case "student_id_not_found": return "学号输入有误，请检查或联系教员";
    case "name_mismatch": return "姓名与该学号不匹配，请检查或联系教员";
    default: return "校验失败，请稍后重试";
  }
}

let currentPanel: vscode.WebviewPanel | undefined;

type IdentityContext = { globalState: KeyValueStore } & vscode.ExtensionContext;

/** 服务端下发的 gitSecret（学生 Gitea 密码）存 SecretStorage（与 llm.apiKey 同待遇，不落配置/日志；null/缺失 = 未开通，静默跳过） */
async function storeGitSecret(context: IdentityContext, secret: string | null | undefined): Promise<void> {
  if (secret) await context.secrets.store(SECRET_KEYS.gitSecret, secret);
}

export function openIdentityPage(deps: IdentityPageDeps, context: IdentityContext): void {
  if (currentPanel) { currentPanel.reveal(); return; }
  currentPanel = vscode.window.createWebviewPanel(
    "pylearner.identity", "课堂助手 · 身份设置", vscode.ViewColumn.One, { enableScripts: true });
  currentPanel.webview.html = IDENTITY_HTML;
  currentPanel.webview.onDidReceiveMessage(async (msg: { type: string; studentId?: string; studentName?: string }) => {
    if (msg.type !== "submit" || !msg.studentId?.trim() || !msg.studentName?.trim()) return;
    const studentId = msg.studentId.trim();
    const studentName = msg.studentName.trim();
    // 本地把关学号合法性：非法学号即使保存也只会落 unknown/（归不到人），直接拒绝
    const localErr = localIdErrorText(studentId);
    if (localErr) {
      currentPanel?.webview.postMessage({ type: "result", ok: false, message: localErr });
      return;
    }
    const doFetch = deps.fetchImpl ?? fetch;
    // 先读旧身份：validate 请求携带 previousStudentId，服务端据此裁决 previousIdInRoster（spec roster §2）
    const oldId = loadStudentIdentity(context.globalState).studentId;
    try {
      const res = await doFetch(`${deps.teacherUrl()}/api/identity/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, studentName, ...(oldId ? { previousStudentId: oldId } : {}) }),
      });
      const body = await res.json() as { ok?: boolean; studentName?: string; code?: string; gitSecret?: string | null; previousIdInRoster?: boolean; gitRepoUrl?: string };
      if (res.ok && body.ok) {
        const identity = { studentId, studentName: body.studentName ?? studentName };
        const flow = deps.switchFlow;
        const isSwitch = flow !== undefined && oldId !== identity.studentId;
        if (isSwitch && flow) {
          if (oldId !== null) {
            if (body.previousIdInRoster === false) {
              // 学期更替（spec roster §3）：旧学号已不在名册 → 不归档（无凭证可归档），确认后清空工作区
              const ok = flow.semesterReset ? await flow.semesterReset(oldId, identity.studentId) : false;
              if (!ok) {
                currentPanel?.webview.postMessage({ type: "result", ok: false, message: "已取消或重置未完成，身份未切换，工作区已保留" });
                return;
              }
            } else {
              // 现有一键换机：previousIdInRoster=true，或字段缺省（旧服务端向后兼容）
              const ok = await flow.beforeSwitch(oldId, identity.studentId);
              if (!ok) {
                currentPanel?.webview.postMessage({ type: "result", ok: false, message: "已取消或归档未完成，身份未切换，工作区已保留" });
                return;
              }
            }
          }
          // 归档/清空成功后才存新 gitSecret（beforeSwitch 推旧分支必须用旧凭证）
          await storeGitSecret(context, body.gitSecret);
          await saveStudentIdentity(context.globalState, identity);
          await flow.afterSwitch(identity.studentId);
        } else {
          await storeGitSecret(context, body.gitSecret);   // 同学号重存 = 补领/刷新凭证
          await saveStudentIdentity(context.globalState, identity);   // A25：校验通过才保存（名册规范姓名）
        }
        // 服务端下发的课堂仓库地址缓存 globalState（学生机零配置；教师本机调试可用 settings pylearner.gitRepoUrl 覆盖）
        if (body.gitRepoUrl) await context.globalState.update(STATE_KEYS.gitRepoUrl, body.gitRepoUrl);
        currentPanel?.webview.postMessage({ type: "result", ok: true, message: `✅ 身份已保存：${identity.studentId} ${identity.studentName}` });
        if (!body.gitSecret) {
          // 非阻断提示：提交/拉取/同步需要 gitSecret，其他功能（运行/评审/归档）不受影响
          currentPanel?.webview.postMessage({
            type: "result", ok: false,
            message: "服务器尚未开通你的 Git 账户，提交/同步功能暂不可用，请联系教师",
          });
          setTimeout(() => currentPanel?.dispose(), 8_000);   // 留出阅读提示的时间
        } else {
          setTimeout(() => currentPanel?.dispose(), 1_200);
        }
        deps.onSaved(identity);
      } else {
        currentPanel?.webview.postMessage({ type: "result", ok: false, message: identityErrorText(body.code ?? "") });
      }
    } catch {
      // 离线兜底（教师端不可达）：本地保存身份，事件照常落学号目录。
      // 联网后激活时的名册复核自动自愈——不符则重新弹身份页要求修正（A25 语义仅在线时强制）。
      await saveStudentIdentity(context.globalState, { studentId, studentName });
      currentPanel?.webview.postMessage({
        type: "result",
        ok: true,
        message: `⚠️ 服务器暂不可达，已离线保存：${studentId} ${studentName}。联网后将自动与名册核对。`,
      });
      setTimeout(() => currentPanel?.dispose(), 2_500);
      deps.onSaved({ studentId, studentName });
    }
  });
  currentPanel.onDidDispose(() => { currentPanel = undefined; });
}

const IDENTITY_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body{font-family:system-ui,sans-serif;padding:24px;max-width:420px}
  input{display:block;width:100%;padding:8px;margin:8px 0;box-sizing:border-box}
  button{padding:8px 28px}
  .msg{margin-top:12px;min-height:20px}
  .err{color:#dc2626}.ok{color:#16a34a}
</style></head><body>
<h2>课堂助手 · 身份设置</h2>
<p>请输入学号与姓名（用于课堂监控与作业提交；教师端在线时经名册校验，不可达时可离线保存、联网后自动核对）</p>
<input id="sid" placeholder="学号，如 20260001" />
<input id="sname" placeholder="姓名，如 张三" />
<button onclick="submit()">提交校验</button>
<p class="msg" id="msg"></p>
<script>
  const vscode = acquireVsCodeApi();
  function submit() {
    const studentId = document.getElementById('sid').value.trim();
    const studentName = document.getElementById('sname').value.trim();
    document.getElementById('msg').textContent = '校验中…';
    vscode.postMessage({ type: 'submit', studentId, studentName });
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    const el = document.getElementById('msg');
    el.textContent = m.message;
    el.className = 'msg ' + (m.ok ? 'ok' : 'err');
  });
</script></body></html>`;
