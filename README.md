# Python Learner

AI 驱动的 Python 学习伴侣 —— VS Code 扩展。在陪伴学习者聊天的同时，自动记录学习行为轨迹（L1 trace），供后续分析学习过程。

## 功能

- **AI 聊天侧栏**：内置 Webview 聊天界面，支持流式回复、多会话管理；LLM 后端可选 vscode-lm / Ollama / OpenAI 兼容 API（DeepSeek 等）
- **学习行为监听**（L1 trace，全部使用 VS Code 稳定 API）：

| 类别 | 事件 | 触发条件 |
|---|---|---|
| edit | `code_change` | .py 文件内容变更（500ms 防抖） |
| edit | `file_save` | .py 文件保存 |
| edit | `diagnostics_change` | 诊断问题出现/变化/清零（1.5s 防抖，仅变化时写） |
| run | `execution_success` / `execution_error` | Python 任务运行（Run Task、▶ 按钮） |
| run | `execution_success` / `execution_error` | 终端 python 命令（手敲或粘贴，含 exit code） |
| debug | `session_start` / `session_end` | F5 调试会话（稳定 API 无退出码，不判断成败） |
| debug | `breakpoint_change` | 断点增删改（仅 .py，含位置与计数） |
| chat | `user_message` / `assistant_response` | 聊天消息 |

## 环境要求

- VS Code ≥ 1.96
- （终端运行监听）终端 shell 需支持 shell integration：PowerShell / Git Bash 等；**cmd 不支持**

## 开发

```bash
npm install        # 根目录依赖
cd webview-ui && npm install   # Webview 前端依赖
```

F5 启动 Extension Development Host（preLaunchTask 会自动构建 webview 与扩展）。

验证命令：

```bash
npx tsc --noEmit   # 类型检查
npm run compile    # esbuild 构建扩展
```

## 数据格式（L1 trace）

事件按天写入 JSONL（每行一个 JSON 对象）：

```
%APPDATA%\Code\User\globalStorage\deeptutor.vscode-pylearner\
├── trace\<surface>\YYYY-MM-DD.jsonl    # 事件流：edit / run / chat / debug
└── chats\sessions\<session-id>.json     # 完整聊天会话
```

事件结构：

```json
{"id":"edit:01KZW...","ts":"2026-08-14T02:15:26.846Z","surface":"run","kind":"execution_error","payload":{"source":"terminal","command":"python -c \"...\"","exit_code":1}}
```

## 配置

| 设置 | 默认 | 说明 |
|---|---|---|
| `pylearner.llm.provider` | `vscode-lm` | `vscode-lm` / `ollama` / `openai` |
| `pylearner.llm.model` | — | 模型名（如 `deepseek-chat`） |
| `pylearner.llm.apiKey` | — | API Key（OpenAI 兼容接口必需） |
| `pylearner.llm.baseUrl` | `http://localhost:11434` | Ollama / OpenAI 兼容 API 地址 |
| `pylearner.monitor.editEnabled` | `true` | 监听编辑/保存/诊断 |
| `pylearner.monitor.runEnabled` | `true` | 监听运行/调试/断点 |

命令面板：`Python Learner: Open Chat` / `New Chat` / `Toggle Monitoring` / `Settings`。

## 已知限制

- 终端监听依赖 shell integration 命令检测；**命令必须实际执行才会被记录**（如粘贴时缺结尾引号导致命令未执行，不会产生事件）
- cmd 终端不支持 shell integration，不产生终端事件（▶ 按钮不受影响，其走内部任务路径）
- F5 调试的稳定 API 不提供退出码，调试事件只记开始/结束
- 调试/任务活跃期间，其他终端的手动 python 命令会被去重规则静默跳过
- PowerShell 5.1 原生参数传递存在拆分 quirk，插件记录的是真实退出码
