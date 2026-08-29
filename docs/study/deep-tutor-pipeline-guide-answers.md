# 自测题参考答案

> 配套 [deep-tutor-pipeline-reading-guide.md](deep-tutor-pipeline-reading-guide.md)。
> 建议先自己作答再对答案——答案里标 ★ 的是高频面试题/设计精髓。

---

## §2 ids.py

### 1. 为什么 ULID 能"天然按时间排序"？前几个字符决定了什么？

ULID 的 26 字符 = **前 10 字符时间戳（48 位毫秒数）+ 后 16 字符随机数**，用 Crockford Base32 编码（每字符 5 bit）。能按字符串排序恢复时间序，靠两个条件同时成立：

1. **定长**：所有 ULID 都是 26 字符，不存在位数不齐导致的比较错位
2. **字母表的字符顺序 = 数值顺序**：Crockford 字母表 `0123456789ABCDEFGHJKMNPQRSTVWXYZ` 本身有序，所以逐字符比较等价于逐 5-bit 比较

因此 `strcmp(ulidA, ulidB)` ≡ 比较两者的生成毫秒数——前 10 个字符就是全部时间信息（48 位毫秒 ≈ 可表示 8000 多年，够用）。

两个已知瑕疵（工程上可接受）：同一毫秒内生成的多个 id 靠随机位决序（无时间意义）；跨机器时钟回拨会乱序。DeepTutor 单机场景两者都无所谓。

### 2. L3 的引用为什么不需要 id 部分？

三个原因，按重要性：

1. **稳定性**：L2 条目的 m_xxx id 是易变资产——dedup 合并会杀死旧 id、merge 会重写条目。如果 L3 直接引用条目 id，每次 L2 整理都会批量制造悬空引用。而"表面名"（chat/run…）几乎不变。
2. **可读性**：L3 是给人看的画像，挂满 26 位 id 会毁掉阅读体验。
3. **明确的设计决策**：references.py 的 docstring 写明用户要求 LLM 不应看见或复制 L2 的溯源标注；update.py 注释称这换来一条干净的链：L3 → L2 **文件** → L1 原始事件。

代价是 L3 层审计粒度粗（要打开对应 L2 文件才能定位到具体条目）——这是有意换取的。

---

## §3 trace.py

### 1. `path.stem < cutoff_date_iso` 为什么能当日期比较？

文件名格式 `YYYY-MM-DD`（ISO 8601）：**定宽、零填充、高位字段在前**（年→月→日）。这种格式下字典序严格等于时间序：

```
"2026-07-30" < "2026-08-01"   ✅ 字符串比较和日期比较结论一致
```

同一个技巧在下一行还用了一次：`obj.get("ts","") < cutoff_iso` 直接比较 ISO 时间戳字符串。成立前提：**时间戳必须统一格式、统一时区**（DeepTutor 全部写 UTC ISO 串）。一旦混入不同时区偏移或不同格式，字符串比较就失效——这是移植时要守死的约定。

### 2. 一行 JSONL 尾部被截断会怎样？

`json.loads` 抛 `JSONDecodeError` → 被第 103-106 行的 try/except 接住 → `continue` 跳过该行。后果：

- **不会崩**，其余行照常产出
- 只有那一个事件丢失（对下游等于从未存在）

写入端也配合降低了截断概率：`_append_line` 用单次 `write(line + "\n")`，行与行之间不会被并发写入交错。整体哲学：**单点损坏，单行止损**。

---

## §4 document.py

### 1. `[^1][^3]` 怎么还原成真实 refs？经过哪张表？

三步，中间表是 Pass 1 建的 **`ref_by_label`**（编号 → 真实 ref）：

```
① _NEW_BULLET_RE 匹配整行，markers 组捕获到原始子串 "[^1][^3]"
② _MARKER_RE.findall("[^1][^3]") → ["1", "3"]        （156 行）
③ 逐个拿编号查 Pass 1 的 ref_by_label：
      "1" → "chat:01HZ..."     （来自文末 [^1]: chat:01HZ... 定义行）
      "3" → "run:01XYZ..."
   得 ["chat:01HZ...", "run:01XYZ"]，边查边去重保序   （158-161 行）
```

注意依赖方向：脚注定义行在文件**末尾**，bullet 在前面——所以必须先扫完全部脚注（Pass 1），再解析 bullet（Pass 2）。

### 2. 手动删掉一个 `<!--m_xxx-->` 锚点会怎样？

该行不再匹配 `_NEW_BULLET_RE`（id 组是行尾必需项），也不匹配旧格式正则 → 在 Pass 2 中被静默跳过 → **这条 Entry 从 Document 里消失**。

连锁反应：下次 serialize 时，标签分配只从存活条目的 refs 重建（193-200 行），死掉条目独占的脚注编号也随之消失。也就是说：**删锚点 = 删条目，且下一次保存后永久生效**。这就是指南里说的"文档格式对手工编辑脆弱"，也是 DELETE /entry/{id} 选择锚点作为定位依据的原因——它既是功能也是命门。

### 3. 为什么 serialize 必须保证幂等？

四个下游都押在这个不变式上：

1. **checkpoint 安全**：update.py 每个 chunk 都可能把内存 doc 序列化写盘——若序列化有漂移，反复写盘会让文件越改越歪
2. **锚点稳定**：`DELETE /entry/{id}`、audit、dedup 都靠 `<!--m_xxx-->` 定位；往返变形可能移动或弄丢锚点
3. **diff 干净**：幂等意味着"没有数据变化的保存"产生空 diff，人审历史记录不被噪音淹没
4. **信任**：用户手改过的文档被程序重新保存后，内容不该意外变化

实现上幂等的根源：serialize 只从 Entry 结构化字段重建文本（标题、章节、正文、refs、id 全部来自 parse 的产物），不保留任何"原文残留状态"。

---

## §5 ops.py

### 1. 为什么维护 `edits` 和 `deletes` 两个集合并互相检查两次？

因为**批次内操作的先后顺序是任意的**，冲突检测必须双向覆盖：

```
情况 A：先 EditOp(x) 后 DeleteOp(x)
   → 校验 DeleteOp 时发现 x ∈ edits 集 → 拒绝        （111-114 行）
情况 B：先 DeleteOp(x) 后 EditOp(x)
   → 校验 EditOp 时发现 x ∈ deletes 集 → 拒绝        （99-102 行）
```

只检查一个方向，就会漏掉另一种排列。这是"集合 + 双向互斥检查"处理无序批量的标准手法。

★ 追问层：为什么冲突要拒绝而不是定义一个确定性的应用顺序（比如"删除赢"）？docstring 给了答案——**拒绝让 LLM 显式修正自相矛盾**，而静默消解会把矛盾埋进数据里，谁也不知道发生过。

### 2. 应用到一半抛异常怎么办？安全吗？

安全，但不是靠事务机制，而是靠**构造性排除失败面**：

- `_validate` 已确认：edit/delete 目标存在、text 长度合法、refs 格式合法、无批次冲突
- 应用阶段只剩三类动作：
  - Add：`new_entry_id()`（随机数生成，不抛）+ `list.append`（不抛）
  - Edit：给已存在的 Entry 赋值两个字段（不抛）
  - Delete：`doc.remove`（校验过存在，必返回 True）
- 第 141 行 `assert entry is not None` 是把"校验保证了这一点"写成断言存档

结论：**validate 把所有可能失败的事做完，apply 只剩不可能失败的纯内存操作**——于是不需要 rollback。对比反面设计：如果 apply 里夹了 IO 或复杂计算，就得引入撤销日志。这是"前置校验换事务复杂度"的经典取舍。

---

## §6 chunker.py

### 1. budget=3、len=900、min=100、max=500，target=?

```
target = ceil(900 / 3) = 300
clamp 到 [100, 500] → 300
```

即理想均分每块 300 字符，约出 3 块（实际块数会被边界扩展和重叠微调）。

### 2. 没有 overlap / 没有 hard cap 各会发生什么？

**没有 overlap**：一条恰好横跨切缝的事实（前半句在第 k 块结尾、后半句在第 k+1 块开头），两块看到的都是残句——轻则提取不出，重则模型脑补补全。**dedup 无法补救"从未被提取出来"的信息**，重叠是给跨界事实买的双保险。

**没有 hard cap**（`_expand_to_boundary` 的 limit 参数）：病态输入——比如一整行 50 万字符、没有任何段落/句子边界——`pattern.search` 找不到边界会一路搜到文本末尾，这一块直接膨胀成整个输入，budget 完全失效，后续 LLM 调用爆上下文。有了 cap：找不到边界就接受一次非边界切割，但块长封顶在 max_chunk_chars。

两条防御合起来的精神：**优化路径可以优雅（对齐边界），退化路径必须有界（宁可切坏不可失控）**。

---

## §7 guards.py

### 1. `"用户说自己「总是搞混 == 和 is」"` 会被过滤吗？

**不会。** 流程：

```python
stripped = _QUOTED_RE.sub("", text)    # 剥掉「总是搞混 == 和 is」
# stripped = "用户说自己"               # 剩余部分不含任何禁词
```

禁词"总是"只出现在 CJK 引号内，而引号区域是**用户原话引用**——引用用户的绝对化措辞是在陈述事实（他说过什么），不是 AI 自己下判断。剥引号再查的设计精确区分了这两种语境。

### 2. 为什么记 warning 日志而不只是丢弃？

三个理由，核心是**护栏本身需要可观测**：

1. **调词表**：docstring 明说"Logged as a warning so we can tune the list against real prompt regressions"。日志积累的真实误报样本告诉你哪个词禁宽了（比如模型正常表述里高频合法出现某个词），据此增删 BANNED_PHRASES。
2. **区分两种世界**：没有日志时，"facts 变少了"无法区分是"模型表现良好"还是"过滤器吃掉了正常输出"——护栏失效和过度拦截都不可见。
3. **调试线索**：某条事实凭空消失，有日志就能立刻定位到"因违禁词 X 被丢"，否则是无头案。

通用原则：**任何自动丢弃数据的机制都必须留下痕迹**。

---

## §8 parse.py

### 1. 为什么 `find("{")` 配 `rfind("}")` 而不是第一个 `}`？

因为 JSON 可以嵌套。取"最后一个 `}`"是为了拿到**最外层的闭括号**：

```json
{"thought": "...", "args": {"x": 1}}
                             ↑ 第一个 } 在这里（内层），用它截断得到残废串
```

`find("{") + rfind("}")` 圈出最大候选范围，再交给严格的 `json.loads` 验真。组合拳逻辑：**廉价的启发式负责"抠出来"，严格的验证器负责"判真假"**——启发式可以放宽（多抠不碍事），验证器把关正确性。

残留缺陷：如果 JSON 后面的散文里又出现 `}`，rfind 会圈进垃圾导致解析失败——宁可失败返回 None 重试，也不冒截断的风险，方向是对的。

### 2. 解析失败 return None 之后调用方怎么处理？

分场景，原则是**parse 层只报告失败，策略归调用方**：

- **agentic loop（parse_action）**：driver 把"你的输出不是合法 JSON"渲染成一条观察反馈塞回对话，模型下一轮自我纠正——把失败变成教学信号而非终止条件（有重试预算上限兜底）。
- **update 管道（_parse_facts）**：返回 `[]`，该 chunk 颗粒无收但流程继续——降级为"这块没提到东西"，可接受（也可加日志告警）。

共同底线：**一条坏输出绝不炸掉整轮运行**。

---

## §9 references.py ★★★

### 1. 引用真实存在但不在当前 chunk 的事件池里，会怎样？

**绝不会被原样放行。** 具体结局取决于设置开关的组合：

| drop_invalid | 结局 |
|:---:|---|
| `False` | 整条 fact 被拒，reason=`"out-of-pool ref"`（163 行前的循环：任何一个池外合法格式的 ref 都直接否决全条） |
| `True` | 该 ref 被**剥离**，fact 带着幸存的 refs 继续走；若剥离后为空且 `enforce_required=True` → 整条拒绝（`"no surviving refs in chunk pool"`）；`enforce_required=False` 则允许零引用存活 |

关键认知：**"真实存在"根本不是判定标准**。allowed 池的定义是"本轮实际展示给模型的证据范围"。指向池外的引用，无论目标是否存在于世界上，都说明这句话不是从眼前材料里推导出来的——要么幻觉、要么串块污染，两种都不可信。这就是"cite only what you saw this turn"原则。

### 2. `_has_ref_suffix` 为什么对接缝字符那么苛刻？

反例正是题目里的 `"my_chat:01HZ..."`：

```
candidate = "my_chat:01HZ..."
allowed   = "chat:01HZ..."
endswith? ✅（末 9 字符确实相同）
prefix    = "my_"，末字符 "_"
"_" ∈ {:, ：, ?, ？, #, /, |, 空白, ^}? ❌ → 拒绝归一化
```

为什么 `_` 必须拒：`my_chat` 读起来是**一个完整标识符**（下划线是单词连接符）。如果放行，系统就把模型写的 `my_chat:01HZ...` **改写**成了 `chat:01HZ...`——这不是修格式，是偷换身份。极端情况下更长的 id 与短 id 同尾时，宽松后缀匹配会静默指鹿为马。

接缝字符白名单（`:` `：` `?` `？` `#` `/` `|` 空白 `^`）的共同语义是"**装饰性前后缀的分隔符**"——`"我的笔记: chat:01HZ"`、`"[^chat:01HZ]"` 这类"ref 被包装"的场景才允许修复。

一句话：**格式可以修，身份不能猜**。

### 3. L3 为什么不给 LLM 看 L2 的 footnote？给了会怎样？

render 函数 docstring 给了直接答案："the user has explicitly said the LLM should not see — or copy — L2 footnote provenance"。展开：

1. **防引用体系污染**：LLM 看见 `[^m_xxx]` 就会顺手抄进自己的输出，但 L3 的引用契约是表面名。混入条目级 id 会破坏整套两跳审计链的规整性。
2. **防抄袭锚定**：看见带溯源的原句，模型倾向于"改写并标注"而不是真正综合提炼。
3. **稳定性**（同 §2.2）：L3 若持条目 id 引用，L2 每次 dedup/merge 都会产生悬空引用；文件级指针不受内部整理影响。

给了会怎样：短期看似溯源更精细，长期 L3 文档变成悬空引用的重灾区——审计链在最常变动的一环上断裂。

---

## §10 meta.py

### 1. 手动删掉 chat.meta.json 会怎样？

```
load → None → 当作首次运行，seen = ∅
→ 下次 update 认为所有实体都是新的 → 全量重新提取
→ 新条目与旧条目并存（同样的结论、不同的 m_xxx id）
→ 若开启 auto_dedup：自动合并去重收拾残局
```

系统**降级但不崩溃**：代价是一轮浪费的 LLM 调用 + 短期重复，最终收敛。这个行为揭示了 meta 的本质定位——**它是进度簿记（可抛弃的缓存），不是真相源**。真相永远在 L1 trace 和 L2/L3 文档本体里。

### 2. 为什么 temp 文件必须和目标文件同目录？

因为 `os.replace` 的**原子性只在同一文件系统内成立**：

- 同分区：rename 是元数据操作，要么完成要么没发生，观察者永远看到完整的新文件或完整的旧文件
- 跨分区（比如 temp 在 /tmp 而 target 在数据盘）：内核退化为 copy+delete，中间存在"目标只有一半内容"的窗口；某些系统直接报 EXDEV 错误

`tempfile.mkstemp(dir=path.parent)` 一行保证同目录 → 同文件系统 → 原子性成立。你 TS 版同理：Node 的 `fs.renameSync` 跨设备同样失败，temp 必须建在目标同目录。

---

## §11 update.py ★★★

### 1. 为什么 `seen_now` 包含全部实体而不只是新增？

```python
seen_now = {f"{surface}:{e.id}" for e in all_entities}   # ← 全体，不是 new_entities
```

三个作用：

1. **短路分支需要它**（169-173 行）：没有新实体时也要 `save_l2_meta(seen_entity_refs=seen_now)`——让 `last_update_at` 前进表示"查过了没新货"，并把当前全集固化下来。
2. **自愈性**：meta 文件损坏/缺失时，保存全集能把进度状态一次性修复到"现存皆已处理"，不需要增量修补。
3. **语义正确**：save 的含义应该是"此刻磁盘上存在的一切都已处理完毕"，而不是"本轮我处理了哪些"。后者会在 meta 缺失等异常路径上留下永久盲区。

细节：运行中途新到的事件不在启动时的 `all_entities` 快照里，所以也不会被错误标记为 seen——它们自然落入下一轮。

### 2. ★ checkpoint 与 meta 保存顺序交换的问题

现状：每个 chunk 有新增就 checkpoint 写文档，**全部完成后**才存 meta。中途崩溃 → 前 k 块的事实已入库但 meta 未更新 → 下轮这些块被当新的重跑 → **产生重复条目** → dedup 自动清理。

若交换（先标 seen 再写盘）：崩溃发生在"meta 已更新、文档未落盘"的缝隙 → 这些块的提取结果**永久丢失且无人知晓**——下轮不会再碰它们（已 seen），原始事件还在但没有触发重新提取的机制，而 LLM 提取是不可复现的（换个温度结果就不同）。

| 方案 | 最坏后果 | 可否自动恢复 |
|---|---|---|
| 现状（先文档后 meta） | 重复条目 | ✅ dedup 清理 |
| 交换（先 meta 后文档） | 静默丢失事实 | ❌ 无 |

**可检测的重复 < 不可检测的丢失**，这就是 at-least-once 语义的选择依据。记住这个模式，分布式系统和本地管道里到处是它。

### 3. allowed 池明示进 prompt vs 泛泛叮嘱，差在哪？

四个层面：

1. **26 位 id 根本背不出来**。ULID 是高熵随机串，模型逐字符"回忆"必然出错——它只能**照抄**。清单放在眼前，抄写任务的准确率远高于记忆任务。
2. **注意力邻近性**。清单紧贴本块正文（`_chunk_with_ref_header` 把它垫在 chunk 前面），比 system prompt 里一句远处的软约束有效得多——长 prompt 中间部分的指令遵循率是出了名的低。
3. **任务降维**。"只能引用输入中出现过的 id"要求模型自己判断"哪些出现过"；给清单后变成"从这个列表里选"，难度骤降。
4. **可诊断性**。有了显式清单，校验阶段抓到池外引用就可以确定是模型违规（而不是提示歧义），日志和反馈都有明确语义。

实测效果：dropped-fact 率大幅下降。这是"约束要具体化、局部化"的范例——对 LLM 的每个要求都应该问一句：能不能把它变成照抄题？

### 4. L3 渲染不带 entry id，审计链有何不同？

（与 §9.3 呼应）L3 条目的引用是表面名，审计链变成人工两跳：

```
L3 画像句子 [^n]: chat          ← 第一跳：打开哪个文件
    └─ L2/chat.md 里的条目及其脚注 [^k]: chat:01HZ...
                                      ← 第二跳：定位到原始事件
                                          └─ trace/chat/*.jsonl 对应行
```

粒度差异：L2 层审计精确到**单个事件**，L3 层只精确到**表面文件**——要靠人再翻一层。换取的是链条对 L2 内部整理（dedup/merge 杀 id）完全免疫。这是"审计粒度 vs 引用寿命"的权衡，产品上选了寿命。

---

## §13 综合自测

### 1. 从一条 L1 事件落地到 L3 画像多一句话的完整路径

以你的 ZeroDivisionError 事件为例：

```
① 插件捕获运行失败
   l1Writer.append → trace/run/2026-08-24.jsonl 多一行
   {"id":"run:01M0S7EKJ...", kind:"execution_error", error_type:"ZeroDivisionError"}

② 进入快照适配层
   snap.read_snapshot("run") → Entity{id:"01M0S7EKJ...", ts, label, content}   [snapshot/adapters.py]

③ 触发 L2 update（run_update("L2","run")）                    [modes/update.py]
   load_l2_meta("run") → 上次 seen 集合                        [meta.py]
   id 差集 → new_entities 含该事件
   render_traces_for_concat → 带 "@entity run:01M0S7EKJ..." 头的大文本   [references.py]
   chunk_with_boundary → ChunkSpan 列表                        [chunker.py]

④ 逐块循环（每个 chunk 五连）                                  [update.py]
   refs_in_span_l2 → allowed 池                               [references.py]
   拼 prompt：system(update_l2 模板) + user(existing 全文 + 带引用清单头的块)
   call_llm → 原始输出                                        [_runtime.py]
   _parse_facts → [{"text":"学生遇到除零异常后未自行修复", refs:["run:01M0S7EKJ..."]}]
   validate_fact_refs → 引用在池内，放行                       [references.py]
   _append_facts_to_doc → AddOp → ops.apply → 内存 doc 多一个 Entry(m_新id)  [ops.py]

⑤ write_doc_checkpoint → serialize(doc) → 原子写 L2/run.md     [document.py]
⑥ 全部块完成 → save_l2_meta                                    [meta.py]

⑦ 触发 L3 update（run_update("L3","profile")）
   _load_all_l2_docs → parse 所有 L2 文件                     [document.py]
   entry id 差集 → 新 L2 条目
   render_l2_entries_for_concat → "### surface: run\n- ..."   （无 id 无脚注）
   分块 → LLM 综合提炼 → validate_fact_refs（池 = 表面名 {"run"}）
   AddOp 入 L3 profile.md → checkpoint → save_l3_meta

⑧ 最终产物：profile.md 多一行
   "- 学生的运行错误集中在基础算术运算（如除零），出错后倾向直接求助而非自查 [^n] <!--m_yyy-->"
        …文末…  [^n]: run
```

### 2. 四处防御 LLM 不可靠（各举一例）

| 层 | 文件 | 防什么 | 例 |
|---|---|---|---|
| 解析层 | parse.py / _parse_facts | 输出格式不可靠 | code fence、前后废话、半残 JSON → 容错抠取，失败返回 None/[] 不崩 |
| 护栏层 | guards.py | 措辞不可靠 | "深刻掌握/总是/never" 绝对化断言 → 剥引号后命中即丢 op 并反馈 |
| 引用校验层 | references.validate_fact_refs | 事实来源不可靠 | 编造/串块的 ref → 拒整条或剥引用；抄歪的 ref → 宽容归一化 |
| op 校验层 | ops._validate | 操作合法性 | text 超 240 字、refs 空、edit+delete 同 id 冲突、delete reason 不在枚举 → 整批拒绝 |

加分第五处：`_append_facts_to_doc` 的章节白名单映射——LLLM 发明的野章节名被强制折回合法目录。

### 3. 断电的中间状态与恢复行为

| 断电时刻 | 磁盘状态 | 恢复行为 |
|---|---|---|
| L1 追加中（一行写到一半） | 尾部截断行 | reader 解析失败跳过，仅此一事件丢失（best-effort 设计如此） |
| meta 原子写中（mkstemp 之后 replace 之前） | 旧 meta 完好 + 一个孤儿 tmp 文件 | load 读到旧版本，行为正确；tmp 成无害垃圾 |
| 文档 checkpoint 后、meta 保存前 | 新 facts 已入 L2，meta 还是旧的 | 下轮重提 → 重复条目 → dedup 清理（at-least-once） |
| 文档 checkpoint 写入中（假设非原子） | 可能截断的 md | parse 容错跳坏行，部分条目损失（实际 write_doc_checkpoint 走原子写，此态罕见） |

贯穿规律：**设计保证了 meta 的进度永远不会领先于文档的实际内容**（先写文档后写 meta），所以一切中间态的最坏结果是"重复"，绝不会是"丢失"。

### 4. 学生删了 L2/chat.md 一个条目、没动 meta.json，下次 update 会怎样？

推演：

- **L2 update**：diff 发生在 L1 实体层（seen_entity_refs），与 L2 文档内容无关 → 无新实体 → 走 no_new_input 短路 → **不会复活被删条目**
- **L3 update**：diff 基于"当前 L2 文档里的 entry id 集合"——被删的 id 既不在文档里（不是新的）也不触发任何重建 → 删除**向上传播**：L3 下轮综合时自然不再看到它

这说明的真相归属结构：

> **L2/L3 Markdown 文档是派生知识的真相源——人的编辑拥有最高优先权；meta.json 只是处理进度的簿记。**

不对称性佐证：删 meta（留文档）→ 数据重生（重新提取）；删文档条目（留 meta）→ 删除被尊重。系统把"内容真相"给了文档、把"进度真相"给了 meta，两者职责分离所以互不覆盖。

一个延伸提醒：学生若想彻底遗忘某个行为，删 L2 条目还不够——L1 原始事件仍在（好在已被 seen，不会自动复活进画像）。隐私层面的"彻底清除"需要连带清理 L1 trace + snapshot + meta，这是你 TS 版将来要做"忘记我"功能时的完整清单。

---

## 答完之后

全部答对的标准不是背下答案，而是能对每题追问一层"为什么不用另一种方案"。哪几题答得费劲，就回到指南对应的 § 重读那一段——费劲的位置通常就是你移植时会踩坑的位置。
