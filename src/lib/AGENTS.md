# src/lib/
> L2 | 父级: /AGENTS.md
成员清单
session.ts: 会话生命周期、固定五回合推进与显式中断恢复状态机，集中定义 idle/interrupted/retrying/recovered/failed 转换、恢复目标、可操作入口与执行裁决
stt.ts: 实时语音识别会话与流水线管理，支持按会话选择识别语言，取消时释放共享麦克风，并以 selectFinalSttText 在远端最终提交关闭或超时时保全已观察转写
tts.ts: 语音合成与播放管理，含手势解锁状态缓存、文本分块生成、原位置暂停继续与从头停止，CachedTtsPlayer / parseTtsMessage
audio-engine.ts: 基础音频处理管线与流复用管理，包含麦克风采样、重采样、环形缓冲、硬件流安全释放与前后台 teardown 裁决 shouldTeardownOnVisibility / isPermissionRequesting
recording-setup.ts: 录音准备与并发协调深模块，隐藏麦克风与 Token 并发获取、连接就绪判定与失败统一回收，coordinateRecordingSetup
voice-turn-controller.ts: 用户语音回合核心控制器深模块，以代际所有权锁隔离 dispose/retry 与迟到 finally，聚合麦克风权限状态、转写流与草稿、空语音/静音防护拦截、文本输入回退与单轮资源生命周期闭环，useVoiceTurnController / voiceTurnReducer / parseFinalTranscript / createRecordingStartLock
ai-turn-controller.ts: 相手 AI 回合控制器深模块，闭环拥有 LLM 流式应答、TTS 播放/暂停/继续/降级、五回合自然判定与回合流转，useAiTurnController / createAiTurnRuntime / aiTurnReducer
audio-feedback.ts: 麦克风电平与录音时长计算，静音警告纯函数
microphone.ts: 麦克风权限预检、静默 Permissions.query 状态探测 queryMicrophonePermission 与状态缓存
speech-assist.ts: 实时续说辅助触发规则与显示守卫
metrics.ts: 从回合、失败/重试与 speechAssistEvents 聚合 RoundRecord / SessionReport，构建 completion、recovery 与 speechAssistUsed 事实
text-cleaner.ts: 转写文本清洗与规整化
api.ts: 前端 API 通信层，提供原场景复练，验证动态会话、版本化证据反馈与听力支架响应，并直接复用 shared/ 下对应的唯一 wire schema 与推导类型
spark-practice.ts: 首页三个可编辑场景例子的抽取、换组避重与动态场景请求描述生成
home-stt.ts: 首页中文 STT 的纯生命周期规则，裁决迟到结果、离页/取消、准备与澄清冲突，以及不覆盖既有文字的 300 字合并边界
ui.ts: UI 错误归一化与提示生成

practice-history.ts: 当前浏览器 IndexedDB 练习历史、完整场景分组与关联删除，不保存临时访问令牌
practice-progress.ts: 基于有效引用与帮助事实的场景表现汇总、同标准首次完整练习比较

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
