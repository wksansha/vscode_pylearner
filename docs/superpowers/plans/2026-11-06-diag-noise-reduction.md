# diag 降噪二期实施计划

- 日期：2026-11-06
- 设计：`docs/superpowers/specs/2026-11-06-diag-noise-reduction-design.md`
- 改动范围：`src/events/diagnosticsListener.ts`、`src/test/events/diagnosticsListener.test.ts`、`src/test/vscode-mock.ts`
- 验证命令：`pnpm test`（vitest run，fake timers + vscode-mock）

## T1 vscode-mock 补编辑事件注册点

- `src/test/vscode-mock.ts` 增加 `workspace.onDidChangeTextDocument = vi.fn()`（返回 disposable 的 mock 形态，与既有 `languages.onDidChangeDiagnostics` mock 一致）。
- 无独立断言，以 T2~T4 用例可注册 handler 为准。

## T2 闸门一：语法类诊断豁免

- `diagnosticsListener.ts` 顶部新增常量正则数组 + `isSyntaxLike(message)`（设计 §3.1 的 8 条模式，未知消息默认不豁免）。
- `updateSnapshot` 统计 errors 时跳过 `isSyntaxLike(d.message)` 的诊断（不计数、不进 fps/samples）。
- 测试（TDD 先行）：
  - 语法类诊断（如 `"Expected ':'"`、`"unexpected indent"`）持续存在 >60s → `writer.append` 零调用。
  - 运行时类诊断（如 `"unresolved reference 'foo'"`）不受豁免影响，照常 30s 上报。
  - 既有用例 1 的 `"Expected name after 'def'"`：结论不变（不报），更新注释说明原因是语法豁免而非窗口内消失。

## T3 闸门二：编辑静默门槛

- 监听 `workspace.onDidChangeTextDocument`：`e.contentChanges.length > 0` 且 uri 为 .py 文件 → 该文件 key 下 `firstSeen` 中所有现存指纹的时值重置为 now（调度中的 checkTimer 无需清除，reconcile 时点判定自然顺延）。
- 测试：
  - 错误首见后第 20s 编辑一次文件 → 原 30s 时点不上报；编辑后再静默 30s 才上报（总时长 50s）。
  - 持续每 10s 编辑一次 ×5 次 → 全程零上报（写作中间态）。
  - 不带 contentChanges 的变更事件（如 dirty 状态翻转）不重置计时。

## T4 闸门三：同文件冷却期

- 每文件记录 `lastReportAt: number` 与 `lastReportedErrorCount: number`；COOLDOWN_MS = 120_000。
- `reconcile` 上报前判定：`now - lastReportAt < COOLDOWN_MS` 且 `snap.errors < lastReportedErrorCount + 2` → 抑制（指纹仍标记已报，不补报）。
- 测试：
  - 第一个错误 30s 上报；40s 时新指纹满窗口 → 冷却内被抑制（仍 1 次调用）。
  - 冷却内错误数 1 → 3 → 破例上报（第 2 次调用）。
  - 冷却 120s 过后新指纹满窗口 → 正常上报。

## T5 回归与核对

- `pnpm test` 全量通过；确认 `l1Writer`、`runListener` 相关既有测试零影响（本设计未触碰其输入输出）。
- 核对 `writer.append` 的 payload 字段（file/errors/warnings/samples）与一期完全一致。

## T6 出包发布

- 公网版：`package.json` version → 1.0.10（`src/constants.ts` 保持公网地址），`pnpm dlx --allow-build=@vscode/vsce-sign @vscode/vsce package --no-dependencies` 出 vsix；走 VS Code Marketplace `vsce publish`（分发惯例 2026-10-29 已拍板）。
- 内网版：临时改 `src/constants.ts` DEFAULT_TEACHER_URL 为内网地址 + version → 2.0.10 打包，落盘 `d:\ruan\classroom-assistant\pylearner-2.0.10.vsix`（pylearner- 前缀匹配 install.sh glob），打完即还原不提交。
- spec/plan 两份文档随实现一并 commit 到扩展仓库。

## 明确不做

- 服务端任何改动（评分、告警、协议）。
- edit 事件上报恢复（编辑信号仅本地内存时间戳）。
- run 事件加持久窗口（run 失败是真实信号，维持即时上报；如后续仍嫌吵另立设计）。
