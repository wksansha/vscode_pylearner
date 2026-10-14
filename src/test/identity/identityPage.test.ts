import { describe, it, expect, vi, beforeEach } from "vitest";
import { identityErrorText, maybeOpenIdentityPage, localIdErrorText, openIdentityPage, type IdentityPageDeps } from "../../identity/identityPage";
import type { KeyValueStore } from "../../identity/studentIdentity";

// vscode mock：每次 createWebviewPanel 生成新面板并登记到 __testHooks，
// dispose 触发 identityPage 的 onDidDispose 单例复位，保证测试间隔离。
vi.mock("vscode", () => {
  const state = {
    handlers: [] as Array<(msg: unknown) => void>,
    postMessage: { mock: { calls: [] as Array<[unknown]> }, calls: [] as Array<[unknown]> },
    lastPanel: undefined as undefined | { dispose: () => void },
  };
  const postMessage = vi.fn(async (msg: unknown) => {
    state.postMessage.calls.push([msg]);
    return true;
  });
  const hooks = {
    handlers: state.handlers,
    get postMessage() { return postMessage; },
    get lastPanel() { return state.lastPanel; },
  };
  return {
    window: {
      createWebviewPanel: vi.fn(() => {
        let onDispose: (() => void) | undefined;
        const panel = {
          webview: {
            html: "",
            onDidReceiveMessage: (cb: (msg: unknown) => void) => { state.handlers.push(cb); },
            postMessage,
          },
          onDidDispose: (cb: () => void) => { onDispose = cb; },
          reveal: () => {},
          dispose: () => { onDispose?.(); },
        };
        state.lastPanel = panel;
        return panel;
      }),
    },
    ViewColumn: { One: 1 },
    __testHooks: hooks,
  };
});

interface TestHooks {
  handlers: Array<(msg: unknown) => void>;
  postMessage: { mock: { calls: Array<[unknown]> }; calls: Array<[unknown]> };
  lastPanel?: { dispose: () => void };
}

async function getHooks(): Promise<TestHooks> {
  const vscode = await import("vscode");
  return (vscode as unknown as { __testHooks: TestHooks }).__testHooks;
}

function makeStore(): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: (key: string) => data.get(key),
    update: async (key: string, value: unknown) => { data.set(key, value); },
  };
}

function makeDeps(fetchImpl: unknown, onSaved: (i: { studentId: string; studentName: string }) => void = () => {}): IdentityPageDeps {
  return { teacherUrl: () => "http://x:3000", fetchImpl: fetchImpl as typeof fetch, onSaved };
}

async function submit(deps: IdentityPageDeps, store: KeyValueStore, studentId: string, studentName: string) {
  openIdentityPage(deps, { globalState: store } as never);
  const h = await getHooks();
  const handler = h.handlers.at(-1)!;
  await handler({ type: "submit", studentId, studentName });
  return h;
}

beforeEach(async () => {
  const h = await getHooks();
  h.lastPanel?.dispose();   // 复位 identityPage 单例面板
  vi.clearAllMocks();
});

describe("localIdErrorText（离线兜底：学号须可作为目录名/路径段）", () => {
  it("合法学号返回 undefined", () => {
    expect(localIdErrorText("2024001")).toBeUndefined();
    expect(localIdErrorText("abc_123-X")).toBeUndefined();
  });
  it("中文/路径字符/保留字/超长 → 报错文案", () => {
    expect(localIdErrorText("2024-01班")).toContain("学号仅允许");
    expect(localIdErrorText("../x")).toContain("学号仅允许");
    expect(localIdErrorText("unknown")).toContain("学号仅允许");
    expect(localIdErrorText("edit")).toContain("学号仅允许");
    expect(localIdErrorText("a".repeat(33))).toContain("学号仅允许");
  });
});

describe("离线兜底：validate 请求失败 → 本地保存身份", () => {
  it("fetch 抛错 → 身份保存 globalState + postMessage ok + onSaved 回调", async () => {
    const onSaved = vi.fn();
    const store = makeStore();
    await submit(makeDeps(vi.fn().mockRejectedValue(new Error("ECONNREFUSED")), onSaved), store, "2024001", "张三");

    expect(store.data.get("pylearner.identity.studentId")).toBe("2024001");
    expect(store.data.get("pylearner.identity.studentName")).toBe("张三");
    const h = await getHooks();
    const last = h.postMessage.mock.calls.at(-1)![0] as { ok: boolean; message: string };
    expect(last.ok).toBe(true);
    expect(last.message).toContain("离线保存");
    expect(onSaved).toHaveBeenCalledWith({ studentId: "2024001", studentName: "张三" });
  });

  it("本地学号校验不通过 → 拒绝且不发起 fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const results = await submit(makeDeps(fetchImpl), makeStore(), "2024-01班", "张三");
    const h = await getHooks();
    const last = h.postMessage.mock.calls.at(-1)![0] as { ok: boolean; message: string };
    expect(last.ok).toBe(false);
    expect(last.message).toContain("学号仅允许");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("名册明确拒绝（请求成功但 ok=false）→ 仍不保存（离线兜底只豁免网络失败）", async () => {
    const store = makeStore();
    await submit(
      makeDeps(vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, code: "student_id_not_found" }), { status: 200 }))),
      store, "9999999", "李四",
    );
    expect(store.data.has("pylearner.identity.studentId")).toBe(false);
  });
});

describe("identityErrorText（A25 文案逐字）", () => {
  it("四类错误码映射", () => {
    expect(identityErrorText("roster_empty")).toBe("教师尚未导入名册，请联系教员后再试");
    expect(identityErrorText("student_id_not_found")).toBe("学号输入有误，请检查或联系教员");
    expect(identityErrorText("name_mismatch")).toBe("姓名与该学号不匹配，请检查或联系教员");
    expect(identityErrorText("whatever")).toBe("校验失败，请稍后重试");
  });
});

describe("maybeOpenIdentityPage 节流（A8）", () => {
  const noop = () => {};
  const ctx = {} as never;
  it("有身份不打开；无身份 60s 内只打开一次", () => {
    const open = vi.fn();
    let now = 1_000_000;
    // 用假 now 注入测试节流（实现签名带 now 参数）
    expect(maybeOpenIdentityPage({ teacherUrl: () => "", onSaved: noop } as never, ctx, { studentId: "0001" }, 60_000, () => now, open)).toBe(false);
    expect(maybeOpenIdentityPage({ teacherUrl: () => "", onSaved: noop } as never, ctx, { studentId: null }, 60_000, () => now, open)).toBe(true);
    now += 30_000;
    expect(maybeOpenIdentityPage({ teacherUrl: () => "", onSaved: noop } as never, ctx, { studentId: null }, 60_000, () => now, open)).toBe(false);   // 节流中
    now += 31_000;
    expect(maybeOpenIdentityPage({ teacherUrl: () => "", onSaved: noop } as never, ctx, { studentId: null }, 60_000, () => now, open)).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
  });
});
