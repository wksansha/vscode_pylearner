// src/test/sessionConfirm.test.ts
import { describe, it, expect } from "vitest";
import { createSessionConfirmGate, type GateDeps } from "../identity/sessionConfirm";

function makeDeps(answer: string | undefined) {
  const calls: { switch: number; confirmed: number; prompts: number } = { switch: 0, confirmed: 0, prompts: 0 };
  const deps: GateDeps = {
    vscode: {
      window: { showInformationMessage: async () => { calls.prompts++; return answer; } },
    },
  } as unknown as GateDeps;
  deps.getIdentity = () => ({ studentId: "2025001", studentName: "张三" });
  deps.onSwitchIdentity = () => { calls.switch++; };
  deps.onConfirmed = () => { calls.confirmed++; };
  return { deps, calls, gate: createSessionConfirmGate(deps) };
}

describe("会话身份确认门禁", () => {
  it("首次确认弹窗 → 是我本人 → 通过且不再弹", async () => {
    const { gate, calls } = makeDeps("是我本人");
    expect(await gate.ensureConfirmed()).toBe(true);
    expect(await gate.ensureConfirmed()).toBe(true);
    expect(calls.prompts).toBe(1);
    expect(calls.confirmed).toBe(1);
  });
  it("Esc（undefined）→ 拦截；下次仍会弹", async () => {
    const { gate, calls } = makeDeps(undefined);
    expect(await gate.ensureConfirmed()).toBe(false);
    expect(calls.prompts).toBe(1);
  });
  it("切换身份 → 拦截并打开身份页", async () => {
    const { gate, calls } = makeDeps("切换身份");
    expect(await gate.ensureConfirmed()).toBe(false);
    expect(calls.switch).toBe(1);
  });
  it("无身份 → 直接引导身份页", async () => {
    const { deps, calls } = makeDeps("是我本人");
    deps.getIdentity = () => ({ studentId: null, studentName: null });
    const gate = createSessionConfirmGate(deps);
    expect(await gate.ensureConfirmed()).toBe(false);
    expect(calls.switch).toBe(1);
    expect(calls.prompts).toBe(0);
  });
  it("reset 后重新弹窗（身份变更场景）", async () => {
    const { gate, calls } = makeDeps("是我本人");
    await gate.ensureConfirmed();
    gate.reset();
    expect(await gate.ensureConfirmed()).toBe(true);
    expect(calls.prompts).toBe(2);
  });
});
