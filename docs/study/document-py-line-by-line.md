# document.py 逐行精讲

> 配套 [deep-tutor-pipeline-reading-guide.md](deep-tutor-pipeline-reading-guide.md) §4。
> 源码：`D:\ruan\DeepTutor\DeepTutor\deeptutor\services\memory\document.py`（235 行）。
> 建议左右分屏：左边开源码，右边看本文。

---

## 总览：这个文件解决什么问题

L2/L3 的画像文件是 Markdown，但管道代码需要**结构化对象**（找条目、加条目、删条目）。本文件就是两者之间的转换器：

```
磁盘上的 .md 文件  ←─ serialize(doc) ──  Document 对象（内存）
（人可读可编辑）    ── parse(md) ─→      （程序好操作）
```

只有 4 个公开 API：`Document`、`Entry`、`parse`、`serialize`（见最后一行 `__all__`）。

---

## 第 1–34 行：模块 docstring —— 先读说明书

```python
"""Markdown documents with footnote-style citations.
...
"""
```

这不是注释废话，是**规格说明**。四条关键约定，读码前先记住：

| 约定 | 内容 |
|---|---|
| 文档形状 | `# 标题` → 若干 `## 章节`，每个条目一条 bullet：`- 正文 [^1][^2] <!--m_xxx-->`，文末 `---` 后是脚注表 |
| 脚注标签 | **整数**，按首次出现顺序分配；两条目引同一来源共用一个编号 |
| 条目锚点 | bullet 尾部 `<!--m_xxx-->` 是 Entry 的持久化 id，删除/编辑靠它定位 |
| 兼容性 | 同时接受旧格式（bullet 以 `[^m_xxx]` 结尾），旧文档下次保存时自动迁移 |
| 不变式 | `serialize(parse(x)) == x` 对本工具生成的文档成立（往返幂等） |

---

## 第 36–39 行：导入

```python
from __future__ import annotations          # 36
                                            # 37
from dataclasses import dataclass, field    # 38
import re                                   # 39
```

- **36**：让类型注解变成"惰性"的——注解里的 `str | None`、前向引用类名都不会在运行时立即求值。作用是兼容旧版 Python 和允许"先用后定义"。对运行逻辑零影响，纯类型层。
- **38**：`dataclass` 是装饰器，给类自动生成 `__init__`/`__repr__`/`__eq__`（≈ Java record / Lombok `@Data`）；`field` 用于给字段定制默认值行为（第 69 行见）。
- **39**：正则库。下面的常量全是预编译的正则。

---

## 第 41–61 行：五个正则常量 —— 格式的机器定义

> 惯例：下划线开头 = 模块私有（≈ Java 的 private，只是君子协定）。
> 这些正则就是文档格式的**唯一权威定义**——想知道"什么算合法条目"，看这里，别看注释。

### 第 41 行：entry id 的形状

```python
_ENTRY_ID_RE = r"m_[0-9A-HJKMNP-TV-Z]{26}"
```

- `r"..."`：raw 字符串，`\` 不转义（正则里写 `\s` 不用写成 `\\s`）
- `m_` 前缀 + 恰好 26 个 Crockford Base32 字符
- 字符集里**故意缺** `I L O U`：Crockford 编码去掉了易混淆的 I/L/O，ULID 又去掉 U。所以 `m_01IL…` 非法——这不是 bug，是防呆
- 注意它是普通字符串不是正则对象——因为它是**零件**，要被 f-string 嵌进下面几个正则里复用

### 第 43–44 行：标题与章节

```python
_TITLE_RE   = re.compile(r"^#\s+(.+?)\s*$")     # 43  匹配 "# xxx"
_SECTION_RE = re.compile(r"^##\s+(.+?)\s*$")    # 44  匹配 "## xxx"
```

逐段拆：

| 片段 | 含义 |
|---|---|
| `^#` | 行首一个 `#`。**为什么不会误吃 `##`？** 因为下一个要求是 `\s`（空白），而 `##` 的第二个字符是 `#` 不是空白 → `_TITLE_RE` 对 `## x` 失败。两个正则天然互斥 |
| `\s+` | 至少一个空白 |
| `(.+?)` | 捕获组 1：标题文字。`+?` 是**非贪婪**——尽量少吃字符 |
| `\s*$` | 行尾可有空白。和非贪婪配合：正则引擎先让 `.+?` 吃最少，发现匹配不上行尾，再逐步多吐字回来，最终把尾部空格留给 `\s*` → **捕获组自动不含首尾空格** |

### 第 46–52 行：新格式 bullet（最重要的一行）

```python
_NEW_BULLET_RE = re.compile(
    rf"^\s*-\s+(?P<text>.*?)(?P<markers>(?:\s*,?\s*\[\^[^\]]+\])*)\s*<!--\s*(?P<id>{_ENTRY_ID_RE})\s*-->\s*$"
)
```

`rf"..."` = f-string + raw：`{_ENTRY_ID_RE}` 会被替换成第 41 行的内容再编译。

逐段拆（从左到右）：

| 片段 | 匹配什么 |
|---|---|
| `^\s*` | 容忍行首缩进 |
| `-\s+` | bullet 的 `- ` 加至少一个空白 |
| `(?P<text>.*?)` | **命名捕获组 text**：正文，非贪婪 |
| `(?P<markers>(?:\s*,?\s*\[\^[^\]]+\])*)` | **命名组 markers**：零个或多个引用标记 |
| `\s*<!--\s*(?P<id>m_…)\s*-->\s*$` | 尾部 HTML 注释锚点 |

markers 组内部再拆一层：`(?:...)*` 是**非捕获分组**（只分组不存结果）；每次重复匹配 `\s*,?\s*` （可选逗号和空格——所以 `[^1][^2]` 和 `[^1], [^2]` 都合法）+ `\[\^` （字面 `[^`，`[` 要转义）+ `[^\]]+` （marker 名：除 `]` 外任意字符）+ `\]`。

试金石——哪些能匹配：

```
"- 用户怕递归 [^1][^2] <!--m_01ABC-->"        ✅ text=用户怕递归, markers=[^1][^2], id=01ABC
"- 用户怕递归 [^1], [^3] <!--m_01ABC-->"      ✅ 逗号分隔也行
"- 用户怕递归 <!--m_01ABC-->"                 ✅ markers 零次重复，无引用的条目
"- 无锚点的普通 bullet"                        ❌ 缺 <!-- -->，整行不认
```

### 第 54 行：旧格式 bullet

```python
_OLD_BULLET_RE = re.compile(rf"^\s*-\s+(?P<text>.*?)\[\^(?P<id>{_ENTRY_ID_RE})\]\s*$")
```

旧行长这样：`"- 用户怕递归[^m_01ABC]"`——引用标记和条目 id 是同一个东西，直接钉在行尾。

### 第 57–59 行：两种脚注定义

```python
_OLD_FOOTNOTE_RE = re.compile(rf"^\[\^(?P<id>{_ENTRY_ID_RE})\]:\s*(?P<refs>.*?)\s*$")   # 57
_NEW_FOOTNOTE_RE = re.compile(r"^\[\^(?P<label>[^\]]+)\]:\s*(?P<ref>.*?)\s*$")          # 58
```

```
旧：[^m_01ABC]: run:01XYZ, chat:01PPP      ← label 就是 entry id，refs 是逗号分隔列表
新：[^1]: run:01XYZ                        ← label 是整数，ref 只有一个
```

注意 58 的 `[^\]]+` 很宽——**任何**非 `]` 字符串都算合法 label。这个"宽"正是后面 parse 里需要额外判断的原因（见第 126 行）。

### 第 61 行：行内 marker 提取器

```python
_MARKER_RE = re.compile(r"\[\^([^\]]+)\]")
```

不带 `^...$` 锚——它不是用来匹配整行的，是用来在 markers 子串里**搜出所有** `[^xxx]` 的（配合 `findall` 用，见 156 行）。

---

## 第 64–69 行：Entry 数据类

```python
@dataclass
class Entry:
    id: str                                          # 66  "m_01ABC..."
    section: str                                     # 67  所属章节名
    text: str                                        # 68  事实正文
    refs: list[str] = field(default_factory=list)    # 69
```

**第 69 行是全文件最值得讲的"坑位教学"**：

为什么写 `field(default_factory=list)` 而不是 `refs: list[str] = []`？

Python 的默认值在**类定义时求值一次**，所有实例共享同一个对象。如果写成 `= []`，那么：

```python
a = Entry(id="1", section="s", text="t")
b = Entry(id="2", section="s", text="t")
a.refs.append("run:01X")   # b.refs 也变成了 ["run:01X"]！同一个列表！
```

`default_factory=list` 表示"每次新建实例时调用 list() 造一个新列表"。这是 Python 经典陷阱，你写 TS 时对应场景（class 字段默认 `[]`）没有这个问题——TS 里字段初始化器是每实例执行的。

---

## 第 72–102 行：Document 数据类

```python
@dataclass
class Document:
    title: str = ""
    sections: list[tuple[str, list[Entry]]] = field(default_factory=list)   # 75
```

第 75 行的类型值得停一下：章节存的是 `(名字, 条目列表)` **元组的有序列表**，不是 `dict[str, list[Entry]]`。

为什么？① 章节顺序即显示顺序，列表最直白；② 理论上允许同名章节共存（虽然不推荐）。代价是没有按名索引，查找都是线性扫——文档就几十条目，够用。**不要过度设计**是这个仓库一贯的风格。

### 第 77–78 行：all_entries

```python
def all_entries(self) -> list[Entry]:
    return [e for _, entries in self.sections for e in entries]
```

列表推导式的双层 for = Java Stream 的 `flatMap`：把所有章节的条目拍平成一个列表。`_` 是约定俗成的"我不用这个变量"（章节名）。

### 第 80–85 行：find

```python
def find(self, entry_id: str) -> Entry | None:
    for _, entries in self.sections:
        for entry in entries:
            if entry.id == entry_id:
                return entry
    return None
```

线性查找，找不到返回 `None`（≈ `Optional<Entry>`，调用方自己判空）。ops.py 里 edit/delete 前都用它确认目标存在。

### 第 87–94 行：section_entries —— get-or-create

```python
def section_entries(self, name: str) -> list[Entry]:
    for section, entries in self.sections:
        if section == name:
            return entries
    new_entries: list[Entry] = []
    self.sections.append((name, new_entries))
    return new_entries
```

语义：**取到就返回，取不到就创建并返回**。

关键细节：返回的是**活引用**（live list）。ops.py 的 apply 里 `doc.section_entries(op.section).append(...)` 直接往返回值上追加——不需要再 set 回去。这是 Python 可变对象的惯用法，Java 开发者要注意：这依赖"list 是引用语义"，改返回值就是改文档本体。

### 第 96–102 行：remove

```python
def remove(self, entry_id: str) -> bool:
    for _, entries in self.sections:
        for i, entry in enumerate(entries):
            if entry.id == entry_id:
                del entries[i]
                return True
    return False
```

- `enumerate(entries)`：同时给下标和元素（≈ 带 index 的 for）
- `del entries[i]`：按下标原地删除
- 返回 bool 告诉调用方删没删到——DeleteOp 校验阶段已确保存在，这里几乎必真，但保留诚实返回值

---

## 第 105–182 行：parse —— 两遍扫描

入口签名：

```python
def parse(md: str) -> Document:            # 105
    raw_lines = md.splitlines()            # 107  按 \n 或 \r\n 切行（跨平台安全）
```

设计：**Pass 1 收全部脚注定义，Pass 2 收标题/章节/条目**。为什么不一遍过？因为新格式 bullet 在**前面**，它引用的脚注编号定义在文件**末尾**——必须先把脚注表建好，遇到 bullet 才能立刻还原 refs。典型的"先建符号表再解析引用"，和编译器两遍扫描同理。

### Pass 1（第 109–129 行）：建两张脚注表

```python
refs_by_entry: dict[str, list[str]] = {}   # 112  旧格式：m_xxx → [多个ref]
ref_by_label: dict[str, str] = {}          # 113  新格式：整数label → 单个ref
for raw in raw_lines:
    line = raw.rstrip()                    # 115
    m_old_fn = _OLD_FOOTNOTE_RE.match(line)
    if m_old_fn:
        refs_raw = m_old_fn.group("refs")
        refs_by_entry[m_old_fn.group("id")] = [
            r.strip() for r in refs_raw.split(",") if r.strip()   # 120–121
        ]
        continue                                           # 122
    m_new_fn = _NEW_FOOTNOTE_RE.match(line)
    if m_new_fn:
        label = m_new_fn.group("label")
        if label.startswith("m_"):                         # 126
            continue
        ref_by_label[label] = m_new_fn.group("ref").strip()
```

三个细节：

1. **先试旧再试新，顺序不能反**（116 → 123）：58 行的新正则 label 是宽匹配 `[^\]]+`，`[^m_01ABC]: …` 这种旧行**也能被新正则匹配上**（label 会抓到 `m_01ABC`）。窄的、具体的规则必须先行，宽的兜底规则殿后——写多格式解析器的通用铁律。
2. **120–121**：`split(",")` 后逐项 strip 并丢弃空项——容忍 `[^m_x]: a,, b ,` 这种脏格式。
3. **126 行的防线**：既然旧格式已在上面被拦截并 continue，什么时候会走到这里且 label 以 `m_` 开头？——答案是**畸形旧数据**，比如手写了个 `[^m_short]: ref`（不满足 26 位，旧正则不认）。这时宁可丢掉也不让它混进 label 表污染新格式命名空间。防御性编程的样本。

### Pass 2（第 131–181 行）：组装 Document

```python
doc = Document()                                    # 132
current_entries: list[Entry] | None = None          # 133
current_section: str | None = None                  # 134
for raw in raw_lines:
    line = raw.rstrip()
```

133–134 的 `None` 初值有含义：**还没见到任何 `##` 章节头之前**，current 是 None。这实现了"章节外的 bullet 一律丢弃"——Markdown 文件开头若有游离 bullet，不属于任何章节，无法归档，只能忽略。

#### 标题分支（138–142）

```python
if not doc.title:                       # 只有还没标题时才认
    m_title = _TITLE_RE.match(line)
    if m_title:
        doc.title = m_title.group(1).strip()
        continue
```

`if not doc.title` 保证只认第一个 `#` 行；之后出现的 H1 直接跳过当普通文本（落到循环尾什么都不做）。

#### 章节分支（144–149）

```python
m_section = _SECTION_RE.match(line)
if m_section:
    current_section = m_section.group(1).strip()
    current_entries = []
    doc.sections.append((current_section, current_entries))
    continue
```

遇到 `##` 就**切换当前章节**：建一个空列表挂进 doc，后续 bullet 都进这个列表。注意这里 append 进去的就是那个活引用（同 87 行的模式）。

#### 新格式 bullet 分支（151–165）

```python
m_new_b = _NEW_BULLET_RE.match(line)
if m_new_b and current_entries is not None and current_section is not None:
    entry_id = m_new_b.group("id")                                # 154
    text = m_new_b.group("text").rstrip()                         # 155
    markers = _MARKER_RE.findall(m_new_b.group("markers") or "")  # 156
    entry_refs: list[str] = []
    for marker in markers:
        ref = ref_by_label.get(marker)                            # 159
        if ref is not None and ref not in entry_refs:
            entry_refs.append(ref)
    current_entries.append(
        Entry(id=entry_id, section=current_section, text=text, refs=entry_refs)
    )
    continue
```

- **156**：`group("markers")` 是形如 `"[^1], [^3]"` 的原始子串，再用 `_MARKER_RE.findall` 从中抠出 `["1", "3"]`。`or ""` 防 None（markers 组可为零长度）。`findall` 返回**所有捕获组的捕获内容组成的列表**。
- **159–161**：拿 marker 编号去 Pass 1 建的 `ref_by_label` 表换真实 ref。两个失败路径都被静默处理：
  - 编号查不到（bullet 引了 `[^7]` 但文末没定义 `[^7]`）→ 这个 ref 直接消失
  - 同一 ref 重复出现 → `not in entry_refs` 去重，保持首次出现顺序
- **153**：`current_entries is not None` 双保险——章节前的游离 bullet 到这里被拒之门外。

#### 旧格式 bullet 分支（167–179）

```python
m_old_b = _OLD_BULLET_RE.match(line)
if m_old_b and current_entries is not None and current_section is not None:
    entry_id = m_old_b.group("id")
    text = m_old_b.group("text").strip()
    current_entries.append(
        Entry(
            id=entry_id,
            section=current_section,
            text=text,
            refs=list(refs_by_entry.get(entry_id, [])),       # 177
        )
    )
    continue
return doc                                                    # 181
```

- **177**：`dict.get(key, 默认值)` ≈ Java 的 `getOrDefault`。旧格式的 refs 在 Pass 1 已经按 entry id 归好档，这里直接领。`list(...)` 包一层是**拷贝**——防止多个条目共享同一列表对象（又是可变别名问题）。
- 最后返回装配好的 Document。

**parse 的容错哲学总结**：坏行（不匹配任何模式）→ 静默跳过；断链（marker 无定义）→ 静默丢 ref；游离 bullet → 静默丢弃。**永远尽力而为，绝不抛异常**——因为文档可能被学生手动编辑过，解析崩了比少几条数据糟糕得多。

---

## 第 185–232 行：serialize —— 反向渲染

### 第一步：分配整数标签（193–200）

```python
ref_order: list[str] = []
ref_to_label: dict[str, int] = {}
for entry in doc.all_entries():
    for ref in entry.refs:
        if ref in ref_to_label:
            continue
        ref_to_label[ref] = len(ref_order) + 1
        ref_order.append(ref)
```

遍历顺序 = 条目在文档中的顺序 × 条目内 refs 的顺序 → **首次出现的 ref 拿 1 号，第二个新 ref 拿 2 号**……这就是 docstring 说的"in first-appearance order"。

效果：两条 bullet 都引 `chat:01A` 时共用 `[^1]`，脚注区只出现一行。这是"整数标签"设计的核心收益。

`len(ref_order) + 1` 和 `append` 成对出现——其实 `ref_order` 存的就是"按编号排好的 refs"，最后输出脚注区直接用它。

### 第二步：拼行（203–220）

```python
lines: list[str] = []
if doc.title:
    lines.append(f"# {doc.title}")
    lines.append("")
```

204：无标题就不输出 `#` 行——序列化适应文档的实际状态，不硬凑格式。

```python
for section, entries in doc.sections:
    if not entries:                      # 209  空章节整个跳过
        continue
    lines.append(f"## {section}")
    lines.append("")
    for entry in entries:
        # 214：把该条目的每个 ref 换成 "[^n]"，逗号+空格连接
        markers = ", ".join(f"[^{ref_to_label[r]}]" for r in entry.refs if r in ref_to_label)
        text = entry.text.rstrip()
        if markers:
            lines.append(f"- {text} {markers} <!--{entry.id}-->")
        else:
            lines.append(f"- {text} <!--{entry.id}-->")
    lines.append("")
```

- **214**：生成器推导式喂给 `join`（≈ stream().map().collect(joining())）。`if r in ref_to_label` 是防御：万一有条目的 ref 没拿到编号（正常流程不可能），静默略过而不是 KeyError 崩掉。
- 逗号分隔的用意在 217 注释上一行写着：渲染成上标时显示 `¹, ³` 而不是粘成一坨 `¹³`。
- **锚点无条件回写**：不管有没有 refs，`<!--{entry.id}-->` 必须出现在行尾——这是下次 parse 能找回这条的唯一凭据。

### 第三步：脚注区（225–230）

```python
if ref_order:
    lines.append("---")
    lines.append("")
    for i, ref in enumerate(ref_order, start=1):      # start=1：编号从 1 开始
        lines.append(f"[^{i}]: {ref}")
    lines.append("")
```

`enumerate(x, start=1)` 给出 (1, 第0个), (2, 第1个)……正好和第一步的编号分配一致（`len(ref_order)+1` 从 1 数起）。**两处数数逻辑的一致性就是这个文件正确性的命门**。

### 收尾（232）

```python
return "\n".join(lines).rstrip() + "\n"
```

拼接 → 去掉多余尾部空白 → 补一个标准换行。保证文件末尾恰好一个 `\n`（POSIX 文本文件惯例，diff 友好）。

---

## 幂等性验证：为什么说 round-trip 不变形

拿 §4 指南里那份示例文档走一遍 `serialize(parse(x))`：

1. parse 还原出 title、sections、每条 Entry 的 id/text/refs
2. serialize 重新分配标签——但遍历顺序和原文一致，所以分配结果**必然相同**
3. 输出的每一行由 Entry 字段重新拼装，格式规范化（多余空格被清掉）

严格说 `==` 成立的前提是输入本来就是 serialize 的产物（或等价规范形）；手写的歪格式会被**规范化**（比如 `[^1],[^2]` 变成 `[^1], [^2]`）。这正是想要的效果：**任何来源的文档，过一遍管道后就收敛到标准形**。

---

## 已知简化/边界情况（面试级追问点）

| 情况 | 行为 |
|---|---|
| 手动删掉某行的 `<!--m_xxx-->` | 该行不再被识别为条目 → 数据等于丢失（§指南自测 2 的答案） |
| 同名章节出现两次 | parse 会产出两个同名 section；`section_entries` 只返回第一个 → 后续追加全进第一个，第二个成为孤儿 |
| bullet 引用了未定义的脚注编号 | 该 ref 静默消失 |
| 章节外的 bullet | 丢弃 |
| `text` 里本身含有 `<!--...-->` | 新正则要求锚点在**行尾**，正文中间的 HTML 注释不影响匹配，会留在 text 里 |

这些都不是 bug，是"文档可能被人手改"前提下有意选择的宽容策略——**宁可静默降级，不可崩溃**。

---

## 移植到 TS 的备忘清单

- [ ] `Entry` / `Document` → interface + 工厂函数；`default_factory` 陷阱不存在，但要小心 JS 对象共享引用（同样别让默认数组跨实例共享）
- [ ] 五个正则原样照搬（JS 正则语法兼容这一套，注意 Python 的 `(?P<name>)` 在 JS 里写作 `(?<name>)`）
- [ ] `splitlines()` → `md.split(/\r?\n/)`
- [ ] `del list[i]` → `entries.splice(i, 1)`
- [ ] `dict.get(k, default)` → `map.get(k) ?? default`
- [ ] `"\n".join(lines)` → `lines.join("\n")`
- [ ] vitest 用例至少覆盖：新格式往返幂等、旧格式解析+迁移、marker 无定义、游离 bullet、空章节
