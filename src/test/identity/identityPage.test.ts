import { describe, it, expect, vi, beforeEach } from "vitest";
import { identityErrorText, localIdErrorText, openIdentityPage, type IdentityPageDeps } from "../../identity/identityPage";
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

type SecretsSpy = { store: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; stored: Map<string, string> };

function makeSecrets(): SecretsSpy {
  const stored = new Map<string, string>();
  const store = vi.fn(async (key: string, value: string) => { stored.set(key, value); });
  const get = vi.fn(async (key: string) => stored.get(key));
  return { store, get, stored };
}

function makeDeps(fetchImpl: unknown, onSaved: (i: { studentId: string; studentName: string }) => void = () => {}): IdentityPageDeps {
  return { teacherUrl: () => "http://x:3000", fetchImpl: fetchImpl as typeof fetch, onSaved };
}

async function submit(deps: IdentityPageDeps, store: KeyValueStore, studentId: string, studentName: string, secrets?: SecretsSpy) {
  const spied = secrets ?? makeSecrets();
  openIdentityPage(deps, { globalState: store, secrets: spied } as never);
  const h = await getHooks();
  const handler = h.handlers.at(-1)!;
  await handler({ type: "submit", studentId, studentName });
  return { h, secrets: spied };
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
    await submit(makeDeps(fetchImpl), makeStore(), "2024-01班", "张三");
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

describe("gitSecret 下发（身份校验响应携带学生 Gitea 密码，git Basic 认证用）", () => {
  it("响应含 gitSecret → 存入 secrets（key: pylearner.git.secret），无额外提示", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, gitSecret: "tok-abc123" }), { status: 200 }));
    const { secrets } = await submit(makeDeps(fetchImpl), makeStore(), "2024001", "张三");

    expect(secrets.stored.get("pylearner.git.secret")).toBe("tok-abc123");
    const h = await getHooks();
    const last = h.postMessage.mock.calls.at(-1)![0] as { ok: boolean; message: string };
    expect(last.ok).toBe(true);
    expect(last.message).toContain("身份已保存");
  });

  it("响应无 gitSecret → 不写 secrets，webview 提示未开通 Git 账户（非阻断）", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const onSaved = vi.fn();
    const { secrets, h } = await submit(makeDeps(fetchImpl, onSaved), makeStore(), "2024001", "张三");

    expect(secrets.stored.size).toBe(0);
    const last = h.postMessage.mock.calls.at(-1)![0] as { ok: boolean; message: string };
    expect(last.ok).toBe(false);
    expect(last.message).toContain("服务器尚未开通你的 Git 账户");
    expect(onSaved).toHaveBeenCalled();   // 非阻断：身份照常保存
  });

  it("gitSecret 为 null → 同未开通处理", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, gitSecret: null }), { status: 200 }));
    const { secrets, h } = await submit(makeDeps(fetchImpl), makeStore(), "2024001", "张三");

    expect(secrets.stored.size).toBe(0);
    const last = h.postMessage.mock.calls.at(-1)![0] as { ok: boolean; message: string };
    expect(last.message).toContain("服务器尚未开通你的 Git 账户");
  });

  it("换机归档成功后才存新 gitSecret（beforeSwitch 推旧分支用旧凭证）", async () => {
    const order: string[] = [];
    const store = makeStore();
    await store.update("pylearner.identity.studentId", "2025001");   // 旧身份
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, gitSecret: "tok-B" }), { status: 200 }));
    const deps: IdentityPageDeps = {
      ...makeDeps(fetchImpl),
      switchFlow: {
        beforeSwitch: async () => { order.push("beforeSwitch"); return true; },
        afterSwitch: async () => { order.push("afterSwitch"); },
      },
    };
    const { secrets } = await submit(deps, store, "2025002", "李四");

    expect(order).toEqual(["beforeSwitch", "afterSwitch"]);
    expect(secrets.stored.get("pylearner.git.secret")).toBe("tok-B");
    expect(store.data.get("pylearner.identity.studentId")).toBe("2025002");
  });

  it("F1 首次设置身份（无旧身份）→ 不归档（beforeSwitch 不调），保存后仍走 afterSwitch 分支保障", async () => {
    const order: string[] = [];
    const store = makeStore();   // 无旧身份（oldId=null）
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, gitSecret: "tok-A" }), { status: 200 }));
    const deps: IdentityPageDeps = {
      ...makeDeps(fetchImpl),
      switchFlow: {
        beforeSwitch: async () => { order.push("beforeSwitch"); return true; },
        afterSwitch: async () => { order.push("afterSwitch"); },
      },
    };
    const { secrets } = await submit(deps, store, "2024001", "张三");

    expect(order).toEqual(["afterSwitch"]);   // 跳过归档，仍走分支保障
    expect(secrets.stored.get("pylearner.git.secret")).toBe("tok-A");
    expect(store.data.get("pylearner.identity.studentId")).toBe("2024001");
    const h = await getHooks();
    const last = h.postMessage.mock.calls.at(-1)![0] as { ok: boolean; message: string };
    expect(last.ok).toBe(true);
  });

  it("F1 归档语义保留：旧身份存在且学号变化时 beforeSwitch 失败仍中止切换", async () => {
    const order: string[] = [];
    const store = makeStore();
    await store.update("pylearner.identity.studentId", "2025001");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, gitSecret: "tok-B" }), { status: 200 }));
    const deps: IdentityPageDeps = {
      ...makeDeps(fetchImpl),
      switchFlow: {
        beforeSwitch: async () => { order.push("beforeSwitch"); return false; },
        afterSwitch: async () => { order.push("afterSwitch"); },
      },
    };
    const { secrets } = await submit(deps, store, "2025002", "李四");

    expect(order).toEqual(["beforeSwitch"]);   // 归档失败：不保存新身份、不走 afterSwitch
    expect(secrets.stored.size).toBe(0);
    expect(store.data.get("pylearner.identity.studentId")).toBe("2025001");
  });
});

describe("gitRepoUrl 下发（身份校验响应携带课堂仓库地址，学生机零配置）", () => {
  it("响应含 gitRepoUrl → 缓存 globalState（key: pylearner.identity.gitRepoUrl）", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, gitSecret: "tok-abc", gitRepoUrl: "http://192.168.1.100:3001/classroom/exercises.git",
    }), { status: 200 }));
    const store = makeStore();
    await submit(makeDeps(fetchImpl), store, "2024001", "张三");

    expect(store.data.get("pylearner.identity.gitRepoUrl")).toBe("http://192.168.1.100:3001/classroom/exercises.git");
  });

  it("响应无 gitRepoUrl → 不写 globalState（身份照常保存）", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, gitSecret: "tok-abc" }), { status: 200 }));
    const store = makeStore();
    await submit(makeDeps(fetchImpl), store, "2024001", "张三");

    expect(store.data.has("pylearner.identity.gitRepoUrl")).toBe(false);
    expect(store.data.get("pylearner.identity.studentId")).toBe("2024001");
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

describe("三分叉切换（spec roster §3：名册感知）", () => {
  it("旧身份存在时 validate 请求体携带 previousStudentId", async () => {
    const store = makeStore();
    await store.update("pylearner.identity.studentId", "2025001");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, gitSecret: "tok-A" }), { status: 200 }));
    await submit(makeDeps(fetchImpl), store, "2025001", "张三");   // 同学号重存也带
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].body).toBe(
      JSON.stringify({ studentId: "2025001", studentName: "张三", previousStudentId: "2025001" }));
  });

  it("previousIdInRoster=false → semesterReset → 保存新身份 → afterSwitch（不触碰 beforeSwitch 归档）", async () => {
    const order: string[] = [];
    const store = makeStore();
    await store.update("pylearner.identity.studentId", "2025001");   // 旧学号（已不在名册）
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, gitSecret: "tok-B", previousIdInRoster: false }), { status: 200 }));
    const deps: IdentityPageDeps = {
      ...makeDeps(fetchImpl),
      switchFlow: {
        beforeSwitch: async () => { order.push("beforeSwitch"); return true; },
        afterSwitch: async () => { order.push("afterSwitch"); },
        semesterReset: async () => { order.push("semesterReset"); return true; },
      },
    };
    const { secrets } = await submit(deps, store, "2026001", "李四");

    expect(order).toEqual(["semesterReset", "afterSwitch"]);   // 死锁修复：不再走 beforeSwitch 归档
    expect(secrets.stored.get("pylearner.git.secret")).toBe("tok-B");
    expect(store.data.get("pylearner.identity.studentId")).toBe("2026001");
    const h = await getHooks();
    const last = h.postMessage.mock.calls.at(-1)![0] as { ok: boolean; message: string };
    expect(last.ok).toBe(true);
  });

  it("previousIdInRoster=false + semesterReset 返回 false → 中止：身份不保存、不走 afterSwitch", async () => {
    const order: string[] = [];
    const store = makeStore();
    await store.update("pylearner.identity.studentId", "2025001");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, gitSecret: "tok-B", previousIdInRoster: false }), { status: 200 }));
    const deps: IdentityPageDeps = {
      ...makeDeps(fetchImpl),
      switchFlow: {
        beforeSwitch: async () => { order.push("beforeSwitch"); return true; },
        afterSwitch: async () => { order.push("afterSwitch"); },
        semesterReset: async () => { order.push("semesterReset"); return false; },
      },
    };
    const { secrets } = await submit(deps, store, "2026001", "李四");

    expect(order).toEqual(["semesterReset"]);
    expect(secrets.stored.size).toBe(0);
    expect(store.data.get("pylearner.identity.studentId")).toBe("2025001");   // 旧身份保留
  });

  it("previousIdInRoster=false 但 semesterReset 未接线 → 安全中止（不误入归档死锁）", async () => {
    const order: string[] = [];
    const store = makeStore();
    await store.update("pylearner.identity.studentId", "2025001");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, gitSecret: "tok-B", previousIdInRoster: false }), { status: 200 }));
    const deps: IdentityPageDeps = {
      ...makeDeps(fetchImpl),
      switchFlow: {
        beforeSwitch: async () => { order.push("beforeSwitch"); return true; },
        afterSwitch: async () => { order.push("afterSwitch"); },
      },
    };
    await submit(deps, store, "2026001", "李四");
    expect(order).toEqual([]);   // 中止，未保存
    expect(store.data.get("pylearner.identity.studentId")).toBe("2025001");
  });

  it("previousIdInRoster=true → 现有一键换机（beforeSwitch 归档链路不变）", async () => {
    const order: string[] = [];
    const store = makeStore();
    await store.update("pylearner.identity.studentId", "2025001");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, gitSecret: "tok-B", previousIdInRoster: true }), { status: 200 }));
    const deps: IdentityPageDeps = {
      ...makeDeps(fetchImpl),
      switchFlow: {
        beforeSwitch: async () => { order.push("beforeSwitch"); return true; },
        afterSwitch: async () => { order.push("afterSwitch"); },
        semesterReset: async () => { order.push("semesterReset"); return true; },
      },
    };
    await submit(deps, store, "2025002", "李四");
    expect(order).toEqual(["beforeSwitch", "afterSwitch"]);   // 正常换机不走清空
  });

  it("previousIdInRoster 缺省（旧服务端）→ 降级走 beforeSwitch（向后兼容）", async () => {
    const order: string[] = [];
    const store = makeStore();
    await store.update("pylearner.identity.studentId", "2025001");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, gitSecret: "tok-B" }), { status: 200 }));   // 无该字段
    const deps: IdentityPageDeps = {
      ...makeDeps(fetchImpl),
      switchFlow: {
        beforeSwitch: async () => { order.push("beforeSwitch"); return true; },
        afterSwitch: async () => { order.push("afterSwitch"); },
        semesterReset: async () => { order.push("semesterReset"); return true; },
      },
    };
    await submit(deps, store, "2025002", "李四");
    expect(order).toEqual(["beforeSwitch", "afterSwitch"]);
  });
});
