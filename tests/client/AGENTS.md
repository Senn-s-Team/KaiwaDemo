# tests/client/
> L2 | 父级: /AGENTS.md
成员清单
ai-turn-controller.test.ts: 相手 AI 回合状态机、运行时代际隔离与播放降级契约
audio-engine.test.ts: 音频引擎采样、编码与资源释放纯逻辑契约
audio-feedback.test.ts: 录音计时、音量反馈与静音自动停止阈值契约
audio-lifecycle.test.ts: 浏览器音频权限、共享麦克风流、TTS 与 Token 生命周期集成契约
elevenlabs-guard.test.ts: ElevenLabs 浏览器入口构建守卫契约
feedback-data.test.ts: 会话反馈数据转换与展示输入契约
metrics.test.ts: 会话轮次指标与报告生成契约
recording-setup.test.ts: 录音准备并发协调、取消与失败回收契约
session-flow.test.ts: 客户端会话核心推进流程契约
session-recovery.test.ts: 前后台与离线中断恢复目标及入口契约
spark-practice.test.ts: 词汇灵感练习场景生成契约
speech-assist.test.ts: 实时续说辅助触发、过期结果与显示守卫契约
stt-observable.test.ts: STT 实时片段规约、提交收敛与停止时已观察文本保全契约
text-cleaner.test.ts: 日语转写文本清洗与规整契约
tts-errors.test.ts: TTS 错误分类与界面恢复语义契约
voice-turn-controller.test.ts: 用户语音回合状态机、最终文本校验与录音启动锁契约

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
