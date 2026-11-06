/**
 * 教师端代理 backend：学生端聊天请求经课堂服务器转发到大模型。
 * 学生端只需配置 pylearner.teacher.url，无需任何 LLM 配置；
 * model/密钥由服务器统一管理（服务器改模型，全班即时生效）。
 */
import type { LlmBackend, LlmMessage } from "./router";
import { consumeSseStream } from "./sse";

export interface TeacherBackendConfig {
  teacherUrl: string;
  /** 学号（配合服务器日志；无身份时不带头） */
  getStudentId?: () => string | undefined;
}

export class TeacherBackend implements LlmBackend {
  name = "teacher";
  private teacherUrl: string;

  constructor(config: TeacherBackendConfig) {
    this.teacherUrl = config.teacherUrl.replace(/\/+$/, "");
    this.getStudentId = config.getStudentId;
  }

  private getStudentId?: () => string | undefined;

  async chat(
    messages: LlmMessage[],
    onChunk: (text: string) => void,
    signal: AbortSignal
  ): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const studentId = this.getStudentId?.();
    if (studentId) headers["X-Student-Id"] = studentId;

    const resp = await fetch(`${this.teacherUrl}/api/llm/chat/completions`, {
      method: "POST",
      headers,
      // model 由服务器统一改写，这里不传
      body: JSON.stringify({
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
      signal,
    });

    if (!resp.ok) {
      const body = await resp.text();
      // 优先透传服务端的学生友好文案（如"学号不在名册中…""大模型访问失败…"）；
      // 解析不出 JSON 时按状态码兜底，不再暴露"教师端代理错误"这类技术话术
      let msg = "";
      try {
        msg = (JSON.parse(body) as { error?: string }).error ?? "";
      } catch { /* 非 JSON 响应，走状态码兜底 */ }
      if (!msg) {
        const FALLBACK: Record<number, string> = {
          403: "学号不在名册中，请核对身份页设置的学号，或联系教员",
          429: "大模型访问繁忙（限流），请稍后重试",
          502: "大模型访问失败，教师端大模型服务未开机或网络不通，请联系教员检查",
          503: "大模型访问失败，教师端大模型服务暂不可用，请联系教员",
          504: "大模型访问超时，请稍后重试",
        };
        msg = FALLBACK[resp.status] ?? "教师端服务异常，请稍后重试或联系教员";
      }
      throw new Error(msg);
    }

    await consumeSseStream(resp, onChunk);
  }
}
