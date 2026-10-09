import * as vscode from "vscode";
import { saveStudentIdentity, type KeyValueStore } from "./studentIdentity";

export interface IdentityPageDeps {
  teacherUrl: () => string;
  fetchImpl?: typeof fetch;
  onSaved: (identity: { studentId: string; studentName: string }) => void;
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
let lastOpenAt = 0;

type IdentityContext = { globalState: KeyValueStore } & vscode.ExtensionContext;

export function openIdentityPage(deps: IdentityPageDeps, context: IdentityContext): void {
  if (currentPanel) { currentPanel.reveal(); return; }
  currentPanel = vscode.window.createWebviewPanel(
    "pylearner.identity", "课堂助手 · 身份设置", vscode.ViewColumn.One, { enableScripts: true });
  currentPanel.webview.html = IDENTITY_HTML;
  currentPanel.webview.onDidReceiveMessage(async (msg: { type: string; studentId?: string; studentName?: string }) => {
    if (msg.type !== "submit" || !msg.studentId?.trim() || !msg.studentName?.trim()) return;
    const doFetch = deps.fetchImpl ?? fetch;
    try {
      const res = await doFetch(`${deps.teacherUrl()}/api/identity/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: msg.studentId.trim(), studentName: msg.studentName.trim() }),
      });
      const body = await res.json() as { ok?: boolean; studentName?: string; code?: string };
      if (res.ok && body.ok) {
        const identity = { studentId: msg.studentId.trim(), studentName: body.studentName ?? msg.studentName.trim() };
        await saveStudentIdentity(context.globalState, identity);   // A25：校验通过才保存（名册规范姓名）
        currentPanel?.webview.postMessage({ type: "result", ok: true, message: `✅ 身份已保存：${identity.studentId} ${identity.studentName}` });
        setTimeout(() => currentPanel?.dispose(), 1_200);
        deps.onSaved(identity);
      } else {
        currentPanel?.webview.postMessage({ type: "result", ok: false, message: identityErrorText(body.code ?? "") });
      }
    } catch {
      currentPanel?.webview.postMessage({ type: "result", ok: false, message: "无法连接教师端服务器，请检查网络后重试" });
    }
  });
  currentPanel.onDidDispose(() => { currentPanel = undefined; });
}

/** 节流打开（A8）：未设身份期间由运行/提交触发，60s 一次；open 可注入（测试） */
export function maybeOpenIdentityPage(
  deps: IdentityPageDeps,
  context: IdentityContext,
  state: { studentId: string | null },
  throttleMs = 60_000,
  now: () => number = Date.now,
  open: typeof openIdentityPage = openIdentityPage,
): boolean {
  if (state.studentId) return false;
  if (now() - lastOpenAt < throttleMs) return false;
  lastOpenAt = now();
  open(deps, context);
  return true;
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
<p>请输入学号与姓名（用于课堂监控与作业提交，须经教师端名册校验）</p>
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
