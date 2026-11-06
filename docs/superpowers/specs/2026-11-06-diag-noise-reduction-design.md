# diag 降噪二期设计：语法豁免 + 编辑静默 + 冷却期

- 日期：2026-11-06
- 状态：已评审（用户拍板：仅改扩展端 diag 上报，不动服务端评分策略）
- 关联：一期降噪见 `docs/superpowers/plans/2026-10-28-diag-persistence-window-and-event-trim.md`；实现位于 `src/events/diagnosticsListener.ts`

## 1. 背景

一期降噪引入「错误存活窗口」（PERSIST_MS=30s，指纹=起始位置+消息）后，diag 事件量已明显下降，但实际课堂运行中误报仍偏多。误报主体为两类场景：

| 场景 | 现状链路 | 为什么误报 |
|---|---|---|
| 学生还没写完 | 边打字边产生语法类诊断，中途抬头看题面/思考 → 停顿超过 30s | 错误存活满窗口 → 上报，但学生只是正常写作 |
| 学生手误 | 敲错一个字符产生诊断，随后思考/翻笔记 30s+ | 同上；手误通常很快自愈，但自愈发生在窗口内外的边界不可控 |
| 错误随打字演变 | 指纹（行号+消息）随编辑变化，指纹一变重新计时 | 同一个错在 5 分钟内以不同指纹连报多条 |

危害：服务端每条 diag 都会触发 LLM 解释调用；diag 直接推高服务端 `consecutiveErrors` / 同类重复计数，把「正在写代码」的学生点亮成黄/红状态并挤占急需帮助告警位。

## 2. 目标与非目标

**目标**

- diag 事件源头降噪，误报（还没写完/手误）大幅减少（预期事件量再降 70%+）。
- 仅改 `src/events/diagnosticsListener.ts`（及测试/mock），事件类型、payload 结构、服务端协议零改动。

**非目标（明确不做）**

- 不改服务端状态评分/告警策略（用户拍板：先不动）。
- 不恢复 edit 事件上报（编辑信号仅作本地内存时间戳，永不落盘、永不上报）。
- 不改 run 事件采集（run 失败是真实信号，保持即时上报）。

## 3. 设计：三道闸

三道闸按序过滤，任一命中即不上报（或推迟上报）。

### 3.1 闸门一：语法类诊断豁免（永不报）

**理由**：还没写完的误报几乎全是语法类诊断。这类错误学生真按 F5 运行时会被 run 失败事件天然覆盖（runListener 解析 traceback 上报），diag 里再报一遍纯属重复噪音。

**实现**：`isSyntaxLike(message: string): boolean`，按消息特征正则匹配，命中即豁免：

```
/^Expected\b/i            Pyright 系：Expected ':', Expected expression...
/^Unexpected\b/i          Unexpected indent...
/was not closed/          "(" was not closed
/unterminated/i           unterminated string literal
/invalid syntax/i
/unexpected indent/i
/indentation/i            IndentationError 族（is not indented / unindent 等）
```

匹配不到的未知消息**默认按普通错误处理**（保守方向：漏匹配只会让该条照常走后续闸门，不会恶化误报，也不会漏掉真错误）。模式列表集中在常量区并加注释，后续可按实测样本增补。

### 3.2 闸门二：编辑静默门槛（存活计时只在「未编辑」时累计）

**理由**：错误在学生持续打字期间产生 = 写作中间态，不具备上报价值；错误在学生停止编辑后仍持续存在 ≥30s，才更像「真卡住」。

**实现**：

- 监听 `vscode.workspace.onDidChangeTextDocument`（仅当 `e.contentChanges.length > 0` 且文件为 .py），该文件 key 下所有现存指纹的 `firstSeen` 重置为当前时刻。
- 语义等价于：**错误必须在最后一次编辑之后静默存活满 PERSIST_MS(30s) 才上报**。学生持续打字 → 计时不断归零 → 永不满足；停笔 30s 后错误仍在 → 上报。
- 纯内存时间戳操作，不产生任何事件、不改 L1Writer。

**与既有语义的合并**：指纹消失清除 firstSeen/reported、消失后再现重新计时等一期规则全部保留，编辑重置只是给 firstSeen 增加一个额外的归零触发源。

### 3.3 闸门三：同文件冷却期（抑制指纹演变连报）

**理由**：错误随打字演变（行号漂移、措辞微调）会以新指纹重新走 30s 窗口，同一问题连报多条。

**实现**：

- 每文件记录 `lastReportAt` 与 `lastReportedErrorCount`。
- `reconcile` 命中上报时检查：距 `lastReportAt` 不足 COOLDOWN_MS(120s) 时抑制本次上报，**例外**：当前错误数 ≥ `lastReportedErrorCount + 2`（错误显著恶化）才破例上报。
- 被抑制的指纹仍标记为已报（不重复计时），避免冷却结束后集中补报旧错误。

## 4. 降噪后语义汇总

| 状况 | 一期行为 | 二期行为 |
|---|---|---|
| 打字中的语法错误（中间态） | 停顿 30s 即报 | 语法豁免，永不报 |
| 打字中的运行时类诊断（如未定义变量） | 停顿 30s 即报 | 持续打字期间不报；停笔后仍存在 30s 才报 |
| 手误后 10s 内修正 | 窗口内消失，不报（不变） | 不报（不变） |
| 手误后停顿 40s（思考） | 报（误报） | 仍会报（静默 30s 满足）；属可接受残留，学生 40s 未动一个错已接近"需要关注" |
| 同一错误指纹演变连报 | 每个新指纹各报一条 | 冷却 120s 内合并为一条（恶化例外） |
| 真卡住（错误持续+不编辑） | 30s 后报 | 30s 后报（不变）；恶化时冷却例外保证增量可见 |

## 5. 兼容性与发布

- 服务端零改动、无需发布；评审/缓存/归档链路无感知。
- 学生端无新 UI、无新弹窗，完全无感知。
- 既有配置开关沿用 `monitor.editEnabled`（isEnabled 逻辑不变）。
- 版本：公网 1.0.10 / 内网 2.0.10，同代码异地址（`src/constants.ts` DEFAULT_TEACHER_URL），打包流程沿用惯例（`pnpm dlx --allow-build=@vscode/vsce-sign @vscode/vsce package --no-dependencies`，内网包改名 `pylearner-2.0.10.vsix` 适配 install.sh glob）。

## 6. 测试策略

- 扩展 `src/test/events/diagnosticsListener.test.ts`（vitest + fake timers + 既有 vscode-mock）：
  - 既有 4 用例语义基本不变；其中用例 1 的 `"Expected name after 'def'"` 属语法豁免类，结论（永不上报）不变但原因变化，注释与断言需相应调整。
  - 新增：语法类诊断持续存在也不报；运行时类诊断在持续编辑期间不报、停笔 30s 后报；冷却期内同文件第二次满窗口错误被抑制、错误数 +2 破例；vscode-mock 需补 `workspace.onDidChangeTextDocument` 注册点。
- 回归：`pnpm test`（vitest run）全量通过，l1Writer 等既有测试零影响。

## 7. 风险与权衡

| 风险 | 评估 |
|---|---|
| 真卡在语法错误且从不按 F5 的学生不再点亮 | 可接受：跑一次运行即被 run 失败覆盖；且该学生通常会被教师巡视发现 |
| 语法豁免模式列表漏匹配 | 保守方向失败：该条按普通错误走后续闸门，不恶化也不致漏 |
| 冷却期抑制导致增量可见性延迟 | 上限 2 分钟，且错误数显著恶化可破例 |
| 残留误报（手误+长时间停顿） | 罕见且此时状态已接近真实"需要关注"，教师成本可忽略 |
