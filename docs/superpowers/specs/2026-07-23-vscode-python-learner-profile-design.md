# VS Code 插件：Python 学习者画像系统 — 设计文档

> 借鉴 DeepTutor 的三层记忆架构（L1 原始事件 → L2 表面摘要 → L3 跨表面综合画像），
> 为学 Python 的学生打造一个本地优先的 VS Code 扩展，通过记录编程行为 + AI 聊天记录，
> 生成个性化画像，让 AI 回答更具针对性。

---

## 一、核心思路

### 一句话

**记录学生写了什么、跑了什么、调试了什么、问了什么 → 自动生成画像 → 回答问题时注入画像。**

### 与 DeepTutor 的对照

| DeepTutor | 本插件 |
|-----------|--------|
| 学习工作区 (Web 应用) | VS Code 扩展 |
| chat / notebook / quiz / kb / book ... | run / debug / edit / chat / test / diag |
| L1 trace → L2 表面摘要 → L3 综合画像 | 完全相同的三层架构，适配 VS Code 场景 |
| LLM 驱动的自动合并 | 同样 LLM 驱动（默认 Ollama 本地运行） |
| Markdown 文件存储 | 同样 Markdown + JSONL，存在 `globalStorage` |
| Memory Graph | Profile Viewer + 引用链查看 |

---

## 二、数据源与表面映射

| VS Code API | 监听内容 | 表面 | 数据类型 |
|------------|---------|------|---------|
| `tasks.onDidStartTask/onDidEndTask` + Terminal API | Python 运行命令、stdout、stderr、错误堆栈 | **run** | 代码运行行为 |
| `debug.*` (start/terminate/breakpoint/customEvent) | 断点、变量查看、单步执行、调试控制台 | **debug** | 调试行为 |
| `workspace.onDidChangeTextDocument` | 显著代码变更（防抖，过滤非 .py） | **edit** | 编码行为 |
| `languages.onDidChangeDiagnostics` | 语法错误、类型错误、lint 警告 | **diag** | 诊断/错误模式 |
| `tests.*` | 测试运行/结果/覆盖率 | **test** | 测试行为 |
| 插件内 AI Chat Webview | 学生提问、AI 回答 | **chat** | 学习对话 |

### 约束

- 代码编辑：防抖批量，记录"有意义的变化"而非每次按键
- 终端输出：只记录错误类型和摘要，不记录完整路径/敏感信息
- 调试变量：只记录变量名和类型，不记录巨大数据结构的值

---

## 三、三层记忆结构

### 存储目录

```
<extension-globalStorage>/
  .pylearner/
    trace/                     # L1: JSONL 原始事件
      run/       YYYY-MM-DD.jsonl
      debug/     YYYY-MM-DD.jsonl
      edit/      YYYY-MM-DD.jsonl
      chat/      YYYY-MM-DD.jsonl
      test/      YYYY-MM-DD.jsonl
      diag/      YYYY-MM-DD.jsonl

    L2/                        # Markdown 表面摘要
      run.md
      debug.md
      edit.md
      chat.md
      test.md
      diag.md

    L3/                        # Markdown 综合画像
      profile.md               # 学习风格、身份、水平
      scope.md                 # 概念清单 (familiar/practicing/unsure)
      recent.md                # 近期活动时间线
      preferences.md           # 学生显式声明的偏好

    meta/                      # 去重/进度追踪
      run.meta.json
      chat.meta.json
      ...
      l3.meta.json
```

### L1 事件格式

```json
{
  "id": "run:01J7T2X2X...",
  "ts": "2026-07-23T10:30:00.000Z",
  "surface": "run",
  "kind": "execution_error",
  "payload": {
    "error_type": "TypeError",
    "error_message": "unsupported operand type(s) for +: 'int' and 'str'",
    "file": "main.py",
    "line": 15
  }
}
```

### L2 格式（Markdown + 脚注引用）

```markdown
# run memory

## Common Runtime Errors
- 学生反复遇到 `TypeError`，主要是 int 和 str 混用 [^1] <!--m_xxx-->
- 运行脚本时多次遇到 ModuleNotFoundError [^2] <!--m_yyy-->

[^1]: run:01J7T2X2X...
[^2]: run:01J7T3Y3Y...
```

### L2 各表面的焦点与章节

| 表面 | 焦点 | 章节 |
|------|------|------|
| **run** | 运行时错误模式、执行习惯 | `Common Runtime Errors`, `Execution Patterns` |
| **debug** | 调试习惯、经常查看的变量类型 | `Debugging Style`, `Variables Inspected` |
| **edit** | 编码模式、重构倾向 | `Code Patterns`, `Common Edits` |
| **chat** | 常问的概念、偏好的解释方式 | `Topics Asked`, `Preferred Style` |
| **test** | 测试习惯、失败模式 | `Test Habits`, `Failures` |
| **diag** | 语法/类型错误模式 | `Syntax Errors`, `Type Errors`, `Logic Hints` |

### L3 四个槽位

| 槽位 | 内容 | 生成方式 |
|------|------|---------|
| **profile.md** | 整体学习风格、知识水平分层、编程习惯 | LLM 综合 L2 自动生成 |
| **scope.md** | 概念 checklist：familiar / practicing / unsure | LLM 综合 L2 自动生成 |
| **recent.md** | 过去 N 天的活动时间线 | LLM 综合 L2 自动生成 |
| **preferences.md** | 学生显式声明的偏好 | 仅通过 `write_memory` 工具手动添加 |

### L3 profile.md 示例

```markdown
# Student Profile

## Learning Style
- Across 15 debugging sessions, the student relies on print-debugging
  rather than breakpoint inspection [^1]
- The student prefers explanations with code examples [^2]

## Knowledge Level
- Familiar: variables, loops, conditionals
- Practicing: functions, lists/dicts, file I/O
- Struggling: recursion, OOP, decorators

[^1]: chat:xxx, debug:yyy
[^2]: chat:zzz
```

---

## 四、画像生成管道

### 流程

```
学生操作 → VS Code API 捕获 → L1 JSONL 追加写入
                                  │
                    ┌─────────────┴─────────────┐
                    │     Consolidation Pipeline │
                    │  (定时/手动触发)            │
                    │                            │
                    │  ① 快照扫描                 │
                    │    对比已处理 ID → 增量     │
                    │                            │
                    │  ② 分块 (按 token 预算)    │
                    │                            │
                    │  ③ LLM 提取事实 (Update)   │
                    │    分块 → LLM → 事实列表    │
                    │                            │
                    │  ④ 审计 (Audit)             │
                    │    校验事实与原始证据        │
                    │                            │
                    │  ⑤ 去重 (Dedup)             │
                    │    合并相似重复事实          │
                    │                            │
                    │  ⑥ 追加到 L2 .md            │
                    └─────────────┬──────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │   L3 合成                   │
                    │   读取 L2 增量              │
                    │   LLM → L3 .md              │
                    │   审计 → 去重 → 写入         │
                    └─────────────┬──────────────┘
                                  │
                          AI 聊天时注入系统提示词
```

### LLM 提取提示词（run 表面示例）

```yaml
system: |
  你是 Python 学习记忆管理员。你正在阅读学生的代码运行记录。
  提取关于学生的持久性、可操作的事实。

  输出 JSON：
  {"facts": [
    {"text": "≤240字符",
     "section": "Common Runtime Errors | Execution Patterns",
     "refs": ["run:<event_id>", ...]}
  ]}

  硬性规则：
  - 每条事实必须有 ≥1 个 ref
  - 禁止绝对化表述（always, never, mastered）
  - 优先动词短语："反复遇到 TypeError" 而非 "有类型错误问题"
  - 没有实质内容 → {"facts": []}

user: |
  现存文档：{existing_markdown}
  新事件块：{chunk_text}
  返回 JSON。
```

### LLM 综合提示词（L3 示例）

```yaml
system: |
  你是 Python 学习画像管理员。综合 L2 摘要，提取关于学生的持久性画像主张。

  输出 JSON：
  {"facts": [
    {"text": "≤240字符，必须带限定句式",
     "section": "Learning Style | Knowledge Level",
     "refs": ["chat", "run", ...]}
  ]}

  硬性规则：
  - refs 必须是表面名称（chat/run/debug/edit/test/diag）
  - 强制 "Across N <surface> interactions, the student..." 句式
  - 禁止绝对化表述
  - 空列表是正确的

user: |
  现存画像：{existing_profile}
  L2 增量：{chunk_text}
  返回 JSON。
```

### 触发时机

| 模式 | 触发方式 | 说明 |
|------|---------|------|
| **Update** | 定时（每 30 分钟/空闲时）+ 手动 | 增量提取新事实 |
| **Audit** | Update 后自动 + 手动 | 校验事实准确性 |
| **Dedup** | Update 后自动 | 合并重复 |
| **Merge** | Update 后自动（纯代码，无 LLM） | 脚注引用整理 |

### VS Code 侧架构

```
Extension 进程 (Node.js/TypeScript)
  ├── Event Listeners        ← 监听 VS Code API
  ├── L1 Writer              ← 追加写入 JSONL
  ├── Timer / Idle Trigger   ← 空闲时触发 consolidation
  ├── Consolidator Runner    ← 调用 LLM（子进程或 HTTP）
  │     └── LLM 后端:
  │           ├── Ollama (默认, 免费, 数据不出本机)
  │           ├── OpenAI API
  │           ├── Anthropic API
  │           └── VS Code LM API
  └── Webview Panel          ← AI 聊天界面
```

**降级运行设计**：LLM 是可选的。没有 LLM 时，插件仍然收集数据、存储 L1 事件。只是 L2/L3 画像需要 LLM 时才生成。

---

## 五、AI 聊天面板与画像注入

### 面板布局

```
┌──────────────────────────────────────┐
│  VS Code 侧边栏                       │
│  [New Chat] [View Profile] [⚙]     │
├──────────────────────────────────────┤
│                                      │
│  用户: Python里怎么合并两个字典？     │
│                                      │
│  AI: 我注意到你昨天调试时也遇到了     │
│  TypeError，是因为用了 + 来合并       │
│  dict 对吧？Python 3.9+ 提供了 | 算符:│
│  ```python                            │
│  d3 = d1 | d2                         │
│  ```                                  │
│  你之前问过 3 次 dict 相关问题了，     │
│  要不要我整理一份 dict 速查表？        │
│                                      │
├──────────────────────────────────────┤
│  [输入问题...               ] [发送]  │
└──────────────────────────────────────┘
```

### 画像注入流程

```
学生提问 → 读取 L3 concat (profile + scope + recent + preferences)
        → 组装系统提示词，注入画像
        → 发送给 LLM
        → 记录本轮对话到 L1 chat trace
```

### 系统提示词组装

```
你是 Python 学习助手。以下是学生的画像信息：

[profile]
- 学习风格：偏好代码示例 > 理论说明
- 水平：dict 操作处于练习阶段

[scope]
- 已掌握：变量、循环、条件判断
- 练习中：函数、字典、文件 I/O

[recent]
- 昨天调试时遇到 dict 合并 TypeError

请基于这些信息，给出有针对性的回答。优先引用该学生之前遇到的
具体问题，并提供代码示例。如果某个概念学生已掌握，可以跳过基础
解释直接讲进阶内容。
```

### LLM 提供商配置

```json
{
  "pylearner.llm.provider": "ollama",
  "pylearner.llm.model": "codellama",
  "pylearner.llm.apiKey": "",
  "pylearner.llm.baseUrl": "http://localhost:11434"
}
```

推荐默认 Ollama（`ollama pull codellama`），完全免费且数据不出本机。

---

## 六、画像可视化

### Profile Viewer（侧边栏）

```
┌─────────────────────────────────────┐
│ 📊 Python 学习画像                    │
│                                     │
│ ┌─ 掌握度雷达图 ──────────────────┐ │
│ │        variables                 │ │
│ │       ╱  ╲                      │ │
│ │   functions ╲                   │ │
│ │     │   ●   │                    │ │
│ │     ╲      ╱                     │ │
│ │       ╲  ╱                      │ │
│ │         file_io                  │ │
│ └──────────────────────────────────┘ │
│                                     │
│ ✅ 已掌握：变量、循环、条件           │
│ 🔄 练习中：函数、字典               │
│ ❓ 模糊区：装饰器、生成器            │
│                                     │
│ 💡 偏好：偏好代码示例 + 中文解释     │
│ 🕐 近期：写了 homework3.py          │
│                                     │
│ [查看画像] [编辑] [更新]             │
└─────────────────────────────────────┘
```

掌握度雷达图从 L3 `scope.md` 结构化数据解析，纯前端 SVG/Canvas 绘制。

### 引用链查看

每条 L3 主张可展开追溯：

```
"学生对 dict 操作处于练习阶段"
  ↑ 引用 chat.md (#m_xxx)
     → 原始事件 chat:01J7T... "怎么合并两个dict？"
  ↑ 引用 diag.md (#m_yyy)
     → 原始事件 diag:01J7K... "TypeError at line 15"
```

### 画像编辑

学生可以直接打开 L2/L3 的 `.md` 文件编辑，VS Code 原生编辑器即可。
- 删除不准确的事实
- 补充自己的描述
- 下次 consolidation 时不会覆盖手动编辑的内容

---

## 七、隐私与数据控制

### 默认策略

```
所有数据存在本地，不上传任何东西。
LLM 调用时发送的内容 = 学生主动配置后 + 可预览 + 可审计。
```

### 设置项

```json
{
  "pylearner.monitor.enabled": true,
  "pylearner.monitor.trackEdits": true,
  "pylearner.monitor.trackDebug": true,
  "pylearner.monitor.trackRun": true,
  "pylearner.monitor.trackChat": true,

  "pylearner.llm.provider": "ollama",
  "pylearner.llm.model": "codellama",

  "pylearner.data.autoConsolidate": true,
  "pylearner.data.consolidateInterval": 30,
  "pylearner.data.maxRetentionDays": 90,
}
```

- 可暂停/恢复监听
- 可一键清除所有数据
- 可预览即将发送给 LLM 的内容
- L2/L3 是纯 Markdown，任何编辑器都能打开查看

---

## 八、插件命令表

| 命令 | 标题 | 功能 |
|------|------|------|
| `pylearner.openChat` | Python Learner: Open Chat | 打开 AI 聊天面板 |
| `pylearner.viewProfile` | Python Learner: View Profile | 展示 L3 画像 |
| `pylearner.editProfile` | Python Learner: Edit Profile | 打开 L3 .md 编辑 |
| `pylearner.updateProfile` | Python Learner: Update Profile Now | 立即触发合并 |
| `pylearner.memoryGraph` | Python Learner: Memory Graph | 查看引用链 |
| `pylearner.resetData` | Python Learner: Reset Profile | 清除所有记忆数据 |

---

## 九、推荐实施优先级

| 阶段 | 内容 | 交付物 |
|------|------|--------|
| **P0 (核心)** | 事件监听框架 + L1 写入 + AI 聊天面板 | 能跑、能聊、能记录 |
| **P1 (画像)** | LLM 合并管道 (L1→L2→L3) + 设置页 | 自动生成画像 |
| **P2 (可视化)** | Profile Viewer + 雷达图 + 引用链 | 学生能看到画像 |
| **P3 (完善)** | 审计/去重/数据管理/记忆编辑 | 精准可控 |

```
核心循环： 监听 → 记录 → 提取 → 注入 → 回答
                ↑____________↓
```

---

## 十、与 DeepTutor 的关键差异

| 维度 | DeepTutor | 本插件 |
|------|-----------|--------|
| 平台 | Web (Python FastAPI + Next.js) | VS Code Extension (TypeScript) |
| 存储服务 | PathService + 文件系统 | ExtensionContext.globalStorageUri |
| 表面 | 教育场景（笔记/测验/书籍等） | 编程场景（运行/调试/编辑/诊断/测试） |
| LLM 调用 | Python asyncio + httpx | 子进程 (Ollama CLI) 或 fetch (API) |
| 用户 | 终身学习者 | Python 初学者 |
| 数据敏感度 | 学习内容 | 代码（可能含作业/考试）→ 隐私要求更高 |

---

## 十一、未解决的问题（开放讨论）

1. **多 workspace 支持**：学生在多个项目间切换，画像应该跨项目累积还是按项目隔离？
2. **画像导出/导入**：学生换机器时能否携带画像？
3. **教师视角**：是否需要让教师看到学生的画像（学习进度面板）？
4. **协作场景**：多个学生协作同一个项目时，画像如何归属？

## 十二、实施状态（2026-08-24 更新）

实现仓库：`D:\ruan\vscode-pylearner`（独立 git 仓库）。P0 已完成并实测验证。

### P0 完成内容

- AI 聊天侧栏（Webview + React）：流式回复、会话历史恢复/删除、LLM 后端 vscode-lm / Ollama / OpenAI 兼容（实测 DeepSeek）
- 五类事件监听 + L1 JSONL 存储：edit / run / debug / chat / diag
- 失败运行提取 `error_type` / `error_message` / `file` / `line`（终端输出尾部解析）
- 去重（终端主路径 + task 回退 + 无主终端收养）、编辑噪音过滤、激活失败可视化诊断

### 与本文档设计的偏离（实现后确认）

| 设计文档 | 实现 | 原因 |
|---------|------|------|
| 6 个表面（run/debug/edit/chat/test/diag） | 5 个（无 test） | `testObserver` 是 proposed API，稳定 API 不可用，P0 暂缓 |
| 存储路径 `<globalStorage>/.pylearner/trace/` | `<globalStorage>/trace/` | 实现时去掉了 `.pylearner` 冗余前缀（globalStorage 本身就是扩展私有目录） |
| diagnostics 归入 diag 表面（一致） | 一致 | — |
| `pylearner.llm.apiKey` 存 settings | SecretStorage | Settings Sync 会泄露明文密钥 |
| TraceEvent 的 session_id 在 payload 中 | 顶层字段 | 对齐 DeepTutor TraceEvent 形状，L2 按会话聚合更直接 |
| edit 记录"有意义的编辑"（防抖+批量） | 增加单字符过滤 | 逐字符打字/退格对 L2 是纯噪音 |

### 教训记录

- **proposed API 是陷阱**：`window.onDidWriteTerminalData` 运行时存在但为 proposed API，注册时抛异常导致激活中断（视图无限转圈），且错误只在使用点抛出。P0 已彻底移除 proposed API 依赖。
- **`TerminalShellExecution.read()` 是实时流**：必须在命令执行期间消费，结束后读取只能拿到空；消费循环需要防御性上界防止饿死扩展宿主事件循环。
- **激活路径需要可视化**：activate() 中途抛异常的表现是"视图一直转圈"，调试控制台首行日志照常打印，极具误导性。try/catch + 弹窗 + 分阶段日志是必要的。

### P1 展望（合并管道）

P1 的输入质量前置项已全部完成（事件结构对齐、噪音过滤、去重、错误提取）。P1 将实现 TS 版合并器：L1 → L2（六表面增量事实提取）→ L3（四槽位综合画像），算法骨架参照 DeepTutor 的 `consolidator/modes/update.py`（增量比对 → 分块 → LLM 提取 → 引用验证 → 原子写入）。
