# 全链路走查：一条 L1 事件如何变成 L3 画像里的一句话

> 配套 [deep-tutor-pipeline-guide-answers.md](deep-tutor-pipeline-guide-answers.md) §13.1 的加详细版。
> 用你真实捕获的事件做主角：2026-08-24 你在 Extension Development Host 里跑的 `python -c "1/0"`。
> 每一步都给出**具体的输入数据、处理函数、输出数据**。标注"示意"的字段值是为教学构造的合理近似。

---

## 出场角色（先认清三个文件的状态）

| 文件 | 走查开始前 | 走查结束后 |
|---|---|---|
| `trace/run/2026-08-24.jsonl` | 已有 2 行（今天两个事件） | 不变（L1 只追加） |
| `L2/run.md` + `run.meta.json` | 有 1 条旧条目；meta 记了 1 个已见 id | 多 1 条新条目；meta 记 2 个 id |
| `L3/profile.md` + `profile.meta.json` | 有若干旧画像句子 | 多 1 句综合结论 |

---

## 阶段 1：事件已在 L1 落地（插件的功劳）

你按了运行，插件监听到失败，写入了这一行（真实数据）：

```json
{"id":"run:01M0S7EKJ182B6Q9FMB4FRPAPM",
 "ts":"2026-08-24T06:31:14.754Z",
 "surface":"run",
 "kind":"execution_error",
 "payload":{"source":"terminal",
            "command":"python -c \"1/0\"",
            "exit_code":1,
            "error_type":"ZeroDivisionError",
            "error_message":"division by zero",
            "file":"<string>",
            "line":1}}
```

同一天还有个更早的事件（上次测试跑的），id 是 `run:01M0S0NQ5KZ49C8WEX12KT236Z`——它已经被上一轮 update 消化过了。

## 阶段 2：适配层把原始行变成 Entity

update 管道不直接读 JSONL，而是经过 snapshot 适配层：

```python
all_entities = sorted(snap.read_snapshot("run"), key=lambda e: (e.ts or "", e.id))
```

适配器（`snapshot/adapters.py`）把每个事件的 payload 渲染成可读文本，产出统一形状的 Entity：

```python
# 示意——两个 Entity 的样子
Entity(
    id="01M0S0NQ5KZ49C8WEX12KT236Z",        # 注意：不带 surface 前缀
    ts="2026-08-24T05:58:xx.xxxZ",
    label="terminal run",
    content="python -c \"import sys\" 退出码 0",   # 由 payload 渲染（示意）
    metadata={...}
)
Entity(
    id="01M0S7EKJ182B6Q9FMB4FRPAPM",
    ts="2026-08-24T06:31:14.754Z",
    label="terminal run",
    content="python -c \"1/0\" 以退出码 1 结束：ZeroDivisionError: division by zero（<string>:1）",
    metadata={"exit_code": 1, ...}
)
```

排序键 `(ts, id)` 保证老事件在前——渲染出的文本就是天然的时间线。

## 阶段 3：增量 diff——找出"什么是新的"

`_run_update_l2("run", ...)` 开头（update.py 150-157 行）：

```python
meta = load_l2_meta("run")
# 磁盘上的 run.meta.json 此刻长这样：
# {"version":1, "last_update_at":"2026-08-23T10:02:11Z",
#  "seen_entity_refs":["run:01M0S0NQ5KZ49C8WEX12KT236Z"]}
#   ↑ 只有昨天那个旧事件被标记为"见过"

seen = meta.seen_entity_refs                       # {"run:01M0S0NQ..."}
new_entities = [e for e in all_entities
                if f"run:{e.id}" not in seen]      # → 只剩今天的新事件！
seen_now = {f"run:{e.id}" for e in all_entities}   # → 两个 id 都进集合（本轮结束时"全都见过了"）
```

发进度事件：`{"stage":"trace_loaded", "total":2, "new":1}`。

★ 注意 `new_entities` 只有 1 个——旧的不会被重新提取。这就是 meta 存在的全部意义。

## 阶段 4：渲染成带锚点的大文本

```python
text = render_traces_for_concat(new_entities, surface="run")     # references.py
```

输出（注意只有新实体进来，旧的没有）：

```
=== @entity run:01M0S7EKJ182B6Q9FMB4FRPAPM ===
ref: run:01M0S7EKJ182B6Q9FMB4FRPAPM
label: terminal run
ts: 2026-08-24T06:31:14.754Z
meta: exit_code=1 source=terminal

python -c "1/0" 以退出码 1 结束：ZeroDivisionError: division by zero（<string>:1）
```

那行 `=== @entity ... ===` 就是 marker——人看着是分隔线，机器靠它在文本里定位实体（下一步和引用池计算都靠它）。

## 阶段 5：分块

本例文本太短，走短路分支：

```python
chunks = chunk_with_boundary(text, budget=settings.update.l2_budget, ...)
# len(text) ≈ 300 字符 ≤ target → 直接返回一个块
# chunks = [ChunkSpan(index=0, start=0, end=len(text), text=<全文>)]
```

真实场景一天几十上百条事件时，这里会切成多个块并进入循环——流程对每块重复下面的阶段 6，共 N 次。

## 阶段 6：单块五连（核心中的核心）

### 6a. 算本块的引用池

```python
allowed = refs_in_span_l2(new_entities, surface="run",
                          full_text=text, start=0, end=len(text))
```

过程：在 full_text 里找 marker `"@entity run:01M0S7EKJ..."` 的位置 p；该实体的势力范围是 [p, 文本末尾)；与本块区间 [0, len) 相交 → 进池：

```python
allowed = {"run:01M0S7EKJ182B6Q9FMB4FRPAPM"}
```

### 6b. 拼 system prompt

```python
system = prompt["system"].format(
    user_label="kaiwa",           # 示意
    surface="run",
    sections="Errors, Patterns",  # 该表面允许的章节目录（示意，来自 surface_focus）
    focus="提取与运行/调试相关的事实",
    today="2026-08-24")
```

模板内容约束模型：客观措辞、必须给 refs、只能从给定清单引用等。

### 6c. 拼 user prompt

```python
user = prompt["user"].format(
    surface="run",
    existing=_render_existing_l2(doc),
    #   ↑ 把当前 run.md 全文 serialize 出来塞进去——让模型知道已有结论，
    #     避免重复提取已知事实（示意：现有 1 条关于旧事件的条目）
    chunk=_chunk_with_ref_header(chunk.text, allowed),
    #   ↑ 块正文前垫上引用清单 ↓
    chunk_index=1, chunk_total=1, ...)
```

`_chunk_with_ref_header` 的产物开头是：

```
# Chunk-local citeable refs
- run:01M0S7EKJ182B6Q9FMB4FRPAPM

（然后才是带 marker 的正文）
```

### 6d. 调 LLM

```python
raw = await call_llm(system_prompt=system, user_prompt=user, ...)
```

假设模型返回（我们故意让它犯一个错，看下游怎么接）：

````
```json
{"facts": [
  {"text": "运行 python -c \"1/0\" 因除以零抛出 ZeroDivisionError（division by zero）",
   "section": "Errors",
   "refs": ["run:01M0S7EKJ182B6Q9FMB4FRPAPM"]},
  {"text": "学生能主动构造最小复现用例来验证异常来源",
   "section": "Attitude",
   "refs": ["chat:01FAKEFAKEFAKEFAKEFAKEFAKEFA"]}
]}
```
````

第二条的 ref 是**编造的**（chat 表面根本没参与本次输入）。

### 6e. 容错解析

```python
facts = _parse_facts(raw)
```

内部：剥 ```` ``` ```` 围栏 → `find("{")`/`rfind("}")` 抠出对象 → `json.loads` → 取 `facts` 数组 → 逐项强转校验。产出：

```python
[ExtractedFact(text="运行 python...", refs=["run:01M0S7EKJ..."], section="Errors"),
 ExtractedFact(text="学生能主动构造...", refs=["chat:01FAKE..."], section="Attitude")]
```

### 6f. 引用校验——幻觉在这里被拦下

```python
for fact in facts:
    kept_refs, reject_reason = validate_fact_refs(
        fact, allowed=allowed,
        enforce_required=True,      # 典型配置
        drop_invalid=False)
```

- **第 1 条**：ref 在池内 → 放行，进 `kept_in_chunk`
- **第 2 条**：`chat:01FAKE...` ∉ allowed → 整条拒绝，reason=`"out-of-pool ref"` → `refs_dropped += 1`，发事件 `{"stage":"refs_dropped", "text":"学生能主动构造..."}`

★ 这一下就是"防幻觉闸门"的实弹射击：LLM 编的事实再圆滑，拿不出池内证据就出局。（若配置 `drop_invalid=True`，则只剥掉坏引用保留事实本身——策略可调。）

### 6g. 追加进文档（走 ops 原子操作）

```python
added_now = _append_facts_to_doc(doc, kept_in_chunk, sections=["Errors", "Patterns"])
```

内部逐条：fact.section="Errors" 在白名单内 → 构造 `AddOp(section="Errors", text=..., refs=[...])` → `ops.apply(doc,[op])`：

```
_validate：text 长度 OK ✅ refs 格式过 is_valid_ref ✅ 无批次冲突 ✅
应用：new_id = new_entry_id()  →  "m_01M0S8XXXXXXXXXXXXXXXXXXXXX"（新生成的 26 位）
     doc.section_entries("Errors").append(Entry(id=new_id, ...))
返回 ApplyReport(accepted=True, results=[OpResult(entry_id="m_01M0S8...")])
```

`added_now = ["m_01M0S8XXX..."]`，`facts_added = 1`。

### 6h. checkpoint 落盘

```python
await write_doc_checkpoint(l2_path, doc, ...)     # 本块有新增才写
```

serialize(doc) 生成的 `L2/run.md` 新增部分：

```markdown
## Errors

- （已有的旧条目……）[^1] <!--m_旧的某条-->

## Patterns
...

---

[^1]: run:01M0S0NQ5KZ49C8WEX12KT236Z
[^2]: run:01M0S7EKJ182B6Q9FMB4FRPAPM      ← 新分配的编号 2（首次出现顺序）
```

新 bullet 实际长这样：

```markdown
- 运行 python -c "1/0" 因除以零抛出 ZeroDivisionError（division by zero） [^2] <!--m_01M0S8XXXXXXXXXXXXXXXXXXXXX-->
```

写入方式：temp 文件 + `os.replace` 原子替换（断电也不会留半个文件）。

★ 顺序要点：**文档已更新，但 meta 还没动**。此刻若崩溃，下轮会把这条重新提取一遍产生重复——由 dedup 兜底（宁可重复不可丢失）。

## 阶段 7：收尾 L2 层

```python
save_l2_meta("run", seen_entity_refs=seen_now)
# run.meta.json 变成：
# {"version":1, "last_update_at":"2026-08-24T07:00:00Z",
#  "seen_entity_refs":["run:01M0S0NQ...","run:01M0S7EKJ..."]}
#    ↑ 两个都在了——下次这两个都不会再来

发事件 {"stage":"done","facts_added":1,"refs_dropped":1,"chunks_processed":1}

（若配置开启且 facts_added>0 → 自动 run_dedup；若 merge.auto_after_update → run_merge。P2 内容，此处按下。）
```

**L2 层到此完成。总消耗：1 次 LLM 调用，产出 1 条带证据的事实，拦下 1 条编造。**

---

## 阶段 8：L3 update——从表面事实到画像句子

触发 `run_update("L3", "profile")`（入口会先拒绝 preferences 槽位；profile 允许自动整合）。

### 8a. 收集所有表面的新 L2 条目

```python
meta = load_l3_meta("profile")
l2_docs = _load_all_l2_docs()     # parse 每个存在表面的 md 文件
for surface, doc in l2_docs.items():
    seen_now[surface] = {e.id for e in doc.all_entries()}
    new_entries = sorted(
        (e for e in doc.all_entries()
         if e.id not in meta.seen_l2_entry_ids.get(surface, set())),
        key=lambda e: e.id)       # ULID 排序 = 时间序（§ids.py 的伏笔在这兑现）
    entries_by_surface[surface] = new_entries
# 结果：entries_by_surface = {"run": [<刚创建的 m_01M0S8XXX 那条>], ...其他表面无新增}
```

注意 diff 的单位变了：L2 层比的是 **L1 实体 id**，L3 层比的是 **L2 条目的 m_xxx id**。

### 8b. 渲染——这次故意不给 id、不给脚注

```python
text = render_l2_entries_for_concat(entries_by_surface)
```

```
### surface: run

- [Errors] 运行 python -c "1/0" 因除以零抛出 ZeroDivisionError（division by zero）
```

对比阶段 4 的 L2 渲染：没有 `@entity` marker、没有 ref/label/ts/meta 行、没有脚注编号。合成层只见裸文本 + 表面归属。

### 8c. 分块 + 引用池（池里是表面名）

```python
chunks = chunk_with_boundary(...)   # 又是一块
allowed = refs_in_span_l3(entries_by_surface=..., full_text=text, start=0, end=len)
# 正则找 "### surface: run" 头 → 头在本块区间内 → allowed = {"run"}
```

### 8d. LLM 综合

prompt 用 `update_l3` 模板（slot=profile，existing=现有 profile.md 全文）。假设模型返回：

```json
{"facts": [
  {"text": "学生的运行错误集中在基础算术运算（如除零）；出错后倾向于直接求助而非先读报错信息",
   "section": "Learning patterns",
   "refs": ["run"]}
]}
```

校验：`"run"` ∈ {"run"} ✅ 放行。AddOp 入 profile 文档的 Learning patterns 章节。

### 8e. 最终落盘

`L3/profile.md` 新增一行：

```markdown
## Learning patterns

- 学生的运行错误集中在基础算术运算（如除零）；出错后倾向于直接求助而非先读报错信息 [^3] <!--m_01M0S9ZZZ...-->
```

文末脚注区多一行：

```markdown
[^3]: run
```

`save_l3_meta` 把新的 m_01M0S8XXX 记入 `seen_l2_entry_ids["run"]`。

**全程总计：2 次 LLM 调用（L2 提取 1 次 + L3 综合 1 次）。**

---

## 阶段 9：验收——人工走一遍审计链

三个月后你盯着这句画像想问"凭什么这么说"：

```
第 1 跳  L3/profile.md
   "…出错后倾向于直接求助…" [^3]
   [^3]: run                        ← 结论来自 run 表面的材料
第 2 跳  打开 L2/run.md
   "- 运行 python -c \"1/0\" 因除以零抛出 ZeroDivisionError…" [^2]
   [^2]: run:01M0S7EKJ182B6Q9FMB4FRPAPM   ← 具体证据事件
第 3 跳  grep 该 id
   $ grep 01M0S7EKJ trace/run/*.jsonl
   → 原始 JSONL 行：完整 command/exit_code/error_type/error_message/file/line
```

每一跳都是**机器可验证**的（id 格式固定、文件位置确定）也是**人可读**的（Markdown 打开就能看）。这就是"可审计画像"的物理实现。

---

## 时间线速查表

| # | 动作 | 函数（文件） | 输入 → 输出 |
|---|---|---|---|
| 1 | 插件捕获 | `writer.append`（你的 TS） | 运行失败 → JSONL 一行 |
| 2 | 实体化 | `read_snapshot`（adapters.py） | JSONL 行 → Entity{id,ts,label,content} |
| 3 | L2 diff | `_run_update_l2` 开头 | meta.seen vs 全体 → new_entities |
| 4 | 渲染 | `render_traces_for_concat` | Entities → 带 @entity marker 的文本 |
| 5 | 分块 | `chunk_with_boundary` | 文本 → ChunkSpan[] |
| 6a | 引用池 | `refs_in_span_l2` | marker 位置 × 块区间 → allowed 集 |
| 6b-c | 拼 prompt | `load_prompt` + format + `_chunk_with_ref_header` | 模板+doc 全文+块+清单 → system/user |
| 6d | LLM | `call_llm` | prompts → raw 文本 |
| 6e | 解析 | `_parse_facts` | raw → ExtractedFact[] |
| 6f | 校验 | `validate_fact_refs` | facts × allowed → 幸存者 + 拒绝记录 |
| 6g | 入库 | `_append_facts_to_doc` → `ops.apply` | facts → Entry(m_新id) 进内存 doc |
| 6h | 落盘 | `write_doc_checkpoint`(serialize) | doc → L2/run.md（原子写） |
| 7 | 记进度 | `save_l2_meta` | seen_now → run.meta.json |
| 8 | L3 全套 | `_run_update_l3`（同构 3-7） | 各表面新条目 → profile.md 新句子 |

把这张表和 §13.1 的八步简版对照着记：简版是骨架，本文是血肉。
