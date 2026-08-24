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

## 运行时验证发现的限制（2026-08-14）

本机（VS Code 1.133 + Windows PowerShell 5.1 + conpty）实测：

- **命令必须实际执行才会被记录**：排查中一度怀疑"粘贴的命令不被检测"，实测推翻——完整粘贴（含结尾引号）与手敲均正常触发事件。早期"粘贴不记录"的根因是粘贴时结尾 `"` 缺失，PowerShell 进入续行提示（`>>`）命令从未执行。未执行的命令不产生事件属正常行为，非插件缺陷
- **cmd 终端不支持 shell integration**，不产生任何终端事件（▶ 按钮不受影响，其走内部任务路径）
- **调试终端（程序化启动的命令）事件可靠**；常规终端依赖上述命令检测
- PowerShell 5.1 原生参数传递有拆分 quirk（如 `python -c "import sys; sys.exit(3)"` 实际退出码为 1 而非 3）——插件记录的是真实退出码

## 实现演进（2026-08-24）

本 spec 交付后，实现随验证迭代产生以下偏离，均以实测为准：

### 1. 去重架构反转（推翻"集合跳过"规则）

spec 的"终端事件触发时若 debug/task 集合非空则跳过"在实测中失败：**ms-python 的 ▶ 运行是终端 shell execution 先于 task 事件触发**，按集合判断时终端事件被跳过、task 事件正常写，反而漏掉了能读输出的路径。

改为：**终端 shell execution 为主记录路径，task 事件为回退路径**。task 启动时"收养"所有无主终端执行（`tag.task === null` → 归属该 task），配对不再依赖事件先后顺序。task 结束时若已有终端记录（或仍有未结束的配对终端）则跳过。

### 2. 失败运行提取错误信息（超出 spec 非目标）

spec 非目标里排除的"终端输出解析"按需收窄实现：仅对**失败的运行**读取输出尾部（≤2000 字符），提取 `error_type` / `error_message` / `file` / `line`（L2 错误模式分析的必需输入）。成功运行不读输出。

实现要点（实测踩坑）：
- `TerminalShellExecution.read()` 是**实时流**：必须在 `onDidStartTerminalShellExecution` 里开始消费，结束时再读只能拿到空
- 输出含 ANSI 转义码（PowerShell 颜色/OSC 序列），正则匹配前需清洗
- 消费循环需防御性上界（结束标记 + 定期让出事件循环 + chunk 硬上限），防止异常流饿死扩展宿主

### 3. diagnostics 迁入独立 surface `diag`

spec 将 `diagnostics_change` 归入 `edit` 表面。实测诊断事件与编辑事件混写会污染未来 L2 的"编辑模式"提取（两者焦点完全不同）。`SURFACES` 扩为 `["edit", "run", "chat", "debug", "diag"]`。

### 4. `session_id` 提升为顶层字段

chat / debug 事件的 `session_id` 从 payload 移到 TraceEvent 顶层，对齐 DeepTutor 的 TraceEvent 形状（顶层 `session_id` / `turn_id`），便于 L2 按会话聚合。

### 5. edit 噪音过滤

`code_change` 在捕获时过滤单字符插入（打字）与单字符删除（退格）——逐字符事件对 L2 提取是纯噪音。替换、多字符插入（粘贴/补全）、块删除仍记录。

### 6. 教训：proposed API 会导致静默激活失败

曾尝试用 `window.onDidWriteTerminalData` 作输出回退来源，实测该 API 在运行时仅作为 **proposed API**（`terminalDataWriteEvent`）存在：属性访问不抛、**注册监听器时抛**，且错误只在激活中途抛出——后果是视图 Provider 未注册、聊天面板无限转圈。最终彻底移除该依赖。教训：proposed API 的错误发生在**使用点**而非访问点，try/catch 属性访问挡不住；不要依赖 proposed API。
