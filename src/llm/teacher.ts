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
      throw new Error(`教师端代理错误 (${resp.status}): ${body.slice(0, 300)}`);
    }

    await consumeSseStream(resp, onChunk);
  }
}
