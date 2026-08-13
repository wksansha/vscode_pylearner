# 运行监听扩展设计（2026-08-13）

## 背景

插件当前 run 监听只挂 Task API（`tasks.onDidStartTask` / `onDidEndTaskProcess`），
而学习者最常用的 F5 调试和 ▶ 按钮运行（终端执行）都不会被记录，只能手动 Run Task。
本设计将运行监听扩展到 F5、▶ 按钮、手动终端命令，并补充断点、保存、诊断三类事件。

## 目标

- 覆盖 F5 调试、▶ 按钮、手动终端 python 命令三种运行路径，全部使用稳定 API
- 新增断点变化、文件保存、诊断问题三类学习行为事件
- 同一运行时行为只记录一次（去重）
- 所有事件写入既有 L1 trace 文件结构（`trace/<surface>/YYYY-MM-DD.jsonl`）

## 非目标

- 测试运行结果事件（用户选择暂缓；稳定 API 不可用，提案 API `testObserver` 已否决）
- 逐字符终端输出解析
- 诊断内容全文（只记计数与样例消息）
- 新增测试基础设施（仓库无测试框架，验证用手动矩阵）

## 事件模型

新增 surface `debug`，`SURFACES` 常量扩为 `["edit", "run", "chat", "debug"]`，
对应新文件 `trace/debug/YYYY-MM-DD.jsonl`。

| # | 事件 | surface | kind | payload | API（均稳定） |
|---|---|---|---|---|---|
| 1 | 终端运行（▶按钮、手敲命令） | run | `execution_success` / `execution_error` | `source:"terminal"`, `command`(截断500), `exit_code` | `window.onDidStart/EndTerminalShellExecution`；过滤命令行含 `python` 或 `.py` |
| 2 | F5 调试会话 | debug | `session_start` / `session_end` | `name`, `type`, `program`(仅start) | `debug.onDidStart/TerminateDebugSession`；过滤 type 含 `python`/`debugpy`；稳定 API 无退出码，不判断成败 |
| 3 | 断点变化 | debug | `breakpoint_change` | `added`/`removed`/`changed` 计数、`locations`(前10个 `file:line`) | `debug.onDidChangeBreakpoints`；只记 .py 断点 |
| 4 | 文件保存 | edit | `file_save` | `file` 相对路径 | `workspace.onDidSaveTextDocument`；仅 .py |
| 5 | 诊断问题 | edit | `diagnostics_change` | `file`, `errors`/`warnings` 计数, `samples`(前5条) | `languages.onDidChangeDiagnostics`；每文件 1.5s 防抖，与上次状态比对仅变化时写 |
| — | 任务运行（已有） | run | 不变 | 补 `source:"task"` 字段 | 与 #1 字段对齐 |
| — | 编辑（已有） | edit | 不变 | 不变 | |
| — | 聊天（已有） | chat | 不变 | 不变 | |

## 去重规则

终端 shell 执行事件会在三种场景触发：▶按钮、Run Task、F5 调试终端启动命令。
模块内维护两个集合：

- `activeDebugSessions: Set<DebugSession>`（start 加入，terminate 移除）
- `activeTrackedTasks: Set<TaskExecution>`（python 任务 start 加入，end 移除，复用既有 `_pylearner_tracked` 标记逻辑）

终端事件触发时若任一集合非空则跳过（该次运行已由调试/任务监听器记录）。
极端时序竞争下允许少量重复——L1 数据 best-effort，可接受。

## 开关

- `pylearner.monitor.runEnabled`：控制 #1/#2/#3 及任务运行事件
- `pylearner.monitor.editEnabled`：控制 #4/#5 及既有编辑事件
- `Python Learner: Toggle Monitoring` 命令行为不变（同时切两个开关）

## 模块结构（方案 A）

- `src/events/runListener.ts`：扩展为运行族监听中心——任务、终端 shell 执行、调试会话、断点；
  去重状态模块内部共享，不导出
- `src/events/editListener.ts`：增加保存监听（`file_save`）
- `src/events/diagnosticsListener.ts`：新增，防抖聚合 + 变化检测，注册进 `extension.ts`
- `src/constants.ts`：`SURFACES` 加 `"debug"`；新 kind 字符串集中定义

## 验证计划（手动矩阵）

每种事件：触发动作 → 检查对应 jsonl 新增一行 → 核对 payload 字段。

| # | 触发动作 | 预期文件 |
|---|---|---|
| 1 | ▶ 按钮运行 .py / 终端手敲 `python x.py`（成功一次、失败一次） | `trace/run/` `execution_success` + `execution_error` |
| 2 | F5 调试一个 .py，几秒后停止 | `trace/debug/` `session_start` + `session_end` |
| 3 | 加/删/改一个断点 | `trace/debug/` `breakpoint_change` |
| 4 | Ctrl+S 保存一个 .py | `trace/edit/` `file_save` |
| 5 | 在 .py 里引入语法错误 → 等 2s → 修复 | `trace/edit/` `diagnostics_change`（计数变化） |
| 去重 | F5 调试时观察 `trace/run/` 无对应重复的终端事件 | — |

## 风险

- shell execution 事件依赖 shell integration（VS Code 1.93+ 默认开启）；若用户手动关闭则 #1 静默失效——实现时在日志中提示
- `onDidEndTerminalShellExecution` 的 `exitCode` 在 shell integration 未启用时为 `undefined`——此时不写 execution_* 事件
