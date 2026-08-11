import * as vscode from "vscode";
import type { LlmBackend, LlmMessage } from "./router";

export class VscodeLmBackend implements LlmBackend {
  name = "vscode-lm";

  async chat(
    messages: LlmMessage[],
    onChunk: (text: string) => void,
    signal: AbortSignal
  ): Promise<void> {
    const [model] = await vscode.lm.selectChatModels({
      vendor: "copilot",
      family: "gpt-4o",
    });
    if (!model) {
      throw new Error(
        "No VS Code language model available. Install GitHub Copilot or switch to another provider in Settings."
      );
    }

    const mapped = messages.map((m) =>
      m.role === "assistant"
        ? vscode.LanguageModelChatMessage.Assistant(m.content)
        : vscode.LanguageModelChatMessage.User(m.content)
    );

    const tokenSource = new vscode.CancellationTokenSource();
    const onAbort = () => tokenSource.cancel();
    signal.addEventListener("abort", onAbort);

    try {
      const response = await model.sendRequest(mapped, {}, tokenSource.token);
      for await (const fragment of response.text) {
        onChunk(fragment);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      tokenSource.dispose();
    }
  }
}