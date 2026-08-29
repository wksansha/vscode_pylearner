# DeepTutor 合并管道源码精读指南

> 目标读者：要为 vscode-pylearner 实现 P1 合并管道的开发者（Java 背景，Python 一般）。
> 覆盖 9 个文件，按推荐阅读顺序排列。每个文件讲四件事：**职责 → 为什么需要它 → 逐段代码讲解 → 自测题**。

---

## 0. 全局图景：先看森林再看树

整个记忆系统是一条三层流水线，`update.py` 是总指挥，其余文件都是它的零件：

```
L1 原始事件                L2 表面事实                  L3 综合画像
────────────              ──────────────              ──────────────
trace/chat/*.jsonl  ──┐
trace/edit/*.jsonl  ──┤    L2/chat.md                  L3/profile.md
trace/run/*.jsonl   ──┼──▶ L2/edit.md       ──────────▶ L3/recent.md
trace/debug/*.jsonl ──┤    L2/run.md     （综合提炼）     ...
                      ┘    + *.meta.json                 + *.meta.json
                     （逐表面提取）              （跨表面合成）
```

- **L1 → L2** 叫 **L2 update**：把某一天的原始事件提炼成"事实条目"，每条必须引用来源事件。
- **L2 → L3** 叫 **L3 update**：把所有表面的 L2 条目再综合一层，形成用户画像。
- 两层的**管道结构完全一样**：增量 diff → 渲染拼接 → 分块 → LLM 提取 → 引用校验 → 追加落盘。

| 文件 | 在管道里的角色 |
|---|---|
| [ids.py](../../../DeepTutor/deeptutor/services/memory/ids.py) | ID 的格式与校验（地基） |
| [trace.py](../../../DeepTutor/deeptutor/services/memory/trace.py) | L1 的读写 |
| [document.py](../../../DeepTutor/deeptutor/services/memory/document.py) | L2/L3 Markdown 文档的解析与序列化 |
| [ops.py](../../../DeepTutor/deeptutor/services/memory/ops.py) | 对文档的三种原子操作 |
| [chunker.py](../../../DeepTutor/deeptutor/services/memory/consolidator/chunker.py) | 把长文本切块 |
| [guards.py](../../../DeepTutor/deeptutor/services/memory/consolidator/guards.py) | 禁语护栏 |
| [parse.py](../../../DeepTutor/deeptutor/services/memory/consolidator/parse.py) | 容错解析 LLM 输出 |
| [references.py](../../../DeepTutor/deeptutor/services/memory/consolidator/references.py) | 引用池计算 + 事实校验（防幻觉核心） |
| [meta.py](../../../DeepTutor/deeptutor/services/memory/consolidator/meta.py) | seen-ID 增量状态持久化 |
| [update.py](../../../DeepTutor/deeptutor/services/memory/consolidator/modes/update.py) | 主管道，把上面全部串起来 |

> 路径提示：上表链接相对本仓库 docs 目录，实际源码在
> `D:\ruan\DeepTutor\DeepTutor\deeptutor\services\memory\` 下。

---

## 1. Python 语法速查（Java 视角，读码前先过一遍)

这些文件的代码不长，但用了不少 Java 没有的语法。遇到看不懂的先回来查这张表：

| Python 写法 | Java 对应 / 含义 |
|---|---|
| `@dataclass` | ≈ record / Lombok `@Data`，自动生成构造器、`equals` 等 |
| `@dataclass(frozen=True)` | 不可变版本（字段不能改，≈ record） |
| `field(default_factory=set)` | 字段默认值是"调用 set() 的新结果"，避免可变默认值共享 bug |
| `str \| None` | `Optional<String>`（类型注解，运行时不强制） |
| `Literal["add"]` | 只允许这几个字面量值，≈ 枚举 |
| `Union[A, B]` / `A \| B` | 类型可以是 A 或 B |
| `frozenset({...})` | 不可变 Set |
| `yield`（函数里有它就是生成器） | 惰性序列，≈ Stream 的惰性求值；调用方用 for 消费，**函数体在每次取值时才执行到下一个 yield** |
| `async def` / `await` | 异步函数 / 等待，≈ CompletableFuture 语法糖化 |
| `asyncio.Lock()` | 协程锁，≈ synchronized 但粒度是" await 点之间" |
| `(normalized := f(x))` | 海象运算符：赋值同时返回值，≈ `String n = f(x); if (n != null)` 合成一句 |
| f-string `f"{x!r}"` | 字符串插值；`!r` = 用 repr()（带引号显示，方便看出空串/空格） |
| `{k: v for x in xs}` | map/filter 合体的推导式 |
| `re.MULTILINE` | 正则的 `^` `$` 匹配每行的行首行尾（默认只匹配整串首尾） |
| `os.replace(a, b)` | 原子重命名（Windows/Linux 都原子），实现"写临时文件再替换"的关键 |
| `__all__ = [...]` | 声明模块的公开 API，`from m import *` 时只导出这些 |

---

## 2. ids.py —— ID 的形状（80 行）

### 职责
定义全系统唯一的标识符格式：**ULID**（26 个字符，Crockford Base32 编码），并提供格式校验的正则。

### 为什么不用 UUID？
ULID 的**前 10 个字符就是毫秒级时间戳**。这意味着：
- 按 id 字符串排序 = 按时间排序（后面 L3 update 就利用这一点：`sorted(..., key=lambda e: e.id)` 直接得到时间序）
- 不需要额外的时间字段就能恢复顺序

UUIDv4 是纯随机的，排不了序。

### 代码要点

```
格式约定（记住这三个形状，后面到处出现）：

TraceEvent.id  =  "chat:01HZK4ABCDEFGHJKMNPQRSTVWX"   ← <surface>:<ULID>
Entry.id       =  "m_01HZK4ABCDEFGHJKMNPQRSTVWX"      ← m_<ULID>
L3 的 ref      =  "chat"                              ← 光秃秃的表面名
```

三个正则各自把关一种形状：

- `_ENTRY_RE`：`^m_[26个base32字符]$`
- `_TRACE_RE`：`^<小写表面名>:<26字符>$`——你的插件里就是 `run:01M0S7EKJ...` 这种
- `_SHORTNAME_REFS`：**白名单集合** `{"chat", "notebook", ...}`，不是正则。注释特意说明为什么用白名单：松正则会把 `not-an-id` 这种垃圾也放行

`is_valid_ref(s)` 是总闸门：四种形态任一命中即合法。ops 校验和引用校验都调它。

### 自测
1. 为什么 ULID 能"天然按时间排序"？前几个字符决定了什么？
2. L3 的引用为什么不需要 id 部分？（提示：见 §9，L3 指向的是 L2 **文件**而非条目）

---

## 3. trace.py —— L1 事件层（152 行）

### 职责
L1 原始事件的追加写入与读取。每个 surface 每天一个 JSONL 文件：`trace/<surface>/YYYY-MM-DD.jsonl`。

**这就是你插件里 `l1Writer.ts` 的 Python 原型**——你已经在 TS 里实现过同样的东西了，对照读会非常快。

### TraceEvent 结构

```python
@dataclass
class TraceEvent:
    id: str                    # "run:01M0S7EKJ182B6Q9FMB4FRPAPM"
    ts: str                    # ISO 时间戳
    surface: Surface           # "run"
    kind: str                  # "execution_error"
    payload: dict[str, Any]    # 自由结构：{command, exit_code, error_type...}
    session_id: str | None = None
    turn_id: str | None = None
```

和你 types.ts 里的 `TraceEvent` 几乎一模一样（session_id 顶层对齐就是你上次做的修改）。

### 两个值得学的设计

**① append 永不抛异常**（trace.py:66-79）：

```python
async def append(event):
    try:
        ...写文件...
    except Exception:
        logger.warning(...)   # 吞掉，只记日志
```

原则写在文件头注释里：**"Trace capture must never break the producing surface"**——记录行为的功能绝不能反过来弄崩聊天功能。你的 l1Writer 也该这样（检查一下你的锁链失败时会不会影响聊天消息发送）。

**② per-surface 锁字典**（trace.py:24-32）：

```python
_locks: dict[str, asyncio.Lock] = {}

def _lock_for(surface):
    lock = _locks.get(surface)
    if lock is None:
        lock = asyncio.Lock()
        _locks[surface] = lock
    return lock
```

每个 surface 一把锁，不同表面的写入互不阻塞。你 TS 版用的是 Map<string, Promise> 锁链——同一思路，只是实现手法不同（Promise 链 vs 锁对象）。

### 读取侧

- `iter_since(surface, since)`：**生成器**，按日期文件名排序逐文件、逐行 yield 事件。注意三层容错：跳过空行、跳过 JSON 解析失败的坏行、跳过 OSError——JSONL 里一行坏了不能毁掉整个读取。
- `iter_by_ids(ids)`：给定一批 trace id 反查原始事件（audit 模式用：把 L2 条目引用的证据原文挖出来）。先按 surface 分组再分别扫，避免扫无关表面。
- `latest_ts(surface)`：取最后一个非空行解析 ts。

### 自测
1. `iter_since` 里 `path.stem < cutoff_date_iso` 这个字符串比较为什么能当日期比较用？
2. 如果一行 JSONL 尾部被截断（进程写到一半崩溃），`iter_since` 会怎样？

---

## 4. document.py —— Markdown 文档的解析与序列化（235 行）

### 职责
定义 L2/L3 文件的实际格式，提供 `parse(md) -> Document` 和 `serialize(doc) -> md` 这一对互逆函数。**这是"可审计 Markdown 画像"的物理载体。**

### 文档长什么样（务必先背下这个形状）

```markdown
# chat memory

## errors
- 用户多次遇到 ZeroDivisionError，似乎对除零异常不熟悉 [^1][^2] <!--m_01ABC-->
- 曾把 input() 的返回值直接当整数使用 [^3] <!--m_01DEF-->

## topics
- 最近在问列表推导式相关的问题 [^1] <!--m_01GHI-->

---

[^1]: chat:01HZK4AAAA...
[^2]: chat:01HZK4BBBB...
[^3]: run:01HZK4CCCC...
```

三个关键部件：

| 部件 | 形式 | 作用 |
|---|---|---|
| 条目锚点 | 行尾 `<!--m_xxx-->` | Entry 的持久化 id。HTML 注释在渲染时不可见，但机器可读——删除/编辑条目就靠它定位 |
| 引用标记 | `[^1][^2]` | 指向文末脚注的编号。**整数标签是 serialize 时按首次出现顺序分配的** |
| 脚注定义 | `[^1]: chat:01HZ...` | 编号 → 真实 trace id 的映射表 |

为什么脚注用整数而不是直接写 `[^m_xxx]`？——多条目引同一来源时共享一个编号，脚注区不会重复堆一堆相同的行；人看到的上标也短。

### 数据结构

```python
@dataclass
class Entry:
    id: str            # "m_xxx"
    section: str       # 所属章节名
    text: str          # 事实正文
    refs: list[str]    # ["chat:01HZ...", ...] 真实引用

@dataclass
class Document:
    title: str
    sections: list[tuple[str, list[Entry]]]   # 有序：(章节名, 该章的条目列表)
```

Document 只有 4 个方法：`all_entries()`（拍平）、`find(id)`、`section_entries(name)`（不存在则创建章节）、`remove(id)`。全是 O(n) 线性扫——文档规模小，够用，不必过度设计。

### parse：两遍扫描

**Pass 1**（document.py:109-129）：先把全文所有脚注定义行收进两张表：
- `refs_by_entry`：旧格式 `[^m_xxx]: ref1, ref2`（一个条目的多个 ref）
- `ref_by_label`：新格式 `[^1]: notebook:abc`（一个编号对应一个 ref）

**Pass 2**（131-181）：逐行识别 `# 标题`、`## 章节`、bullet 行。bullet 匹配优先试新格式（行尾 HTML 注释锚点），从 `ref_by_label` 还原 refs；匹配不上再试旧格式（行尾 `[^m_xxx]`），从 pass 1 的表还原。

**为什么要兼容旧格式？** 格式演进时不抛弃已有文件——旧文档下次保存时会被 serialize 自动迁移成新格式（"惰性迁移"）。

### serialize：整数标签的分配算法（185-232）

```
第 1 步：遍历所有条目的所有 refs，按"首次出现顺序"给每个不同的 ref 发一个编号
         → ref_to_label = {"chat:01HZ...": 1, "run:01HZ...": 2, ...}
第 2 步：输出标题、章节、bullet（行尾补回 <!--id--> 锚点）
第 3 步：文末 "---" 之后按编号输出脚注表
```

关键不变式（docstring 明说）：`serialize(parse(x))` 对任何由 serialize 生成的文档是**幂等**的——解析再序列化，内容不变。这保证"读出来又写回去"不会悄悄破坏文件。

### 自测
1. 一条 bullet 的 refs 是怎么从 `[^1][^3]` 还原成 `["chat:...", "run:..."]` 的？中间经过哪张表？
2. 如果用户手改了 md 文件、删掉了一个 `<!--m_xxx-->` 锚点，parse 后那条会怎样？（答：不再被识别为条目，等于消失——所以文档格式对手工编辑有一定脆弱性）
3. 为什么 serialize 要保证幂等？

---

## 5. ops.py —— 三种原子操作（149 行）

### 职责
定义对 Document 的三种变更操作，并实现"**整批验证通过才应用**"的事务语义。

### 三种操作

```python
AddOp(section, text, refs)              # 新增一条事实
EditOp(target_id, new_text, new_refs)   # 改某条（按 m_xxx 定位）
DeleteOp(target_id, reason)             # 删某条，reason 必须四选一
                                        # {"contradicted","superseded","stale","low-signal"}
```

DeleteOp 强制填 reason 是个小而妙的设计：删东西必须有据可查，LLM 不能随手删。

### 核心机制：批量事务（这是本文件的灵魂）

`apply(doc, ops)` 的流程：

```
_validate(doc, ops)   ← 先整体预检，任何一个 op 不合法 → OpValidationError
                        → 返回 ApplyReport(accepted=False, reason=...)
                        → doc 一个字节都没动
全部通过              ← 再逐个应用，生成 OpResult 列表（add 会带回分配的新 entry_id）
```

**为什么这么较真？** 看 docstring 那句话："Conflicting ops reject the entire batch — the LLM doesn't get to self-contradict."（LLM 无权自相矛盾）

具体冲突检测在 `_validate` 里：同一批次内，同一个 target_id 既出现在 EditOp 又出现在 DeleteOp → 整批拒绝（ops.py:99-102 和 111-114 各查一次方向）。如果不拒绝，应用顺序就会决定结果——"先改后删"和"先删后改"结局完全不同，这种不确定性不能留。

其他校验：text 长度 1~240（防止 LLM 写论文）、refs 非空且过 `is_valid_ref`、edit/delete 的 target 必须真实存在。

### 为什么用"操作"而不让 LLM 重写全文？
1. **增量**：一次 update 通常只加几条，全文重写既浪费 token 又有丢内容风险
2. **可校验**：操作的字段小而规整，容易逐项验；自由改写全文没法验
3. **防幻觉扩散**：LLM 重写全文可能顺手"润色"掉它没注意到的旧条目；op 只动它声明要动的

### 自测
1. 为什么 `_validate` 要在循环里同时维护 `edits` 和 `deletes` 两个集合并互相检查两次？
2. `apply` 成功时直接原地修改 doc——如果应用到一半抛异常会怎样？这个设计安全吗？（提示：看 `_validate` 已经排除了哪些情况，应用阶段还剩什么能抛）

---

## 6. chunker.py —— 分块（131 行）

### 职责
把一大段拼接好的输入文本切成 ≤ budget 块，切缝对齐自然边界（段落/句子），相邻块有重叠。纯函数，无 IO 无 LLM。

### 为什么需要分块？
LLM 上下文窗口有限是一方面；更重要的是**提取质量**：一次塞十万字符，模型会偷懒漏提或胡编。小口喂，每次专心提一小段，质量稳定得多。

### 算法逐步拆解 `chunk_with_boundary(text, budget, ...)`

```
target = ceil(len(text) / budget)          # 理想块大小：总长均分 budget 份
target = clamp(target, min_chunk, max_chunk)  # 但夹在 [min,max] 区间内
overlap = round(target * overlap_ratio)    # 重叠字符数

若 len(text) <= target → 整个文本就是一块，直接返回（短路）

否则游标循环：
  cursor 从 0 开始
  1. ideal_end = cursor + target
  2. 若没到结尾 → _expand_to_boundary 把 end 向后推到下一个段落/句子边界，
     但最多推到 cursor + max_chunk_chars（hard cap）
  3. 记录一块 [cursor, end)
  4. cursor = end - overlap      # 回退 overlap 个字符 → 相邻块重叠
  5. 防死循环：cursor 至少前进 1
```

三个防御细节（都来自实战踩坑）：

1. **hard cap**（chunker.py:77-78 注释）：如果输入是一整行没有换行号的病态文本，向右找边界会一路找到天荒地老——所以限制最多推到 max_chunk_chars，宁可切在非边界处。
2. **保证前进**（90-92、105-107）：边界扩展或大重叠可能导致下一块起点 ≤ 当前起点，强制至少 +1，防止死循环。
3. **重叠的意义**：一条事实恰好横跨切缝时，两块都能看到它完整的上下文，至少有一块能把它完整提出。

### ChunkSpan

```python
ChunkSpan(index=第几块, start=起始偏移, end=结束偏移, text=切片文本)
```

保留 start/end 很重要——后面 references.py 靠"marker 的位置是否落在 [start,end)"来算每块的可用引用池（§9）。

### 自测
1. budget=3、len=900、min=100、max=500 时 target 是多少？
2. 没有 overlap 会发生什么？没有 hard cap 又会发生什么？

---

## 7. guards.py —— 禁语护栏（104 行）

### 职责
两层防线：① LLM 提取的事实里不许出现绝对化措辞；② agentic loop 里各种动作的次数预算。（②是 loop 模式用的，P1 只需关注 ①。）

### 为什么禁绝对化措辞？

画像要经得起用户审视。"他深刻掌握了递归"、"她总是忘记初始化"这种话：
- 无法举证（什么叫"深刻"？哪一次"总是"？）
- 用户一看就觉得被冒犯/被误判
- 违背"每句话都能指回证据"的可审计原则

禁词表双语并列（`"mastered"` / `"完美掌握"`…），运行时发现违禁就丢 op 并 warning 日志（方便日后根据真实误报调词表）。

### 引号豁免（guards.py:65-79）

```python
_QUOTED_RE = re.compile(r"「[^」]*」|\"[^\"]*\"")

def _has_banned(text):
    stripped = _QUOTED_RE.sub("", text).lower()   # 先删掉引号内容再查
    ...
```

用户原话引用（「…」或 "…"）里可以包含绝对化措辞——那是用户的原话，不是 AI 的断言。查禁词前先把引号区域剥掉。

### 双保险设计

docstring 讲了演进史：旧版是 LLM 全部返回后再过滤，违禁 = **静默丢弃**，模型不知道自己错了还会再犯。新版改成 emit 时当场拒绝并把"拒绝原因"作为观察反馈给模型，模型下一轮能自我纠正；`_filter_banned` 保留作兜底。

**给你的启示**：对 LLM 的约束，"拒绝+反馈让它改" 远好于 "静默丢弃"。

### 自测
1. `"用户说自己「总是搞混 == 和 is」"` 会被过滤吗？为什么？
2. 为什么禁词过滤要记 warning 日志而不只是丢弃？

---

## 8. parse.py —— 容错解析（135 行）

### 职责
把 LLM 返回的"可能带杂质的文本"解析成结构化对象。核心信条：**解析失败返回 None/[]，绝不抛异常**——把"怎么办"的决定权交给上层（重试还是放弃）。

### LLM 输出有多不可靠？

理想输出：
```json
{"thought": "...", "action": "read_entity", "args": {...}}
```

现实输出可能是：
````
好的，我来分析一下这个对话……

```json
{"action": "add_entry", "args": {...}}
```

接下来我应该……
````

### `_extract_json_object`（126-135）三步去杂质

```python
text = re.sub(r"^```[a-zA-Z]*\s*", "", text)   # 1. 剥开头 code fence
text = re.sub(r"\s*```$", "", text)            #    剥结尾 code fence
start = text.find("{")                          # 2. 第一个 {
end   = text.rfind("}")                         # 3. 最后一个 }
return text[start:end+1]
```

粗暴但有效：不管模型前后说了多少废话，只要中间有个像样的 JSON 对象就能抠出来。

### 两个入口

- `parse_action(raw)`：agentic loop 用，解析单动作信封 `{thought, action, args}`，任何一步不对就 return None。
- `_parse_ops_response(raw)`：legacy 的 `{"ops": [...]}` 形状，逐个 op 解析，单个坏的跳过不影响其它。

`_parse_one_op` 里每个字段都套 `str(...)` 强转 + strip——不信任任何输入类型。最外层 try/except Exception 兜底（118 行注释明说是故意的：parse 层就要宽松）。

### 注意：update.py 里还有一份简化版

update.py 的 `_parse_facts`（§11）是专门解析 `{"facts":[...]}` 的独立实现，逻辑同源（剥围栏→find/rfind→json.loads→逐项强转）但更简。**你写 TS 版时只需要做一份通用容错解析器**即可。

### 自测
1. 为什么 `find("{")` 配 `rfind("}")` 而不是从头匹配第一个 `}`？
2. 解析失败 return None 之后，调用方一般该怎么处理？

---

## 9. references.py —— 引用池与事实校验（388 行，★★★ 防幻觉核心）

### 职责
回答一个问题：**"这一块文本里，LLM 允许引用哪些 ref？"** 以及 **"LLM 给出的引用，怎么判定真伪、怎么处置假的？"**

### 9.1 渲染：给文本埋机器锚点

`render_traces_for_concat(entities, surface)` 把一批实体拼成一个大字符串，每个实体前面加头：

```
=== @entity chat:01HZK4AAAA ===     ← marker 行（既是人类分隔符，也是机器锚点）
ref: chat:01HZK4AAAA
label: 某次对话
ts: 2026-08-24T06:31:14Z
meta: ...

（实体正文……）
```

marker 的设计意图（175-180 注释）：**每个实体的 marker 行唯一**，后续靠"在 chunk 文本里 find 这个 marker"判断实体是否在本块中。一份渲染，两种用途。

### 9.2 引用池计算：区间相交

`refs_in_span_l2(entities, full_text, start, end)`（64-79）：

```
1. 对每个实体，在 full_text 里 find 它的 marker → 得到 (位置, ref) 列表
2. 每个实体的"势力范围" = 从它的 marker 到下一个 marker（最后一个则到文本末尾）
3. 势力范围与 [start, end) 相交 → 该 ref 进入本块 allowed 池
```

`_refs_overlapping_span`（359-368）就是那个经典的区间相交判断：`block_start < end and block_end > start`。

为什么用 span 版本而不用简化的 `refs_in_chunk_l2`（直接在 chunk 文本里搜 marker）？——因为 chunk 有 overlap 且边界可能切在 marker 中间附近，span 法以 full_text 为坐标系更稳，还能覆盖"被切开的长实体"。

### 9.3 校验：validate_fact_refs（125-163）

签名先看清楚——两个开关组成四种策略：

```python
def validate_fact_refs(fact, *, allowed, enforce_required, drop_invalid)
    → (kept_refs, reject_reason)
```

| enforce_required | drop_invalid | 行为 |
|:---:|:---:|---|
| True | True | 必须有引用；池外的剔除；剔完为空 → 整条拒绝 |
| True | False | 必须有引用；出现任一池外引用 → 整条拒绝（严格模式） |
| False | True | 引用可有可无；池外的静默剔除 |
| False | False | 最松：畸形 ref 才拒 |

**这就是"防幻觉闸门"**：LLM 说"用户怕递归，来源是 chat:01FAKE..."——01FAKE 不在本块 allowed 池里（要么是编的，要么是别的块的），这条 fact 就被拒或被剥掉引用。模型想引用不存在/不在场的事件，过不去。

### 9.4 引用的宽容归一化（313-345）——很人性化的一段

LLM 经常抄引用抄变形：

```
要求写：chat:01HZK4AAAA
实际写：某个标题:chat:01HZK4AAAA     ← 带了 label 前缀
实际写：[^chat:01HZK4AAAA]           ← 包了 markdown 包装符
```

`_normalize_allowed_ref` 的处理：
1. `_strip_ref_wrappers`：剥掉 `` ` [] () {} <> ^ `` 这些包装字符
2. 直接命中 allowed → 通过
3. 不命中 → 检查 candidate 是否**以某个 allowed ref 结尾**，且接缝处是 `: ？ # / 空格 ^` 这类分隔符（335-345）。接缝是字母数字就不认（那可能是另一个更长的 id 恰好同尾）

精神：**格式错误可修复，内容伪造不可原谅**。

### 9.5 L3 的特殊之处

L3 的 ref 不是 `surface:id` 而是**光秃秃的表面名**（`chat`）。对应实现：

- 渲染函数换成 `render_l2_entries_for_concat`（203-226）：每个表面一个 `### surface: chat` 头，条目只有 `- [section] 正文`——**故意不放 entry id、不放 refs 行**（docstring 解释：用户明确要求 LLM 不应看见或复制 L2 的溯源标注）
- 池计算 `refs_in_span_l3`（98-122）：找出落在 chunk 区间内的 `### surface:` 头对应的表面名
- 结果：L3 条目的引用链是 L3 → L2 **文件** →（打开文件再）→ L1，两跳但每一跳都可人工核查

### 9.6 audit 部分（232-296）

`annotate_l*_line_with_evidence`：把一条 L2/L3 条目连同它引用的原始证据**全文**拼在一起给审计 LLM 看。注释强调"No truncation, ever"——审计就是要完整比对。这部分 P1 用不到，知道存在即可。

### 自测
1. 一条 fact 的 ref 指向一个真实存在但不属于当前 chunk 的事件，会被放行吗？哪种策略组合下它被拒绝、哪种下被剥掉引用？
2. `_has_ref_suffix` 为什么对接缝字符挑得那么细？放行 `"my_chat:01HZ..."` 以 `"chat:01HZ..."` 结尾会有什么问题？
3. L3 为什么不给 LLM 看 L2 的 footnote？给了会怎样？

---

## 10. meta.py —— seen-ID 增量状态（194 行）

### 职责
为每份 L2/L3 文档维护一个 sidecar JSON，记录**上次 update 时已经"见过"的上游 id 集合**。下次 update 靠集合差算出"什么是新的"。

### 文件形状

```json
// memory/L2/chat.meta.json
{
  "version": 1,
  "last_update_at": "2026-08-24T12:00:00+00:00",
  "seen_entity_refs": ["chat:01HZK4AAAA", "chat:01HZK4BBBB"]
}

// memory/L3/profile.meta.json
{
  "version": 1,
  "last_update_at": "...",
  "seen_l2_entry_ids": { "chat": ["m_xxx"], "run": ["m_yyy"] }
}
```

### 为什么用 id 集合 diff，不用时间戳过滤？

docstring 一句话点破："a purely id-based diff is robust against mtime / time-zone / replays"。

对比一下：如果用"上次更新时间之后的事件才算新"——
- 事件时钟漂移/时区混乱 → 漏算或重算
- 事件被重放导入 → 时间戳相同，分不清处没处理过

id 集合就没有这些问题：处理过了就是处理过了，跟时间无关。**"以内容身份为准，不以时间为准"是增量系统的常见正解。**

### 原子写（164-178）

```python
fd, tmp = tempfile.mkstemp(dir=path.parent)   # 同目录建临时文件
write(tmp); flush; fsync                       # 落盘到底
os.replace(tmp, path)                          # 原子替换
finally: 清理残留 tmp                           # 中途崩了也不留垃圾
```

为什么必须这样？直接 `open(path,"w")` 写一半崩溃 → 文件截断损坏 → 下次 load 失败。temp+replace 保证磁盘上的文件**要么是旧的完整版，要么是新的完整版**。fsync 保证断电也不丢。

**这条你要原样搬进 TS 版**（Node 里是 `fs.writeFileSync(tmp)` + `fs.renameSync(tmp, target)`，同目录保证同分区才能原子 rename）。

### 容错加载

`_read_json`：文件不存在 → None（当作"首次运行"，seen 为空集 → 全部视为新）；JSON 坏了 → 记 warning 返回 None。**坏 meta 的代价只是"重新提取一遍"，不会崩**。

### 自测
1. 手动删掉 chat.meta.json 会发生什么？（答：下次 update 认为全是新事件，重新提取，产生重复条目，等 dedup 收拾——系统降级但不崩溃）
2. 为什么 temp 文件要和目标文件放在同一目录？

---

## 11. update.py —— 主管道（703 行，★★★ 重点）

### 职责
串起一切：增量 diff → 渲染 → 分块 → 逐块 LLM 提取 → 校验 → 落盘 → 更新 meta。L2 和 L3 各一套几乎平行的实现（`_run_update_l2` / `_run_update_l3`），结构相同、输入输出不同。

### 11.1 入口 `run_update(layer, key, ...)`

薄分发层：按 layer=="L2"/"L3" 转发，顺便处理 LLM 选择配置的作用域安装/复位（try/finally 保证复位）。budget 不传就用 settings 里的默认值。

### 11.2 L2 流程精讲（拿你的真实数据走一遍）

假设你的插件已产出这样的事件（真实捕获过的那个）：

```json
{"id":"run:01M0S7EKJ182B6Q9FMB4FRPAPM",
 "ts":"2026-08-24T06:31:14.754Z","surface":"run","kind":"execution_error",
 "payload":{"command":"python -c \"1/0\"","exit_code":1,
            "error_type":"ZeroDivisionError","error_message":"division by zero"}}
```

**Step 1：增量 diff（150-157）**

```python
meta = load_l2_meta(surface)                    # 上次见过的 id 集合
all_entities = sorted(snap.read_snapshot(surface), key=时间)   # 全部上游实体，按时间排
new_entities = [e for e in all_entities if f"{surface}:{e.id}" not in seen]
seen_now     = {f"{surface}:{e.id}" for e in all_entities}    # 本轮结束后"全都见过了"
```

注意两点：
- DeepTutor 的上游经过 snapshot 适配层（`snap.read_snapshot`）；**你的 TS 版直接读自己的 L1 JSONL 即可**，少一层抽象
- `seen_now` 取的是**全体**实体而不只是新的——即使本轮没新货，也要把"当前全集"写回 meta

**Step 2：无新输入的短路分支（169-194）**

没有新实体也并非什么都不干：仍然保存 meta（让 last_update_at 前进，表示"查过了，没有新货"），并且如果开了 auto_merge 照样跑 merge（可能是在清理旧格式文档）。然后提前 return，`no_new_input=True`。

**Step 3：渲染拼接（196）**

`render_traces_for_concat(new_entities, surface)` → 带着每个实体一个 `=== @entity run:01M0S7EKJ... ===` 头的大字符串。

**Step 4：分块（197-204）**

`chunk_with_boundary(text, budget=settings..., boundary=段落或句子)` → ChunkSpan 列表。

**Step 5：逐块主循环（219-310）——每块五连**

```python
for chunk in chunks:

    # ① 拼 system prompt：模板 + 用户名/表面/章节目录/今日日期
    system = prompt["system"].format(...)

    # ② 算本块引用池：marker 落在 [chunk.start, chunk.end) 势力范围内的实体
    allowed = refs_in_span_l2(new_entities, full_text=text, start, end)

    # ③ 拼 user prompt：现有文档全文(serialize(doc)) + 本块文本，
    #    并在块前塞一张"本块可引用清单"
    user = prompt["user"].format(
        existing=_render_existing_l2(doc),
        chunk=_chunk_with_ref_header(chunk.text, allowed), ...)
    #    _chunk_with_ref_header 生成：
    #    "# Chunk-local citeable refs\n- run:01M0S...\n- run:01N0X...\n\n(块正文)"
    #    → 把 allowed 池明示给 LLM，它照单引用，幻觉率大幅下降

    # ④ LLM → 容错解析 → 引用校验
    raw   = await call_llm(system_prompt=system, user_prompt=user, ...)
    facts = _parse_facts(raw)               # [{"text","refs","section"}...]，坏输出=[]
    for fact in facts:
        kept_refs, reason = validate_fact_refs(fact, allowed=allowed,
                                               enforce_required=..., drop_invalid=...)
        if reason: refs_dropped += 1; continue    # 拒绝的记数+发事件
        kept_in_chunk.append(fact with kept_refs)

    # ⑤ 以 AddOp 追加进内存 doc；本块有新增就立刻 checkpoint 写盘
    added_now = _append_facts_to_doc(doc, kept_in_chunk, sections)
    if added_now:
        await write_doc_checkpoint(l2_path, doc, ...)
```

**`_parse_facts`**（592-617）：剥围栏 → 抠 `{...}` → `json.loads` → 取 `facts` 数组 → 逐项取 text/section/refs 且全部强转 str → 空 text 丢弃。任何意外返回 `[]`。

**`_append_facts_to_doc`**（633-657）：每条 fact 一个 AddOp，单独 apply。LLM 给的 section 不在白名单里 → 映射回第一个合法 section（**保持章节目录跨轮稳定**，不让 LLM 随意发明新章节）。

**Step 6：收尾（312-337)**

```python
save_l2_meta(surface, seen_entity_refs=seen_now)   # ★ 所有块都成功了才写 meta
可选：run_dedup(...)    # 有新增且配置开启 → 自动去重
可选：run_merge(...)    # 配置开启 → 自动合并
```

**★ 这里藏着一个重要的崩溃恢复权衡，务必理解：**

checkpoint（每块写盘）发生在 meta 保存**之前**。如果在第 3 块处理中途崩溃：
- 前 2 块的 facts 已写进 L2 文档 ✅
- 但 meta 没更新 → 下次 update 会把前 2 块的实体**当成新的再来一遍** → 产生重复条目

这不是疏忽，是**at-least-once 语义 + dedup 补偿**的经典取舍：
- 若反过来（先写 meta 后写盘），崩溃会**丢失**那部分 facts（更糟）
- 重复的代价由 dedup 自动清理，丢失却救不回来

**选"宁可重复不可丢失"，再用下游去重兜底。** 你的 TS 版应该沿用这个顺序。

### 11.3 L3 流程的差异点（363-586）

骨架与 L2 完全相同，五个不同：

| | L2 update | L3 update |
|---|---|---|
| 输入 | 某个 surface 的 L1 实体（snapshot 层） | **所有 surface 的 L2 条目** |
| seen 记录 | `seen_entity_refs`（扁平集合） | `seen_l2_entry_ids`（按 surface 分桶） |
| 渲染 | 带 marker + ref/label/ts/meta 行 | 只有 `### surface:` 头 + `- [section] 正文`，**无 id 无 refs** |
| ref 池 | `surface:id` | 表面名（从 `### surface:` 头收集） |
| 新条目排序 | 按 ts | 按 entry id（ULID 前缀即时间） |

另外：`preferences` 槽位直接 raise——偏好是用户手动维护的，不允许自动改写。

### 11.4 UpdateResult

返回值是个小结账单：处理了几块、加了几条、拒了几条引用、新 entry id 列表、是否 no_new_input。UI 靠 `on_event` 回调拿过程事件（stage: trace_loaded/chunked/progress/facts_extracted/done...）画进度条——你的 TS 版可以用同样的回调模式向 webview 发进度。

### 自测
1. 为什么 `seen_now` 要包含全部实体而不是只有本轮新增的？
2. checkpoint 与 meta 保存的先后顺序交换会引入什么新问题？为什么说那个更糟？
3. `_chunk_with_ref_header` 把 allowed 池塞进 prompt——如果只靠 system prompt 里泛泛地说"只能引用输入中出现过的 id"，效果差在哪？
4. L3 的输入渲染为什么不带 entry id？这导致 L3 的审计链有什么不同？

---

## 12. 移植对照表（DeepTutor 概念 → 你的 TS 版）

| DeepTutor (Python) | 你的 vscode-pylearner (TS) |
|---|---|
| `Surface` = chat/notebook/quiz/kb/book/partner/cowriter | `SURFACES` = edit/run/chat/debug/diag |
| `snap.read_snapshot(surface)`（适配层产物） | 直读 `trace/<surface>/YYYY-MM-DD.jsonl`（你已有） |
| `TraceEvent` | `types.ts TraceEvent`（已对齐） |
| `Document/Entry/parse/serialize` | 待移植：`src/memory/document.ts`（M1） |
| `AddOp/EditOp/DeleteOp + apply` | 待移植：`src/memory/ops.ts` |
| `chunk_with_boundary` | 待移植：`src/memory/chunker.ts`（vitest 首个目标） |
| `validate_fact_refs / refs_in_span_*` | 待移植：`src/memory/references.ts`（M2） |
| `BANNED_PHRASES` | 直接抄词表，可加中文学习场景专属词 |
| `call_llm`（服务端多 provider） | 你的 `router.resolve(apiKey)` 后端（客户端直连） |
| `*.meta.json` + `_atomic_write_json` | `globalStorage` 下同名方案；Node tmp+rename |
| `on_event` 进度回调 | postMessage 到 webview 或 OutputChannel 日志 |
| asyncio.Lock per surface | 你已有的 Promise 锁链 |

**分层模型建议**（此前讨论过）：L2 提取用便宜快模型，L3 综合用好模型——你的 router 已支持多 provider，只需配置两个档位。

---

## 13. 读完后的综合自测（能全答上来就可以开工 M1 了）

1. 画出从"一条新的 L1 事件落地"到"L3 画像多了一句话"的完整路径，标出每步经过哪个文件哪个函数。
2. 系统在哪四处防御 LLM 的不可靠？（解析层/护栏层/引用校验层/op 校验层——各举一例）
3. 断电可能让系统处于哪些中间状态？各自的恢复行为是什么？（提示：L1 追加、L2 checkpoint、meta 原子替换三个层面分别想）
4. 如果学生删掉了 L2/chat.md 里的一个条目但没动 meta.json，下次 update 会怎样？这说明 L2 文档和 meta 的"真相归属"是怎样的关系？
