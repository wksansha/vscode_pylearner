import * as vscode from "vscode";
import { ulid } from "ulidx";
import type { LlmMessage, LlmRouter } from "../llm/router";
import type { L1Writer } from "../storage/l1Writer";
import type { ChatStore } from "../storage/chatStore";
import type { ChatSession, Message } from "../storage/chatStore";
import { getConfig } from "../settings/config";
import { MSG_TYPES, SECRET_KEYS } from "../constants";

export async function handleMessage(
  payload: Record<string, unknown>,
  webview: vscode.Webview,
  secrets: vscode.SecretStorage,
  router: LlmRouter,
  l1Writer: L1Writer,
  chatStore: ChatStore,
  abortRef: { current: AbortController | null }
): Promise<void> {
  try {
    switch (payload.type) {
      case MSG_TYPES.chat: {
        const userText = payload.text as string;
        if (!userText?.trim()) return;

        // Refresh router config; the API key comes from SecretStorage so it
        // never touches settings.json (Settings Sync would leak it).
        router.refreshConfig();
        const apiKey = (await secrets.get(SECRET_KEYS.llmApiKey)) ?? "";
        const backend = router.resolve(apiKey);

        // Build messages array from current session
        const sessionId = (payload.sessionId as string) ?? ulid();
        let session = (await chatStore.getSession(sessionId)) ?? {
          id: sessionId,
          title: userText.slice(0, 50),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
        };

        // Add user message
        const userMsg: Message = {
          role: "user",
          text: userText,
          ts: new Date().toISOString(),
        };
        session.messages.push(userMsg);
        await l1Writer.append("chat", "user_message", {
          text: userText,
          session_id: sessionId,
          model: router.getModelName(),
        });
        await chatStore.saveSession(session);

        // Convert to LLM format
        const llmMessages: LlmMessage[] = session.messages.map((m) => ({
          role: m.role === "assistant" ? "assistant" as const : "user" as const,
          content: m.text,
        }));

        // System prompt
        llmMessages.unshift({
          role: "system" as const,
          content:
            "You are a helpful Python learning assistant. Provide clear, concise explanations with code examples when relevant.",
        });

        // Stream response
        const aborter = new AbortController();
        abortRef.current = aborter;

        let fullResponse = "";

        try {
          await backend.chat(
            llmMessages,
            (chunk: string) => {
              fullResponse += chunk;
              webview.postMessage({ type: MSG_TYPES.stream, chunk, sessionId });
            },
            aborter.signal
          );
        } finally {
          abortRef.current = null;
        }

        // Save assistant message
        const assistantMsg: Message = {
          role: "assistant",
          text: fullResponse,
          ts: new Date().toISOString(),
          model: router.getModelName(),
        };
        session.messages.push(assistantMsg);
        await l1Writer.append("chat", "assistant_response", {
          text: fullResponse.slice(0, 500),
          model: router.getModelName(),
          session_id: sessionId,
        });
        await chatStore.saveSession(session);

        webview.postMessage({
          type: MSG_TYPES.done,
          sessionId,
        });
        break;
      }

      case MSG_TYPES.abort: {
        // Abort the in-flight request (if any). The chat case stores the
        // controller in the shared ref; aborting a stale/null ref is a no-op.
        abortRef.current?.abort();
        abortRef.current = null;
        break;
      }

      case MSG_TYPES.getConfig: {
        const config = getConfig();
        const apiKey = (await secrets.get(SECRET_KEYS.llmApiKey)) ?? "";
        webview.postMessage({
          type: MSG_TYPES.config,
          config: { ...config.llm, apiKey },
        });
        break;
      }

      case MSG_TYPES.saveConfig: {
        const config = payload.config as Record<string, string>;
        const cfg = vscode.workspace.getConfiguration();
        if (config.provider) {
          await cfg.update(
            "pylearner.llm.provider",
            config.provider,
            vscode.ConfigurationTarget.Global
          );
        }
        if (config.model !== undefined) {
          await cfg.update(
            "pylearner.llm.model",
            config.model,
            vscode.ConfigurationTarget.Global
          );
        }
        if (config.apiKey !== undefined) {
          await secrets.store(SECRET_KEYS.llmApiKey, config.apiKey);
        }
        if (config.baseUrl) {
          await cfg.update(
            "pylearner.llm.baseUrl",
            config.baseUrl,
            vscode.ConfigurationTarget.Global
          );
        }
        router.refreshConfig();
        const savedKey = (await secrets.get(SECRET_KEYS.llmApiKey)) ?? "";
        webview.postMessage({
          type: MSG_TYPES.config,
          config: { ...getConfig().llm, apiKey: savedKey },
        });
        break;
      }

      case MSG_TYPES.loadSessions: {
        const sessions = await chatStore.listSessions();
        webview.postMessage({
          type: MSG_TYPES.sessionsList,
          sessions: sessions.map((s) => ({
            id: s.id,
            title: s.title,
            updatedAt: s.updatedAt,
            messageCount: s.messages.length,
          })),
        });
        break;
      }

      case MSG_TYPES.loadSession: {
        const sessionId = payload.sessionId as string;
        if (!sessionId) return;
        const session = await chatStore.getSession(sessionId);
        if (!session) {
          webview.postMessage({
            type: MSG_TYPES.error,
            message: `Session not found: ${sessionId}`,
          });
          break;
        }
        webview.postMessage({
          type: MSG_TYPES.sessionLoaded,
          sessionId: session.id,
          messages: session.messages,
        });
        break;
      }

      case MSG_TYPES.deleteSession: {
        const sessionId = payload.sessionId as string;
        if (!sessionId) return;
        await chatStore.deleteSession(sessionId);
        const sessions = await chatStore.listSessions();
        webview.postMessage({
          type: MSG_TYPES.sessionsList,
          sessions: sessions.map((s) => ({
            id: s.id,
            title: s.title,
            updatedAt: s.updatedAt,
            messageCount: s.messages.length,
          })),
        });
        break;
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    webview.postMessage({ type: MSG_TYPES.error, message });
  }
}
