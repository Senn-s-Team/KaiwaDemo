# 系统边界说明

> 文档性质：当前实现的工程边界说明。
>
> 权威范围：当前 `worker/`、`shared/`、`src/lib/`、部署配置与相关测试能够证明的跨模块边界、数据所有权、路由职责和失败边界。
>
> 非权威范围：产品愿景、未来架构、模型效果、未实现接口、未由当前代码或 Schema 证明的性能/可用性承诺。
>
> 相关文档：[产品契约](./product-contract.md) · [人工验收模板](./user-test-template.md)
>
> [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

## 1. 事实来源与阅读规则

- `worker/index.ts` 是当前 HTTP API 路由分派事实源；`worker/entry.ts` 只负责 Wrangler runtime 入口及 Workflow 导出。
- `shared/` 中的 Zod schema 是浏览器与 Worker 之间 wire contract 的唯一来源。本文不复制字段全集；字段变化应回到对应 Schema 核对。
- `worker/validation.ts` 负责 Worker 入站及模型出站校验；`src/lib/api.ts` 负责浏览器响应解析，并复用 `shared/` Schema。
- `worker/constants.ts` 记录当前请求大小、回合数、字符数、输出预算、超时及模型默认值；本文只引用边界含义，不把默认值解释为产品档位。
- 下文的“当前”表示代码、配置或测试可直接证明的状态，不表示历史文档中的设计意图。

## 2. 拓扑与运行时分层

```text
┌──────────────────────── Browser ────────────────────────┐
│ React UI / src/lib                                      │
│  ├─ fetch API + shared Schema parsing                   │
│  ├─ sessionStorage: 当前会话/首页复练准备               │
│  ├─ localStorage: 草稿任务/完成复盘 durable recovery    │
│  ├─ IndexedDB: 本机练习历史                             │
│  └─ ElevenLabs client: STT/TTS 媒体连接                 │
└───────────────┬─────────────────────────────────────────┘
                │ same-origin /api/*
                ▼
┌──────────────── Cloudflare Worker ──────────────────────┐
│ worker/index.ts: HTTP 边界、路由、入站校验、签名校验    │
│  ├─ OpenAI-compatible gateway: 回复、提示、反馈等       │
│  ├─ api.elevenlabs.io: 临时 STT/TTS token 代理          │
│  └─ Workflow bindings                                   │
│       ├─ SCENARIO_DRAFT → ScenarioDraftWorkflow         │
│       └─ FEEDBACK_TASK   → FeedbackWorkflow              │
└──────────────────────┬──────────────────────────────────┘
                       │ durable task payload/status
                       ▼
             Cloudflare Workflow runtime
             单步执行；当前配置不自动重试
```

- 浏览器通过同源 `/api/*` 与 Worker 通信；`wrangler.jsonc` 将 `/api/*` 配置为先运行 Worker，其他静态资源走 SPA fallback。
- 浏览器不会把 OpenAI 或 ElevenLabs 的服务端密钥发给上游。ElevenLabs 媒体连接使用 Worker 签发的临时 token；模型请求由 Worker 代发。
- 场景草拟和反馈/重做是 Worker 创建并查询的 Cloudflare Workflow durable task；普通会话回复、提示、听力支架、语音辅助和场景润色在 API 请求内完成。
- Workflow 的 runtime-only 类只在 `worker/entry.ts` 导出；`scenario-draft-execute.ts` 与 `feedback-task-execute.ts` 是 Workflow 和 Node 测试共用的执行 seam。

## 3. Worker API 路由职责

路由表以 `worker/index.ts` 为准。除 `/api/config` 外，Worker 先执行同源校验；所有 JSON 请求受 `LIMITS.requestBytes` 限制，并经过对应解析器或 shared Schema。

| 路由 | 方法 | 当前职责 | 主要凭据/上游 |
|---|---|---|---|
| `/api/config` | GET | 返回运行模式、最大回合数、ElevenLabs STT/TTS 可用性及模型配置可见信息 | 无用户 token；读取 Worker env |
| `/api/elevenlabs/token` | POST | 为 `realtime_scribe` 或 `tts_websocket` 向 ElevenLabs 请求一次性临时 token | Worker `ELEVENLABS_API_KEY`；上游 ElevenLabs |
| `/api/scenario/draft` | POST | 校验 `ScenarioDraftTaskRequest`，按请求摘要建立/复用场景草拟 Workflow，返回 task capability | `SCENARIO_DRAFT`；`scenario_draft` capability |
| `/api/scenario/draft` | GET | 验证 task capability，查询场景草拟 Workflow，返回 pending/complete/failed | `Authorization: Bearer <taskToken>` |
| `/api/practice/restart` | POST | 验证 practice token，重新签发短期 scenario token，返回可开始的场景数据 | `practice` token → `scenario` token |
| `/api/session/start` | POST | 验证 scenario token，创建动态 session id，签发 session token，并返回场景首句及回合上限 | `scenario` token → `session` token |
| `/api/respond` | POST | 校验动态会话回复请求，向 OpenAI-compatible endpoint 请求流式相手回复 | session token；NDJSON response |
| `/api/hint` | POST | 生成表达提示 | session token；OpenAI-compatible endpoint 或受控 mock |
| `/api/listening-scaffold` | POST | 生成四级听力支架响应 | session token；`shared/listening-scaffold.ts` |
| `/api/feedback/tasks` | POST | 校验 conversation/redo 任务，验证 session 与场景首句，创建/复用反馈 Workflow | `FEEDBACK_TASK`；`feedback_task` capability |
| `/api/feedback/tasks` | GET | 验证 task capability，查询反馈/重做 Workflow 状态并校验结果 | `Authorization: Bearer <taskToken>` |
| `/api/speech/assist` | POST | 在已观察转写和停顿条件下生成续说辅助 | session token；`shared/speech-assist.ts` |
| `/api/scenario/polish` | POST | 对中文场景设置做受限保真润色 | `shared/scenario-polish.ts`；模型或受控 mock |

- 未匹配的 `/api/*` 返回 `404 not_found`；不在本文加入未实现的救援或旁路路由。
- 方法不匹配返回 `405`；请求体、入站字段、token 和模型结果错误分别由 HTTP 边界、校验器、token 层和模型编排层归一化。
- `/api/respond` 的浏览器客户端要求 NDJSON 流，必须看到 `done` 事件才算完成；空流、不完整流或 error 事件属于 API 失败。
- `/api/scenario/draft` 与 `/api/feedback/tasks` 的 POST 返回 `202` 接受任务；GET 的终态由 shared task status Schema 约束。

## 4. 数据所有权与浏览器存储

### 4.1 `sessionStorage`：当前页面会话恢复

- `src/lib/session-snapshot.ts` 的 `kaiwa.current-session.v1` 由 `use-session-snapshot-persistence.ts` 写入。
- 所有者是浏览器端当前会话生命周期；内容是可恢复的会话阶段、session id、场景、消息、回合、当前回合、回合号、开始时间和转写文本。
- 活动会话且已开始时更新；读取期间不写入；无活动会话或会话结束时清理。存储不可用时会话仍可继续。
- `src/lib/home-practice-recovery.ts` 的 `kaiwa.home-practice-restart.v1` 也属于 `sessionStorage`，只保存首页同场景复练准备数据，按严格形状读取、写入和清理。
- 这些快照不拥有麦克风流、音频播放、网络请求或 Worker 状态；媒体资源由音频/会话控制器管理。

### 4.2 `localStorage`：跨页面 durable recovery

- `src/lib/scenario-draft-task.ts` 的 `kaiwa.scenario-draft-task.v1` 保存版本化场景草稿请求及可选 task token。
- 场景草稿恢复器在页面可见、在线且非活动会话条件下轮询；页面隐藏、离线、进入活动会话或组件卸载时停止观察并中止请求。请求创建时间超过 `SCENARIO_DRAFT_TASK_TTL_MS` 时删除并报告过期。
- `src/lib/feedback-task-recovery.ts` 的 `kaiwa.completed-review.v1` 保存完成复盘上下文、报告、反馈、重做记录和按任务种类分组的待处理任务；其中任务可包含 task token、状态、错误和结果。
- 完成复盘恢复器同样只在前台在线时观察，并按 session id/request id 防止迟到响应覆盖新状态；恢复记录或任务超过 `FEEDBACK_TASK_TTL_MS` 时清理。
- `localStorage` 只由上述 recovery 模块拥有。不可用时页面可继续当前操作，但离开页面后无法保证恢复。

### 4.3 IndexedDB：本机练习历史

- `src/lib/practice-history.ts` 拥有数据库 `kaiwa-practice-history`、对象仓 `attempts` 及 `scenarioKey` 索引。
- 主键是 `report.sessionId`；记录包含场景、练习 token、报告和反馈，并按场景稳定键支持列出与按场景删除。
- 这是跨页面/跨会话的本机历史边界，不是 Worker 数据库，也不保存 session token 或 STT/TTS 临时访问 token。保存函数显式挑选字段；调用方附带的临时令牌不会被隐式持久化。
- IndexedDB 不可用、被阻塞或事务失败时，历史保存/读取以错误结束；本文不把浏览器历史推断为云端备份。

### 4.4 Workflow 数据：服务端任务状态

- 场景草拟任务由 `SCENARIO_DRAFT` 拥有，反馈/重做任务由 `FEEDBACK_TASK` 拥有。浏览器只拥有请求封套和 capability token，不拥有 Workflow 内部状态。
- task id 是完整请求 JSON 的 SHA-256 摘要；提交失败时路由尝试按同一 id 查询已有任务，形成请求级幂等边界。
- 两类任务的 shared Schema 都定义 24 小时请求有效窗口；创建时配置成功/错误结果保留 1 天。代码不证明更长的服务端保留或跨部署恢复能力。
- `ScenarioDraftWorkflow` 和 `FeedbackWorkflow` 都只执行一个 `step.do`，当前 `retries.limit` 为 `0`；失败由执行 seam 映射为失败状态，不在 Workflow 层自动重试。
- Workflow 结果必须再次通过 `ScenarioDraftModelResultSchema` 或 `FeedbackTaskStatusSchema` 等 Schema 校验；无效结果不能被当作成功数据交给浏览器。

## 5. Token 类型与生命周期

所有应用 token 由 `worker/tokens.ts` 以 HMAC-SHA-256 签名。签名密钥优先使用 `SCENARIO_SIGNING_SECRET`，否则使用 `OPENAI_API_KEY`；非 mock 部署缺少二者时签发/验签失败。

- **scenario token**：包含动态场景及 `issuedAt`/`expiresAt`，由场景草拟结果或练习重启签发；默认有效期为 `LIMITS.scenarioTokenTtlMs`（当前代码为 2 小时）。`/api/session/start` 消费并验证它。
- **session token**：包含场景、`startedAt`、`expiresAt`，由 `/api/session/start` 签发；默认有效期为 `LIMITS.sessionTokenTtlMs`（当前代码为 1 小时）。回复、提示、听力支架、语音辅助及反馈提交使用它。
- **practice token**：包含带版本化 evidence points 的场景和签发时间；用于本机复练入口。验签时不按 `expiresAt` 检查，但它只在具有评价证据的场景上签发；重新开始时换发新的短期 scenario token。
- **scenario_draft capability**：只引用场景草拟 task id 和任务请求过期时间，供草拟 GET 查询；不是场景或会话凭据。
- **feedback_task capability**：只引用反馈 task id 和任务请求过期时间，供反馈 GET 查询；不是 session token。
- token 具有 kind 与 schema version，端点会拒绝格式错误、签名错误、类型不匹配、版本不支持、声明非法或已过期的 token。持久化边界按封套区分：场景草稿 `taskToken` 写入 `localStorage`；完成复盘的待处理 `feedback_task` 也可写入 `localStorage`；`SessionScenario` 中的 `sessionToken`、`scenarioToken`（及可选 `practiceToken`）会随当前会话快照进入 `sessionStorage`。这些 token 并非都只存在内存。
- ElevenLabs token 是另一类供应商临时凭据：Worker 从上游获取后返回 `expiresInSeconds: 900`；浏览器 `SttTokenManager` 仅以内存缓存管理，默认本地 token lifetime 为 800 秒，并在使用后消费或 reset。它不进入 sessionStorage、localStorage 或 IndexedDB 历史。

## 6. STT、TTS 与模型失败边界

### STT/TTS

- Worker 只代理 ElevenLabs 单次 token 请求；`ELEVENLABS_API_KEY` 缺失时返回未配置错误，供应商权限、额度、条款、鉴权和其他上游失败由 `worker/elevenlabs.ts` 映射为稳定错误。
- STT 实时连接、麦克风采集、最终/部分转写合并和取消释放由浏览器 `src/lib/stt.ts` 与 `audio-engine.ts` 所有；Worker 不接收原始音频。发送给模型的是用户确认的转写文本。
- TTS 播放、分块、缓存、暂停/继续、从头停止和手势解锁由 `src/lib/tts.ts` 所有。TTS token 或音频播放失败不会自动变成对转写或会话数据的成功声明；控制器可按现有状态降级或报错。
- `worker/constants.ts` 及 `/api/config` 只说明当前配置可用性；ElevenLabs token 成功不等于浏览器麦克风权限、实时连接或播放设备一定可用。

### OpenAI-compatible 模型

- `worker/openai.ts` 通过 HTTPS 的 `OPENAI_BASE_URL` 访问 OpenAI Responses 或兼容 Chat Completions 路径；无配置时默认 OpenAI 官方地址。配置必须是绝对 HTTPS URL，不能带凭据、查询或 fragment。
- 模型输出先由 `worker/validation.ts` 和相应 shared/领域 Schema 解析；缺字段、越界、证据引用不完整、听力短语不满足原文约束等均是失败，不作为部分成功输出。
- 普通交互受请求/字符/输出预算和 deadline 限制；Workflow 执行分别使用模型 deadline 与 step deadline。本文不把这些代码限额扩展为供应商 SLA。
- `ALLOW_MOCK=true` 时，`worker/mock.ts` 为无外部模型的受控回退；`/api/config` 会把完整密钥配置报告为 `real`，仅允许 mock 时报告为 `mock`，配置不完整且不允许 mock 时报告为 `partial`。mock 不是外部服务可用性的证明。
- 模型、解析、超时或上游网络失败会落入对应 API/Workflow 失败状态；当前代码不证明自动重试，除客户端 recovery 对传输失败的再次观察/重投外，不应推断存在隐藏重试。

## 7. 部署必要绑定与配置

`wrangler.jsonc` 当前声明：

- Worker 主入口为 `./worker/entry.ts`；静态 assets 使用 SPA `not_found_handling`，`/api/*` 配置 `run_worker_first`。
- 必需的 Workflow binding 是 `SCENARIO_DRAFT`（`ScenarioDraftWorkflow`）和 `FEEDBACK_TASK`（`FeedbackWorkflow`）。缺少对应 binding 时，任务提交/查询返回 Workflow 未配置或不可用错误。
- 运行变量包括 OpenAI base URL/model、ElevenLabs STT/TTS model/voice id，以及 `ALLOW_MOCK`。真正调用还需要 `OPENAI_API_KEY`、`ELEVENLABS_API_KEY` 和签名密钥配置；`ELEVENLABS_VOICE_ID` 是 TTS 可用性的必要条件。
- `SCENARIO_SIGNING_SECRET` 未设置时，代码会把 `OPENAI_API_KEY` 作为签名密钥回退；生产部署应把签名密钥作为明确的 Worker Secret 管理，而不是把 API key 暴露给浏览器。
- `ALLOW_MOCK` 当前配置为 `false`。本文不宣称某个未在配置或代码中出现的模型档位、供应商或 Durable Object 绑定存在。

## 8. 隐私与不持久化边界

- 浏览器向 Worker 提交的是转写文本、会话消息、场景及任务请求；STT 原始音频由浏览器媒体管线直接提供给 ElevenLabs 实时客户端，不由本 Worker 持久化。
- token 的本地持久化由恢复封套决定：草稿/反馈 task capability 可随 `localStorage` 中的任务记录恢复；当前会话的 `sessionToken`、`scenarioToken` 和可选 `practiceToken` 可随 `sessionStorage` 快照保存。`IndexedDB` 练习历史明确不保存 `sessionToken` 或 STT/TTS 临时 token，但会保存 `practiceToken` 这一练习凭据字段。
- 当前会话快照和复盘恢复记录属于浏览器本地存储，可能包含对话文本、场景、报告、反馈及上述恢复所需凭据；它们不是服务端账户数据，也不构成跨设备同步。本文不承诺浏览器、供应商或平台日志的保留策略。
- Workflow 在任务生命周期内持有请求参数与执行结果；当前配置只证明 1 天结果保留，不证明永久删除时间、跨区域位置或供应商侧数据策略。
- 任何“发音、口音、原音或情绪”评价都不应从当前数据边界推导：Worker 的全局安全约束明确把输入定义为用户确认的 STT 文本，而不是原始音频。

## 9. 边界变更检查

修改路由、存储键、token 声明、Workflow binding、外部供应商、shared Schema 或配置时，至少回查：

1. `worker/index.ts` 与 `src/lib/api.ts` 的路由和方法是否仍一一对应。
2. `shared/` Schema、Worker 校验器及浏览器解析是否仍共享同一 wire contract。
3. sessionStorage、localStorage、IndexedDB 与 Workflow 的所有权是否仍互不混淆。
4. token 签发、验签、过期和恢复器内的 task 生命周期是否同步。
5. `wrangler.jsonc` 的 binding、变量和 `/api/*` Worker 优先规则是否仍满足运行时入口。
6. 同时更新本文头部协议，并检查 `docs/AGENTS.md`。
