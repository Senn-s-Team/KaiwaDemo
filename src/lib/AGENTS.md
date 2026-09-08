# src/lib/
> L2 | 父级: /AGENTS.md
成员清单
session.ts: 会话生命周期、固定五回合推进与显式中断恢复状态机，集中定义 idle/interrupted/retrying/recovered/failed 转换、恢复目标、可操作入口与执行裁决
stt.ts: 实时语音识别会话与流水线管理，支持按会话选择识别语言，取消时释放共享麦克风，并以 selectFinalSttText 在远端最终提交关闭或超时时保全已观察转写
tts.ts: 语音合成与播放管理，含手势解锁状态缓存、文本分块生成、原位置暂停继续与从头停止，CachedTtsPlayer / parseTtsMessage
audio-engine.ts: 基础音频处理管线与流复用管理，包含麦克风采样、重采样、环形缓冲、当前麦克风权限预检、硬件流安全释放与前后台 teardown 裁决 shouldTeardownOnVisibility / isPermissionRequesting
recording-setup.ts: 录音准备与并发协调深模块，隐藏麦克风与 Token 并发获取、连接就绪判定与失败回收，允许主动取消方避免二次释放新流，coordinateRecordingSetup
voice-turn-controller.ts: 用户语音回合核心控制器深模块，以代际所有权锁隔离 dispose/retry 与迟到 finally，录音前释放相手播放资源，聚合麦克风权限状态、转写流与草稿、空语音/静音防护拦截、文本输入回退与单轮资源生命周期闭环，useVoiceTurnController / voiceTurnReducer / parseFinalTranscript / createRecordingStartLock
ai-turn-controller.ts: 相手 AI 回合控制器深模块，闭环拥有 LLM 流式应答、TTS 播放/暂停/继续/降级及录音前资源释放、五回合自然判定与回合流转，useAiTurnController / createAiTurnRuntime / aiTurnReducer
audio-feedback.ts: 麦克风电平与录音时长计算，以及基于可用计量的静音保全提示纯规则
microphone.ts: 麦克风权限预检、静默 Permissions.query 状态探测 queryMicrophonePermission 与状态缓存
speech-assist.ts: 实时续说辅助触发规则与显示守卫
metrics.ts: 从回合、失败/重试与 speechAssistEvents 聚合 RoundRecord / SessionReport，构建 completion、recovery 与 speechAssistUsed 事实
text-cleaner.ts: 转写文本清洗与规整化
scenario-draft-task.ts: 首页场景草稿的持久化请求封套、前台恢复、幂等提交与 task 状态轮询控制器，隔离 transport 与终态生成错误
feedback-task-recovery.ts: 完成复盘页与反馈/重做任务的 durable local recovery，集中 start/resume、幂等重投、前台轮询、HTTP 终态映射及按 sessionId/requestId 隔离
session-snapshot.ts: 当前会话 sessionStorage 快照的严格校验、读取、清理与已提交用户消息回滚辅助函数
use-listening-scaffold-controller.ts: 会话内听力支架等级、请求状态、缓存、重听与渐进显示控制器，通过注入的消息/回合 store 与播放动作保持所有权隔离
use-speech-assist-controller.ts: 录音续说辅助的请求时机、超时、失败分类、事件写回、可见结果与中止控制器
use-completed-practice.ts: 完成复盘的 durable feedback/redo 恢复、报告、复练比较、任务启动/重试与复制协调，复用 feedback recovery 唯一轮询
use-home-practice.ts: 首页草稿恢复、场景准备、本机练习历史、复练、删除与串行持久化协调，复用 scenario draft recovery 唯一轮询
home-practice-recovery.ts: 首页同场景复练准备数据的严格 sessionStorage 校验、恢复、写入与清理边界
use-session-snapshot-persistence.ts: 当前会话 sessionStorage 快照写入与清理 lifecycle
use-session-lifecycle.ts: 在线、离线、可见性与 pagehide 的会话中断、媒体释放和恢复状态监听
spark-practice.ts: 首页三个可编辑场景例子的抽取、换组避重与动态场景请求描述生成
home-stt.ts: 首页中文 STT 的纯生命周期规则，基于录音前草稿合并实时与最终转写，裁决迟到结果、离页/取消、准备与澄清冲突，以及不覆盖既有文字的 300 字合并边界
api.ts: 前端 API 通信层，提供场景语音描述保真润色、可恢复场景草稿、原场景复练，验证动态会话、版本化证据反馈与听力支架响应，并直接复用 shared/ 下对应的唯一 wire schema 与推导类型

practice-history.ts: 当前浏览器 IndexedDB 练习历史、完整场景分组与关联删除，不保存临时访问令牌
practice-progress.ts: 基于有效引用与帮助事实的场景表现汇总、同标准首次完整练习比较

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
