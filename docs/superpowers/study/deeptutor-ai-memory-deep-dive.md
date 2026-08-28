# DeepTutor 工作原理深度解析（特别是 AI 记忆方面）

> 基于 DeepTutor 项目源码精读
> 本地代码路径：D:\ruan\DeepTutor\DeepTutor
> 生成日期：2026-08-28

---

## 目录

1. [DeepTutor 是什么](#一deeptutor-是什么)
2. [三层记忆架构](#二三层记忆架构)
3. [L1：原始事件追踪](#三l1原始事件追踪)
4. [L2：面级事实提取](#四l2面级事实提取)
5. [L3：跨面综合画像](#五l3跨面综合画像)
6. [Markdown 文档模型](#六markdown-文档模型)
7. [原子操作（Add/Edit/Delete）](#七原子操作addeditdelete)
8. [增量更新：seen-ID 差分](#八增量更新seen-id-差分)
9. [分块与边界对齐](#九分块与边界对齐)
10. [引用验证与参考池](#十引用验证与参考池)
11. [五层防御体系](#十一五层防御体系)
12. [快照-差分-合并机制](#十二快照-差分-合并机制)
13. [Consolidator 三种运行模式](#十三consolidator-三种运行模式)
14. [运行时管理](#十四运行时管理)
15. [与 GBrain 和 LLM Wiki 的对比](#十五与-gbrain-和-llm-wiki-的对比)
16. [自测问题](#十六自测问题)

---

## 一、DeepTutor 是什么

DeepTutor 是一个**AI 教学系统**，核心特色是围绕"学习者画像"构建的**个性化记忆模型**。与通用知识库（GBrain、LLM Wiki）不同，DeepTutor 的记忆是关于**某个特定学习者**的知识——他们学过什么、掌握了什么、哪里薄弱、什么学习风格。

### 核心设计哲学

> **记忆是管道，不是存储。** 每一条学习事件都经过 L1→L2→L3 的编译管道，最终形成可查询的学习者画像。原始事件不可变，中间事实可编辑，综合画像可重写。

### 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Python (asyncio) |
| 前端 | Next.js (React) |
| 存储 | JSONL (L1) + Markdown (L2/L3) + JSON sidecar (meta) |
| LLM | 多 provider (OpenAI 兼容) |
| 数据库 | PocketBase |

---

## 二、三层记忆架构

这是 DeepTutor 对 AI 记忆的核心设计——三层编译管道：

```
┌────────────────────────────────────────────────────────────┐
│  L3：跨面综合画像                                          │
│  memory/L3/recent.md      — 最近活动                       │
│  memory/L3/profile.md     — 学习者画像（核心）              │
│  memory/L3/scope.md       — 知识范围                       │
│  memory/L3/preferences.md — 学习偏好                       │
│                                                            │
│  特点：跨所有 surface 综合，面名引用（chat, notebook...）    │
│  更新语义：LLM 提取新事实 → AddOp/EditOp/DeleteOp 原子应用  │
├────────────────────────────────────────────────────────────┤
│  L2：面级事实提取                                          │
│  memory/L2/chat.md        — 聊天面事实                     │
│  memory/L2/notebook.md    — 笔记本面事实                   │
│  memory/L2/quiz.md        — 测验面事实                     │
│  memory/L2/kb.md          — 知识库面事实                   │
│  memory/L2/book.md        — 书籍面事实                     │
│  memory/L2/partner.md     — 协作者面事实                   │
│  memory/L2/cowriter.md    — 共写面事实                     │
│                                                            │
│  特点：per-surface 独立事实，footnote 引用 L1 实体          │
│  更新语义：LLM 提取新事实 → AddOp/EditOp/DeleteOp 原子应用  │
├────────────────────────────────────────────────────────────┤
│  L1：原始事件追踪                                          │
│  memory/trace/chat/2026-08-28.jsonl                        │
│  memory/trace/notebook/2026-08-28.jsonl                    │
│  memory/trace/quiz/2026-08-28.jsonl                        │
│  ...                                                       │
│                                                            │
│  特点：append-only JSONL，按 surface + UTC 日分割            │
│  永不修改，永不删除，只追加                                 │
└────────────────────────────────────────────────────────────┘
```

### Surface 类型

```python
Surface = Literal[
    "chat",      # 聊天交互
    "notebook",  # Jupyter 笔记本
    "quiz",      # 测验/练习
    "kb",        # 知识库
    "book",      # 书籍/阅读
    "partner",   # 协作者
    "cowriter",  # 共写
]
```

### L3 槽位

```python
L3Slot = Literal[
    "recent",       # 最近活动
    "profile",      # 学习者画像（核心）
    "scope",        # 知识范围
    "preferences",  # 学习偏好
]
```

### 三层之间的关系

```
L1 事件 ──[LLM 提取]──→ L2 事实（per-surface，footnote 引用 L1）
L2 事实 ──[LLM 综合]──→ L3 画像（cross-surface，面名引用 L2）

审计链：L3 entry → surface name → L2 entry → footnote → L1 trace id
```

---

## 三、L1：原始事件追踪

### 文件格式

每个 surface 每个 UTC 日一个 JSONL 文件：

```
memory/trace/chat/2026-08-28.jsonl
memory/trace/notebook/2026-08-28.jsonl
memory/trace/quiz/2026-08-28.jsonl
```

### TraceEvent 结构

```python
@dataclass
class TraceEvent:
    id: str           # "chat:01HZK4ABCDEFGHJKMNPQRSTVWX" (surface:ULID)
    ts: str           # ISO-8601 UTC 时间戳
    surface: Surface  # "chat" | "notebook" | "quiz" | ...
    kind: str         # 事件类型（自由字符串）
    payload: dict     # 事件内容（自由 JSON）
    session_id: str | None = None
    turn_id: str | None = None
```

### 关键设计

1. **Append-only**：只追加，永不修改或删除
2. **Never raises**：`append()` 用 try/except 包裹，写入失败只 warning 不抛异常——**trace 捕获不能打断产生 surface 的业务逻辑**
3. **Async lock per-surface**：同一 surface 的写入串行化，防止 JSON 行交错
4. **按日分割**：自然的时间分区，便于备份和清理

### ID 生成

```python
def new_trace_id(surface: str) -> str:
    return f"{surface}:{new_ulid()}"
    # 例: "chat:01HZK4ABCDEFGHJKMNPQRSTVWX"
```

ULID 格式：26 字符 Crockford-base32，前 10 字符编码毫秒时间戳→自然时间排序。

---

## 四、L2：面级事实提取

### 文件格式

每个 surface 一个 Markdown 文件：

```
memory/L2/chat.md
memory/L2/notebook.md
memory/L2/quiz.md
...
```

### 文档结构

```markdown
# Chat Interactions

## Learning Patterns
- Prefers step-by-step explanations [^1] [^2] <!--m_01HZK4AB-->
- Asks clarifying questions when confused [^1] <!--m_01HZK5CD-->

## Topics Explored
- Asked about Python decorators [^3] <!--m_01HZK6EF-->
- Explored async/await patterns [^2] <!--m_01HZK7GH-->

---

[^1]: chat:01HZK4AB
[^2]: chat:01HZK5CD
[^3]: chat:01HZK6EF
```

### 关键元素

| 元素 | 语法 | 作用 |
|------|------|------|
| **标题** | `# Title` | 文档标题 |
| **章节** | `## Section Name` | 事实分组 |
| **条目** | `- text [^1] [^2] <!--m_xxx-->` | 一个事实，带引用和锚点 |
| **引用标记** | `[^1]` | footnote 标记，整数编号 |
| **条目锚点** | `<!--m_xxx-->` | entry id，用于编辑/删除/审计 |
| **footnote 定义** | `[^1]: chat:abc` | 引用→L1 trace id 的映射 |

### 更新流程

```
snapshot 当前 surface 实体
  │
  ├─ diff vs meta.seen_entity_refs → 找出新增/修改的实体
  │
  ├─ render_with_markers() → 将新实体渲染为带锚点标记的大文本
  │
  ├─ chunk_with_boundary() → 按预算分块（段落/句子边界对齐）
  │
  ├─ 对每个 chunk:
  │   ├─ 算本块引用池 refs_in_chunk_l2()
  │   ├─ 拼 system prompt（含 schema + 已有文档 + 引用池）
  │   ├─ 拼 user prompt（含块内容）
  │   ├─ LLM 调用 → 提取事实（AddOp/EditOp/DeleteOp）
  │   ├─ validate_fact_refs() → 过滤非法引用
  │   └─ guards._filter_banned() → 过滤禁用措辞
  │
  ├─ apply(doc, ops) → 原子应用到 Document
  │
  ├─ serialize(doc) → 写回 .md 文件
  │
  └─ save_l2_meta() → 更新 seen_entity_refs
```

---

## 五、L3：跨面综合画像

### 文件格式

四个槽位，各一个 Markdown 文件：

```
memory/L3/recent.md       — 最近活动
memory/L3/profile.md      — 学习者画像（核心）
memory/L3/scope.md        — 知识范围
memory/L3/preferences.md  — 学习偏好
```

### 与 L2 的关键区别

| 维度 | L2 | L3 |
|------|----|----|
| 范围 | per-surface | cross-surface |
| 引用 | `chat:01HZK4AB`（trace id） | `chat`（surface 面名） |
| 目的 | 单面事实提取 | 全局综合画像 |
| 章节语义 | 该面内的事实分类 | 跨面的综合维度 |

### profile.md 示例

```markdown
# Learner Profile

## Learning Style
- Prefers visual explanations over text-only [^1] <!--m_xxx-->
- Learns best with concrete examples before abstract theory [^1] [^2] <!--m_yyy-->

## Strengths
- Strong grasp of Python fundamentals [^1] [^3] <!--m_zzz-->
- Good at debugging through systematic elimination [^2] <!--m_www-->

## Areas for Improvement
- Struggles with async programming concepts [^1] <!--m_aaa-->
- Needs more practice with decorators [^3] <!--m_bbb-->

## Progress
- Completed basic Python module [^1] [^2] <!--m_ccc-->
- Started intermediate async module [^1] <!--m_ddd-->

---

[^1]: chat
[^2]: notebook
[^3]: quiz
```

### 更新流程

```
读取所有 L2 文档
  │
  ├─ diff vs meta.seen_l2_entry_ids → 找出各面新增条目
  │
  ├─ render 每个 L2 的内容（含 entry id 标记）
  │
  ├─ chunk_with_boundary() → 分块
  │
  ├─ 对每个 chunk:
  │   ├─ 算引用池 refs_in_chunk_l3()（L2 entry ids）
  │   ├─ 拼 system prompt + user prompt
  │   ├─ LLM 调用 → 提取跨面事实
  │   ├─ validate + guards 检查
  │   └─ 收集 ops
  │
  ├─ apply(doc, ops) → 原子应用
  │
  ├─ serialize → 写回 .md
  │
  └─ save_l3_meta() → 更新 seen_l2_entry_ids
```

---

## 六、Markdown 文档模型

### 数据结构

```python
@dataclass
class Entry:
    id: str              # "m_01HZK4AB..." (entry id)
    section: str         # "Learning Patterns"
    text: str            # "Prefers step-by-step explanations"
    refs: list[str]      # ["chat:01HZK4AB", "notebook:01HZK5CD"]

@dataclass
class Document:
    title: str = ""
    sections: list[tuple[str, list[Entry]]] = field(default_factory=list)
    # sections = [("Learning Patterns", [Entry(...), Entry(...)]),
    #             ("Topics Explored", [Entry(...)])]
```

### 核心操作

```python
doc.all_entries()     # → 所有条目（跨章节）
doc.find(entry_id)   # → 按 id 查找条目
doc.section_entries(name)  # → 获取/创建章节
doc.remove(entry_id) # → 删除条目
```

### 解析（parse）

纯函数，无 I/O，无 LLM。两遍扫描：
1. **Pass 1**：收集所有 footnote 定义（新格式 + 旧格式兼容）
2. **Pass 2**：解析标题、章节、条目

**兼容性：** 同时支持新格式（`[^1]` + `<!--m_xxx-->`）和旧格式（`[^m_xxx]`），让旧文档在新代码下继续工作。

### 序列化（serialize）

纯函数，`serialize(parse(x))` 幂等。

---

## 七、原子操作（Add/Edit/Delete）

### 三种操作类型

```python
@dataclass(frozen=True)
class AddOp:
    section: str      # 目标章节
    text: str         # 事实文本（1..240 字符）
    refs: list[str]   # 引用列表（非空）
    op: Literal["add"] = "add"

@dataclass(frozen=True)
class EditOp:
    target_id: str    # 要编辑的 entry id
    new_text: str     # 新文本
    new_refs: list[str]  # 新引用
    op: Literal["edit"] = "edit"

@dataclass(frozen=True)
class DeleteOp:
    target_id: str    # 要删除的 entry id
    reason: str       # 删除原因（必须是允许集合之一）
    op: Literal["delete"] = "delete"

Op = Union[AddOp, EditOp, DeleteOp]
```

### 验证规则

| 规则 | 说明 |
|------|------|
| 文本长度 | 1..240 字符 |
| 章节长度 | 1..80 字符 |
| 引用非空 | 每个 Add/Edit 至少一个 ref |
| 引用格式 | 必须通过 `is_valid_ref()` 检查 |
| 目标存在 | Edit/Delete 的 target_id 必须在文档中找到 |
| 批次无冲突 | 同一批次内不能同时 edit 和 delete 同一个 id |
| 删除原因 | 必须是 `{contradicted, superseded, stale, low-signal}` 之一 |

### 原子应用

```python
def apply(doc: Document, ops: list[Op]) -> ApplyReport:
    # 1. 整批验证 → 任一失败则全部拒绝
    _validate(doc, ops)  # raises OpValidationError
    # 2. 逐个应用
    for op in ops:
        if isinstance(op, AddOp):   doc.section_entries(op.section).append(...)
        elif isinstance(op, EditOp): entry.text = op.new_text; entry.refs = op.new_refs
        elif isinstance(op, DeleteOp): doc.remove(op.target_id)
    # 3. 返回报告
    return ApplyReport(accepted=True, results=results)
```

**原子性：** 验证失败→文档不变；验证通过→全部应用。LLM 不能自相矛盾。

---

## 八、增量更新：seen-ID 差分

### 问题

每次更新不能重读全部 L1 事件——太慢太贵。需要知道"自上次更新以来，哪些实体是新的"。

### 解决方案：meta.json sidecar

**L2 meta：**
```json
{
  "version": 1,
  "last_update_at": "2026-08-28T10:30:00Z",
  "seen_entity_refs": ["chat:01HZK4AB", "chat:01HZK5CD", "notebook:01HZK6EF"]
}
```

**L3 meta：**
```json
{
  "version": 1,
  "last_update_at": "2026-08-28T10:30:00Z",
  "seen_l2_entry_ids": {
    "chat": ["m_01HZK4AB", "m_01HZK5CD"],
    "notebook": ["m_01HZK6EF"],
    "quiz": ["m_01HZK7GH"]
  }
}
```

### 增量差分流程

```
L2 更新:
  当前实体集合 = snapshot 当前 surface 的所有实体
  新增实体 = 当前集合 - meta.seen_entity_refs
  只对新实体执行 LLM 提取 → 生成 ops → 应用 → 更新 meta

L3 更新:
  各面新增条目 = 各面当前 entry ids - meta.seen_l2_entry_ids[该面]
  只对有新增条目的面执行 LLM 综合 → 生成 ops → 应用 → 更新 meta
```

**幂等性：** 相同的 seen 集合 + 相同的实体→相同的差分结果。重启安全。

---

## 九、分块与边界对齐

### chunker.py

将大文本按预算切分成块，**每个块的右边界扩展到下一个自然边界**——永远不在句子/段落中间截断。

### 参数

| 参数 | 说明 |
|------|------|
| `budget` | 目标块数 |
| `overlap_ratio` | 相邻块重叠比例 |
| `min_chunk_chars` | 最小块字符数 |
| `max_chunk_chars` | 最大块字符数 |
| `boundary` | "paragraph" 或 "sentence" |

### 分块算法

```
target_size = clamp(ceil(len(text) / budget), min, max)

从左到右扫描：
  1. 切点 = start + target_size
  2. 向右扩展到下一个 boundary（段落/句子）
  3. 下一块 start = 切点 - overlap
  4. 重复直到文本结束
```

### 边界检测

```python
_PARA_BOUNDARY = re.compile(r"\n\s*\n+")           # 段落：一个或多个空行
_SENT_BOUNDARY = re.compile(r"[.!?。！？](?:[\")»」』]+)?(?=\s|$)")  # 句子：终结标点+空格
```

支持 CJK 标点：。！？

---

## 十、引用验证与参考池

### 引用类型

| 类型 | 格式 | 用于 |
|------|------|------|
| entry id | `m_01HZK4AB...` | L2 条目引用 |
| trace id | `chat:01HZK4AB...` | L2→L1 引用 |
| snapshot ref | `chat:record_id` | 快照引用 |
| shortname ref | `chat`, `notebook` | L3→L2 面名引用 |

### 参考池计算

LLM 只能引用当前 chunk 中实际出现的实体——防止幻觉引用：

```python
def refs_in_chunk_l2(entities, surface, chunk_text) -> set[str]:
    """返回 chunk 中实际出现的实体引用集合"""
    allowed = set()
    for ent in entities:
        marker = _entity_marker(surface, ent.id)
        if marker in chunk_text:  # 实体的锚点标记在 chunk 文本中
            allowed.add(f"{surface}:{ent.id}")
    return allowed
```

### validate_fact_refs

LLM 返回的事实可能引用不存在的实体。验证函数过滤掉引用池之外的引用：

```python
def validate_fact_refs(facts, allowed_pool) -> list[ExtractedFact]:
    """只保留引用在 allowed_pool 内的事实"""
    valid = []
    for fact in facts:
        clean_refs = [r for r in fact.refs if r in allowed_pool]
        if clean_refs:  # 至少有一个合法引用才保留
            valid.append(ExtractedFact(text=fact.text, refs=clean_refs, section=fact.section))
    return valid
```

---

## 十一、五层防御体系

DeepTutor 对 LLM 生成内容有五层防御：

### 第 1 层：参考池限制（输入时）

LLM 的 system prompt 中声明当前 chunk 的参考池，LLM 被指示只能引用池中的实体。**限制输入，防幻觉。**

### 第 2 层：validate_fact_refs（输出时）

即使 LLM 被告知了参考池，仍可能幻觉出不存在的引用。`validate_fact_refs` 过滤掉非法引用。**过滤输出，兜底防幻觉。**

### 第 3 层：banned-phrase 过滤（输出时）

```python
BANNED_PHRASES = (
    "deeply", "truly", "mastered", "expert in", "passionate",
    "loves", "hates", "always", "never", "fully understands",
    "深刻", "彻底", "完美掌握", "完美理解", "完全理解",
    "完全掌握", "专家", "热爱", "总是", "从来不",
)
```

任何包含这些绝对化措辞的 op 被丢弃（除非在引号 `「」` 或 `"..."` 内——允许引用用户原话）。**防止 LLM 做出过度自信的断言。**

### 第 4 层：Op 验证（应用时）

`_validate(doc, ops)` 检查：文本长度、引用格式、目标存在、批次无冲突。**保证数据完整性。**

### 第 5 层：Tool 预算（运行时）

```python
@dataclass(frozen=True)
class ToolBudgets:
    read_entity: int = 30
    search: int = 20
    add_entry: int = 12
    edit_entry: int = 12
    delete_entry: int = 12
    note: int = 8
```

每种工具调用有次数上限。超出后 dispatcher 发出 hint 让 LLM 收尾。**防止无限循环。**

---

## 十二、快照-差分-合并机制

### Entity 快照

```python
@dataclass
class Entity:
    id: str           # 实体 ID
    label: str        # 人类可读标题
    ts: str           # 时间戳
    content: str      # 内容
    metadata: dict    # 元数据
    fingerprint: str  # 内容指纹（用于变更检测）
```

### 差分（diff_snapshots）

纯函数，比较两个状态（`{entity_id: fingerprint}`）产生变更列表：

```python
@dataclass
class ChangeEntry:
    ts: str
    kind: Literal["added", "modified", "removed"]
    entity_id: str
    label: str
    prev_fingerprint: str | None
    new_fingerprint: str | None
```

差分逻辑：
- `curr_keys - prev_keys` → added
- `prev_keys - curr_keys` → removed
- `prev & curr 但 fingerprint 不同` → modified

### 流程

```
1. Snapshot 当前 workspace 状态 → {entity_id: fingerprint}
2. Diff vs 上次快照 → ChangeEntry[]
3. 只对 added/modified 实体执行 LLM 提取
4. 更新 meta.seen 集合
```

---

## 十三、Consolidator 三种运行模式

| 模式 | 函数 | 目的 | LLM 角色 |
|------|------|------|---------|
| **update** | `run_update` | 增量事实提取 | 阅读新实体→提取事实→生成 Add/Edit/Delete ops |
| **audit** | `run_audit` | 一致性审查 | 阅读现有文档+原始证据→发现矛盾/遗漏→生成编辑 |
| **dedup** | `run_dedup` | 去重 | 阅读全文→识别重复条目→生成删除/合并 |

### Update 模式详解

```
run_update(layer, key):
  1. 加载 meta → 计算 seen 集合
  2. Snapshot 当前实体 → diff → 找新增
  3. render_with_markers() → 带锚点大文本
  4. chunk_with_boundary() → 分块
  5. 对每个 chunk:
     a. 算参考池
     b. 拼 system + user prompt
     c. LLM 调用（agentic loop，每步一个 action）
     d. parse_action() → 解析 LLM 输出
     e. validate + guards 检查
     f. 收集 ops
  6. apply(doc, ops) → 原子应用
  7. serialize → 写回文件
  8. save meta → 更新 seen 集合
```

### Audit 模式详解

Audit 用**行号视图**——LLM 看到编号的行，像 IDE assistant 一样操作：

```python
@dataclass(frozen=True)
class Line:
    number: int       # 1-based 行号
    kind: LineKind    # "title" | "blank" | "section" | "bullet"
    text: str         # 渲染文本
    entry_id: str | None  # 条目 ID（bullet 行）
    section: str | None   # 所属章节（bullet 行）
```

三种编辑操作：
- `ReplaceLineOp` — 替换一行
- `DeleteLinesOp` — 删除行
- `InsertAfterOp` — 在某行后插入

**降序应用**——先改后面的行号，防止前面的行号偏移。

---

## 十四、运行时管理

### Run 生命周期

```python
RunMode = Literal["update", "audit", "dedup"]
RunStatus = Literal["queued", "running", "cancelled", "done", "error"]
```

- 每层每 key 最多一个**活跃** run（并发保护）
- 第二个请求返回 `RunBusyError`
- 终态 run 保留供 UI 重连
- FIFO 淘汰，最多 200 个历史 run

### 事件流

```python
@dataclass
class RunEvent:
    seq: int           # 单调递增
    ts: str            # ISO-8601 UTC
    payload: dict      # 事件内容
```

UI 可断线重连——`since=<cursor>` 重放错过的事件。

### Undo 检查点

```python
@dataclass
class UndoCheckpoint:
    id: str
    ts: str
    layer: str
    key: str
    path: str
    existed: bool
    previous_content: str  # 被覆盖前的完整文件内容
```

原子写入前保存检查点，支持 undo。

---

## 十五、与 GBrain 和 LLM Wiki 的对比

### 记忆模型映射

```
DeepTutor           GBrain                LLM Wiki
──────────          ──────                ────────
L1 (JSONL 事件)   ≈ Timeline (追加)     ≈ Raw Sources (不可变)
                    两者都是 append-only，     两者都是不可变原始资料
                    永不修改                   

L2 (MD per-surface) ← 无精确对应          ≈ Wiki pages
                    GBrain 在单页面内           LLM Wiki 的 Wiki 页面
                    完成编译，不需要             也是 per-entity 但
                    显式中间层                  混合了摘要和综合

L3 (MD cross-      ≈ Compiled Truth      ≈ Wiki pages (实体/概念)
 surface 画像)      (重写)                  LLM Wiki 没有显式的
                    两者都是跨面综合             跨面综合层——每个
                    但 GBrain 是 per-entity     页面本身就是综合
                    DeepTutor 是 per-learner
```

### 核心差异

| 维度 | DeepTutor | GBrain | LLM Wiki |
|------|-----------|--------|---------|
| **记忆主体** | **学习者** | **实体**（人物/公司） | **知识主题** |
| **L2 必要性** | **必需**——多个 surface 需要先 per-surface 提取再跨面综合 | 不需要——per-entity 页面天然按主题组织 | 不需要——per-entity 页面天然按主题组织 |
| **引用粒度** | entry id / trace id / surface name | Timeline 条目 / source 标注 | frontmatter sources[] / wikilink |
| **防御深度** | **5 层**（参考池→验证→banned→Op验证→预算） | 3 层（quarantine→content_flag→guardrails） | 3 层（路径安全→合并保护→锁定字段） |
| **更新原子性** | **严格**——整批验证+原子应用，冲突拒绝 | Timeline APPEND + Truth REWRITE | LLM 合并+3层保护 |

### DeepTutor 的独到之处

1. **L2 作为显式中间层**：GBrain 和 LLM Wiki 都不需要这层，因为它们的实体天然按主题组织。DeepTutor **必须**有 L2，因为一个学习者有 7 个 surface（chat/notebook/quiz/kb/book/partner/cowriter），必须先 per-surface 提取事实，才能做跨面综合。

2. **五层防御**：比其他两个系统都深。这是因为学习画像的错误比知识库的错误危害更大——一个"已掌握 Python 装饰器"的错误画像会导致教学系统跳过关键内容。

3. **原子操作批次**：GBrain 用 APPEND+REWRITE，LLM Wiki 用 LLM 合并。DeepTutor 用**严格的整批验证+原子应用**——批次内任一冲突则全部拒绝。这保证了 LLM 不能自相矛盾。

4. **面向学习者 vs 面向知识**：GBrain 和 LLM Wiki 是通用知识系统，DeepTutor 是**教学系统**。它的记忆不是"关于世界的知识"，而是"关于某个学习者的知识"——学过什么、掌握了什么、哪里薄弱、什么风格。

### 对 P1 实现的启示

| DeepTutor 设计 | P1 TypeScript 移植要点 |
|---------------|---------------------|
| L1 JSONL append-only | 用 VS Code 的 globalState 或文件系统，按 surface+日分割 |
| L2 Markdown + footnote | 复用 document.py 的 parse/serialize 逻辑，纯函数易移植 |
| L3 四槽位 | profile.md 最重要（学习者画像），其他三个可渐进 |
| seen-ID 差分 | meta.json sidecar 模式直接移植 |
| 五层防御 | 参考池+验证+banned+Op验证+预算，全部移植 |
| chunk_with_boundary | 纯算法，直接移植 |
| 原子 Op 批次 | AddOp/EditOp/DeleteOp + apply，直接移植 |
| Agentic loop | LLM 每步一个 action，parse_action 容错解析 |

---

## 十六、自测问题

### Q1: DeepTutor 的三层记忆各是什么？为什么要显式分三层？

**答：**
- L1：JSONL 原始事件，append-only，不可变
- L2：Markdown per-surface 事实，footnote 引用 L1
- L3：Markdown cross-surface 画像，面名引用 L2

三层设计的原因：
1. **L1 不可变**保证审计链——任何 L2/L3 事实都能追溯到原始事件
2. **L2 作为中间层**是必需的——7 个 surface 需要先 per-surface 提取才能跨面综合
3. **L3 跨面综合**给出全局画像——学习者不只在 chat 里学习，还在 notebook/quiz/book 等多面学习

### Q2: 为什么 L2 对 DeepTutor 是必需的，而 GBrain 和 LLM Wiki 不需要？

**答：** DeepTutor 的记忆主体是**学习者**，有 7 个 surface（chat/notebook/quiz/kb/book/partner/cowriter）。每个 surface 产生不同类型的学习事件，必须先 per-surface 提取事实（L2），才能跨面综合画像（L3）。

GBrain 的记忆主体是**实体**（人物/公司），每个实体天然按主题组织在单页面中，不需要中间层。LLM Wiki 同理——每个 Wiki 页面天然是 per-entity/per-concept 的。

### Q3: seen-ID 差分是怎么工作的？为什么不用 mtime？

**答：** 每个 L2/L3 文件有一个 `.meta.json` sidecar，记录"上次更新时看到的所有上游 ID 集合"（L2 是 `seen_entity_refs`，L3 是 `seen_l2_entry_ids`）。

下次更新时：当前 ID 集合 - seen 集合 = 新增 ID。只对新增执行 LLM 提取。

**不用 mtime 的原因：**
1. 时区问题——不同机器/服务器 mtime 不一致
2. 文件 touch 不代表内容变化
3. replay 场景——重放相同事件不应触发重复更新
4. ID 差分是**纯集合运算**，确定性且不受时间影响

### Q4: 五层防御分别是什么？每层防御什么类型的攻击？

**答：**
| 层 | 防御 | 防御的攻击类型 |
|----|------|-------------|
| 1. 参考池限制 | 限制 LLM 输入中的可选引用 | 幻觉引用（LLM 捏造不存在的实体） |
| 2. validate_fact_refs | 过滤输出中的非法引用 | 幻觉引用的兜底（LLM 无视参考池） |
| 3. banned-phrase | 丢弃绝对化措辞 | 过度自信断言（"完美掌握"、"总是"） |
| 4. Op 验证 | 文本长度/引用格式/目标存在/批次无冲突 | 数据完整性破坏 |
| 5. Tool 预算 | 限制每种工具调用次数 | 无限循环/过度消耗 |

### Q5: AddOp/EditOp/DeleteOp 的批次应用为什么是原子的？

**答：** `apply(doc, ops)` 先执行 `_validate(doc, ops)` 验证整批，任一失败则返回 `ApplyReport(accepted=False)` 且**文档不变**。验证通过后才逐个应用。

批次内还检查冲突：同一 id 不能同时被 edit 和 delete。这防止 LLM 自相矛盾——比如先删一个条目又编辑它。

### Q6: chunk_with_boundary 为什么不在句子中间截断？

**答：** 分块器从目标切点向右扩展到下一个自然边界（段落或句子）。因为：
1. 截断句子会破坏语义——LLM 看到不完整的句子可能误解
2. 事实通常是一个完整句子，截断会丢掉关键信息
3. 重叠区域也按边界对齐，保证跨块的事实仍可被完整读取

### Q7: L3 的引用为什么是 surface name 而不是 entry id？

**答：** L3 是跨面综合，它的引用指向 L2 **文件**（整个 surface），而不是 L2 的单个条目。原因：
1. L3 事实是多个 L2 条目的综合，不对应单个条目
2. 用面名（`chat`、`notebook`）简洁且稳定——L2 条目可能被编辑/删除，但 surface name 不变
3. 审计时可以通过面名找到对应的 L2 文件，再通过 entry id 定位具体条目

### Q8: banned-phrase 为什么要允许引号内的绝对化措辞？

**答：** 因为 LLM 可能需要引用用户的**原话**。用户说"我总是搞不懂装饰器"，LLM 应该能记录这个偏好，而不被 banned-phrase 过滤掉。

引号语法：CJK `「…」` 或 ASCII `"…"`。引号内的内容被视为用户原话，不受 banned 规则约束。

### Q9: Audit 模式的行号视图是什么？为什么要用行号？

**答：** Audit 模式把 Document 渲染为带行号的视图，LLM 看到：
```
1: # Chat Interactions
2: 
3: ## Learning Patterns
4: - Prefers step-by-step [^1] <!--m_xxx-->
5: - Asks clarifying questions [^1] <!--m_yyy-->
```

用行号的原因：
1. **精确操作**——LLM 用行号引用要编辑/删除的行，不会搞错目标
2. **类似 IDE assistant**——与 Copilot/Code 的工作方式一致
3. **降序应用**——先改后面行号，防止前面行号偏移

### Q10: 对 vscode-pylearner P1 实现，哪些模块可以直接移植，哪些需要重新设计？

**答：**

**可直接移植（纯函数，无 I/O）：**
- `ids.py` — ULID 生成和验证
- `document.py` — Markdown parse/serialize
- `ops.py` — AddOp/EditOp/DeleteOp + validate + apply
- `chunker.py` — 分块与边界对齐
- `guards.py` — banned-phrase 过滤
- `parse.py` — 容错 JSON 解析

**需适配（有 I/O 但模式清晰）：**
- `trace.py` — append 逻辑不变，存储从文件改为 VS Code globalState
- `meta.py` — meta.json 逻辑不变，路径解析改为 VS Code 扩展存储
- `paths.py` — 路径布局不变，根目录改为扩展数据目录

**需重新设计：**
- `references.py` — 参考池计算依赖 Entity snapshot，需适配 P1 的数据模型
- `snapshot/` — Entity 采集方式取决于 P1 如何获取学习事件
- `modes/update.py` — LLM 调用方式取决于 P1 的 LLM provider 集成
- prompts/ — 中英文 prompt 需要根据 P1 场景调整

---

*本文档基于 DeepTutor 源码精读生成。关键源文件：*
- `deeptutor/services/memory/trace.py` — L1 追踪
- `deeptutor/services/memory/ids.py` — ULID 和 ID 验证
- `deeptutor/services/memory/document.py` — Markdown 文档模型
- `deeptutor/services/memory/ops.py` — 原子操作
- `deeptutor/services/memory/paths.py` — 三层路径布局
- `deeptutor/services/memory/store.py` — 高层 facade
- `deeptutor/services/memory/consolidator/chunker.py` — 分块
- `deeptutor/services/memory/consolidator/guards.py` — 防御
- `deeptutor/services/memory/consolidator/parse.py` — 容错解析
- `deeptutor/services/memory/consolidator/references.py` — 引用验证
- `deeptutor/services/memory/consolidator/meta.py` — 增量状态
- `deeptutor/services/memory/consolidator/line_doc.py` — 行号视图
- `deeptutor/services/memory/consolidator/runs.py` — 运行时管理
- `deeptutor/services/memory/consolidator/modes/update.py` — 更新模式
- `deeptutor/services/memory/consolidator/modes/audit.py` — 审计模式
- `deeptutor/services/memory/consolidator/modes/dedup.py` — 去重模式
- `deeptutor/services/memory/snapshot/entity.py` — 实体快照
- `deeptutor/services/memory/snapshot/diff.py` — 差分
