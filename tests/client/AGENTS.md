# tests/client/
> L2 | 父级: /AGENTS.md
成员清单
ai-turn-controller.test.ts: 相手 AI 回合状态机、运行时代际隔离与播放降级契约
audio-engine.test.ts: 音频引擎采样、编码与资源释放纯逻辑契约
audio-feedback.test.ts: 录音计时、音量反馈与静音保全提示阈值契约
audio-lifecycle.test.ts: 浏览器当前音频权限预检、共享麦克风流、TTS 与 Token 生命周期集成契约
app-lifecycle.test.ts: 真实 App 挂载下录音前相手播放器释放、草稿/前后台生命周期、后台中断后的真实重试与音频解锁时序、无同意决策的匿名遥测 checkpoint seam 以及提前退出原因与遥测凭据不进入会话恢复序列的回归契约
elevenlabs-guard.test.ts: ElevenLabs 浏览器入口构建守卫契约
feedback-data.test.ts: 会话反馈数据转换与展示输入契约
feedback-task-recovery.test.ts: 完成复盘封套持久化、前后台与刷新恢复、任务过期及迟到结果隔离契约
metrics.test.ts: 会话轮次指标与报告生成契约
recording-setup.test.ts: 录音准备并发协调、取消与失败回收契约
session-flow.test.ts: 客户端会话核心推进流程契约
session-recovery.test.ts: 前后台与离线中断恢复目标及入口契约
spark-practice.test.ts: 词汇灵感练习场景生成契约
speech-assist.test.ts: 实时续说辅助触发、过期结果与显示守卫契约
stt-observable.test.ts: STT 实时片段规约、提交收敛与停止时已观察文本保全契约
text-cleaner.test.ts: 日语转写文本清洗与规整契约
home-stt.test.ts: 首页中文 STT 的既有文字保全、迟到结果、取消离页、冲突切换与 300 字上限契约
session-complete-offline.test.ts: 完成页重做 STT/token/共享流录音确认保存、离线中断废弃、转写保全、文字回退、懒播放 URL 回收与迟到结果隔离契约
scenario-draft-task.test.ts: 首页场景草稿未完成请求封套持久化、旧版本清理、成功与失败终态驱逐、前后台恢复、响应丢失与 deadline 重试、代际隔离和终态分类契约
home-practice-recovery.test.ts: 首页同场景复练准备恢复的 round-trip、viewed、非法存储与清理纯逻辑契约
tts-errors.test.ts: TTS 错误分类与界面恢复语义契约
voice-turn-controller.test.ts: 用户语音回合状态机、最终文本校验与录音启动锁契约

practice-history.test.ts: 浏览器历史提交失败、字段边界与完整场景隔离契约
voice-recordings.test.ts: 本机录音开关、MIME 优先级、暂存 Blob 与重录废弃契约
voice-turn-recording-lifecycle.test.tsx / .test.ts: 普通回合确认前暂存、确认保存和中断废弃本机录音契约
use-home-practice-recording-delete.test.tsx / .test.ts: 首页练习历史与关联本机录音的失败保全、删除顺序契约与 Vitest 收集入口
practice-progress.test.ts: 评价证据、独立性归因与同场景跨次比较契约
validation-client.test.ts: 匿名本地客户端标识生成与存储拒绝边界
validation-outbox.test.ts: sessionId 路由的无令牌 IndexedDB 队列、跨会话隔离、每会话 dedupe、退避投递、队列清空与内容脱敏契约
validation-telemetry.test.ts: 无同意输入的自动 checkpoint 入队、v2 collection batch 构建与发送契约

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
