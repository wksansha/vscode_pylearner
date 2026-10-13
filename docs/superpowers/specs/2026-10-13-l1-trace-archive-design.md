# L1 Trace 全量归档设计

- 日期：2026-10-13
- 状态：已批准
- 涉及仓库：vscode-pylearner（客户端）、classroom-assistant（服务端）

## 1. 背景与目标

L1 trace 目前只上报 diag/run 两类事件到教师服务器（分析链路），edit/chat/debug 等其余事件仅存本地。学生今天用这台电脑、明天换一台，本地数据散落多机且无法归集；麒麟内网机上 globalStorage 目录很深也难以查找。

目标：

1. L1 全量事件（6 个 surface）按学号归档到服务器，学生换机后数据自动汇聚，不乱不丢
2. 归档通道与现有分析上报通道（`/api/events`）完全解耦，纯归档备份用途，不入库
3. 内网断网不丢数据，恢复后自动补传
4. 服务器压力最小化：不做高频推送

非目标：

- 不修改现有分析链路（TeacherReporter / events 表 / dashboard 聚合）
- 不同步 L2/L3 学习者画像与聊天会话文件（本次范围外）
- 不做本地数据清理（归档后本地 JSONL 保留，一学期量级几十 MB）

## 2. 总体架构

两条独立链路：

```
                       ┌─ 现有（不动）→ POST /api/events ──────→ SQLite events 表 → dashboard 分析
L1Writer.append ───────┤
                       └─ 新增（归档）→ TraceArchiver ────────→ POST /api/trace/archive → 服务器文件系统
```

关键决策：Archiver **不接收内存中的事件对象，而是定时读本地 JSONL 文件 + 位点**。本地 JSONL 是唯一事实源，天然构成补传队列——断网、崩溃、换机（重装后）都能续传。L1Writer 零改动。

## 3. 通信协议

### 请求

`POST /api/trace/archive`

```json
{
  "student_id": "2024001",
  "student_name": "张三",
  "class_id": "default",
  "surface": "edit",
  "date": "2026-10-13",
  "events": [
    { "id": "edit:01KZW...", "ts": "2026-10-13T06:31:14.754Z", "surface": "edit", "kind": "code_change", "payload": {} }
  ]
}
```

### 响应

`200 { "ok": true, "accepted": 42, "duplicated": 3 }`

- `accepted`：本次新落盘的事件数
- `duplicated`：按 id 判重后跳过的事件数

### 校验规则

- `student_id`、`events` 非空；`student_id` 仅允许 `[A-Za-z0-9_-]`（防路径穿越），否则 400
- `surface` 限定已知 6 值（edit/run/chat/debug/diag/behavior），否则 400
- `class_id` 缺省 `default`
- 宽松度与现有 `/api/events` 一致，不做名册校验

### 服务器存储结构

```
<TRACE_DIR>/trace/<classId>/<studentId>/<surface>/<YYYY-MM-DD>.jsonl
```

默认 `TRACE_DIR` 为 server 包下 `data/`（与 `assistant.db` 同级），环境变量 `TRACE_DIR` 可覆盖（与 `DB_PATH` 环境变量同款约定）。

### 幂等合并

服务器读现有归档文件 → 按事件 `id`（ulid，全局唯一）建集合 → 只追加不存在的行 → 写回。学生多台电脑同一天写同名文件、客户端重传已归档数据，均不产生重复。

### 并发控制

per-file 写锁（`Map<path, Promise>` 链式串行化），防并发请求读写交错，与客户端 L1Writer 的锁模式同思路。

### 批次上限

客户端单批 ≤ 200 事件或 ≤ 512KB；服务端 `express.json({ limit: "2mb" })` 已满足。

## 4. 客户端设计（vscode-pylearner，新增 `src/archive/`）

| 文件 | 职责 |
|---|---|
| `archiveState.ts` | 位点读写（纯函数）。`trace/archive-state.json` 记录 `{"edit/2026-10-13.jsonl": 12345}`——相对 trace/ 的路径 → 已归档字节数 |
| `batcher.ts` | 扫描 `trace/<surface>/*.jsonl`，对比位点，读出未归档段，解析 JSONL，切批（≤200 事件或 ≤512KB） |
| `archiver.ts` | 调度器：触发编排 + fetch 上传 + 位点推进；定时器纳入 `context.subscriptions` |

### 触发时机（不做高频推送）

| 触发 | 时机 | 说明 |
|---|---|---|
| 启动补传 | 激活后延迟 10s，扫描一次 | 换机/补传的主路径 |
| 定时归档 | 每 60 分钟 | 一节课归档约 1 次，服务器压力可忽略（40 人机房 ≈ 每分钟 1 个请求） |

无事件驱动触发。归档频率只影响服务器数据的新鲜度，不影响数据完整性——本地 JSONL 持久存在，机器中途崩溃后下次开机启动补传自动补齐。

### 扫描与位点规则

- 扫描对象：`trace/<surface>/*.jsonl` 全部 6 个 surface
- 位点无记录 → 从 0 归档；有记录 → 从 offset 起归档
- 本地文件比位点小（异常，理论只追加）→ 位点重置 0 全量重传，服务器按 id 去重，安全
- 位点文件直接覆写（体积小；损坏顶多重传，服务器幂等，无需原子 rename）

### 位点推进规则

- 批次 2xx → 立即推进位点
- 网络错误 / 5xx → 位点不动，下轮重试
- 400 → 位点直接跳到文件尾（数据本身有问题，重试无意义），记 warning 日志
- 单文件多批：位点按批推进（每批 2xx 后推进该批字节数）；某批失败则停止该文件的推送，已成功的批次推进保留，下轮从失败处续传

### 身份与配置门控

- 未设学号/姓名：不归档，本地照记（与现有 TeacherReporter 门控一致）
- 复用 `pylearner.teacher.url` + `pylearner.teacher.enabled` 配置，不新增配置项（归档和分析同一服务器、同一开关）
- 学号中途变更：新数据归到新学号目录，旧数据留在原处（与现有分析链路行为一致，不特殊处理）

### 运维入口

新增命令 `Python Learner: 打开数据文件夹`（`pylearner.openDataFolder`）：revealInExplorer 定位到 globalStorage，供教师/运维查看本地数据，缓解麒麟目录深不好找的问题。

## 5. 服务端设计（classroom-assistant）

- 新文件 `packages/server/src/routes/traceArchive.ts`，以现有 `registerXxxRoutes(app, deps)` 模式在 `index.ts` 注册
- 接口依赖注入：`{ traceDir }`（默认 `path.join(process.cwd(), "data")` 下 `trace/`，`TRACE_DIR` 覆盖），便于测试传临时目录
- 复用 `logEvent` 打结构化日志（`archive.batch_received` / `archive.batch_rejected` 等）
- 零 DB 改动，events 表 / aggregator / dashboard 完全不碰

## 6. 错误处理汇总

| 场景 | 行为 |
|---|---|
| 内网断网 | 静默重试（console.warn + outputChannel），不弹 UI；恢复后下轮自动补传 |
| 学生未设身份 | 不归档，本地照记 |
| 本地文件读取失败 | 跳过该文件，下轮再试 |
| 批次 400 | 位点跳文件尾 + warning（重试无意义） |
| deactivate | 定时器随 subscriptions 清理；不做退出 flush（位点机制保证下次开机补传） |
| 本地数据 | 归档后不删除，无清理机制 |

## 7. 测试策略

客户端（vitest + 现有 vscode-mock 模式）：

- archiveState：位点读写、文件缩小重置、路径 key 归一
- batcher：扫描 diff（新文件/增量/无新增）、JSONL 解析容错（坏行跳过）、批次切分边界（事件数上限/字节上限）
- archiver：2xx 推进 / 5xx 重试 / 400 跳尾 / 网络异常 / 身份门控 / 定时器生命周期（dispose）

服务端（vitest，沿用 `__tests__/` 集成测试风格）：

- 合并幂等：同 id 重传不重复、乱序到达可合并、`accepted`/`duplicated` 计数正确
- 目录组织：classId/studentId/surface/date 落位正确
- 安全：studentId 含 `../`、非法字符 → 400
- 并发写锁：交错请求不丢行
- 校验：缺 student_id / 空 events / 非法 surface → 400
