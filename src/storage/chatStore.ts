import * as vscode from "vscode";

export interface Message {
  role: "user" | "assistant";
  text: string;
  ts: string;
  model?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

const INDEX_FILE = "index.json";

export class ChatStore {
  private baseUri: vscode.Uri;
  private sessionsUri: vscode.Uri;

  constructor(storageUri: vscode.Uri) {
    this.baseUri = vscode.Uri.joinPath(storageUri, "chats");
    this.sessionsUri = vscode.Uri.joinPath(this.baseUri, "sessions");
  }

  private async ensureDirs(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.baseUri);
    } catch {}
    try {
      await vscode.workspace.fs.createDirectory(this.sessionsUri);
    } catch {}
  }

  async listSessions(): Promise<ChatSession[]> {
    await this.ensureDirs();
    const indexUri = vscode.Uri.joinPath(this.baseUri, INDEX_FILE);
    try {
      const data = await vscode.workspace.fs.readFile(indexUri);
      const ids: string[] = JSON.parse(new TextDecoder().decode(data));
      const sessions: ChatSession[] = [];
      for (const id of ids) {
        const s = await this.getSession(id);
        if (s) sessions.push(s);
      }
      return sessions.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    } catch {
      return [];
    }
  }

  async getSession(id: string): Promise<ChatSession | null> {
    const fileUri = vscode.Uri.joinPath(this.sessionsUri, `${id}.json`);
    try {
      const data = await vscode.workspace.fs.readFile(fileUri);
      return JSON.parse(new TextDecoder().decode(data)) as ChatSession;
    } catch {
      return null;
    }
  }

  async saveSession(session: ChatSession): Promise<void> {
    await this.ensureDirs();
    session.updatedAt = new Date().toISOString();
    const fileUri = vscode.Uri.joinPath(this.sessionsUri, `${session.id}.json`);
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(
      fileUri,
      encoder.encode(JSON.stringify(session, null, 2))
    );
    // Update index
    const indexUri = vscode.Uri.joinPath(this.baseUri, INDEX_FILE);
    let ids: string[] = [];
    try {
      const data = await vscode.workspace.fs.readFile(indexUri);
      ids = JSON.parse(new TextDecoder().decode(data));
    } catch {}
    if (!ids.includes(session.id)) {
      ids.unshift(session.id);
    }
    await vscode.workspace.fs.writeFile(
      indexUri,
      encoder.encode(JSON.stringify(ids))
    );
  }

  async deleteSession(id: string): Promise<void> {
    const fileUri = vscode.Uri.joinPath(this.sessionsUri, `${id}.json`);
    try {
      await vscode.workspace.fs.delete(fileUri);
    } catch {}
    const indexUri = vscode.Uri.joinPath(this.baseUri, INDEX_FILE);
    try {
      const data = await vscode.workspace.fs.readFile(indexUri);
      const ids: string[] = JSON.parse(new TextDecoder().decode(data));
      const filtered = ids.filter((i) => i !== id);
      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(
        indexUri,
        encoder.encode(JSON.stringify(filtered))
      );
    } catch {}
  }
}
