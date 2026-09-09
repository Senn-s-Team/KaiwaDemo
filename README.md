# Kaiwa Demo

面向中文母语、具备约 JLPT N2 词汇与语法储备学习者的日语语音听说训练验证原型。本轮只验证一个核心假设：学习者是否愿意反复使用短、低压力、目标明确的听说训练，并在关键回合重做时获得可观察的当场改善。

## 核心产品闭环

1. **双入口供给**：用户从“灵感速练”或“自定义场景”进入。
2. **场景准备**：开始前展示宽泛场景背景、双方角色和唯一核心沟通目标，不泄露相手具体首句或答案。
3. **固定五轮**：正常完成路径包含 5 个正式回合，第 5 轮进入自然收束；不按语义判断提前结束，也不提供延长轮次。
4. **半双工听力优先**：相手先播放原始音频。L0 不提供支架，用户按需依次使用 L1 原速重听、L2 关键信息线索、L3 日语台词、L4 一句中文意图概要，不可跳级。首次进入 L2 时生成并按相手消息缓存完整支架，L2 至 L4 只逐级展示缓存中的对应内容；生成失败不升级层级，可重试，也不阻塞用户继续会话。
5. **转写确认安全垫与实时语音辅助**：用户以语音回应（支持文字降级），原始 STT 实时呈现；在稳定停顿（约 900ms 连续尾部静音、转写达 6 个日语字符且 350ms 无新 partial）时自动触发轻量辅助。界面真实展示 A（已说内容清理，严格限定为原文字符删除型子序列）；响应包含 B 时，也真实展示 B（续说建议，20 字以内短语或句尾框架），两者都不是仅供内部记录。继续发话或停止录音即刻清除辅助，B 绝不进入确认稿或正式事实源。连续静音达到 10 秒时开始倒计时，达到 13 秒时自动停止录音；倒计时期间继续说话即可取消自动停止，用户也可随时手动停止。转写必须由用户确认、修改或重录后才可提交。
6. **主动表达支架**：表达卡壳时可按需逐级展开 L1 方向指引、L2 核心语块、L3 句首框架、L4 完整参考句。若回合中展示了自动续说建议 B，该轮不能解释为无表达支架完成，但系统不强行将其映射为 L1-L4。
7. **克制相手**：相手保持角色，每轮 1 至 2 句，最多提 1 个聚焦问题，不在会中纠错或教学。
8. **精炼完成页**：只展示沟通结果及事实证据、1 个听力发现、1 个表达改进和 1 个关键回合重做任务。
9. **完整回合重做**：重播该回合原始相手音频，将听力和表达支架重置到无支架状态；听力仍按 L1 至 L4 顺序升级，已有消息缓存则复用，再重新录音/文字回应并确认第二稿，提交后对比前后沟通效果与参考表达。
10. **单场恢复与数据导出**：当前会话的场景、消息、回合记录、当前回合、`turn`、可编辑转写及按相手消息保存的听力支架缓存在浏览器 `sessionStorage`。刷新后恢复到最近可操作状态；录音或网络请求等不可原样恢复的阶段安全降级到等待用户回应或确认转写，不自动重放请求。训练事实、重做记录与 `speechAssistEvents` 可主动导出为 JSON；不设账号、云端数据库或跨设备持久化。

## 本地启动

要求：Node.js 26 以上、npm、具备麦克风权限的现代浏览器。

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

在 `.dev.vars` 中配置密钥后可直连真实链路；未配置时页面提供文字降级与受控流程检查 Mock。

## 环境变量

```dotenv
ELEVENLABS_API_KEY=
OPENAI_API_KEY=
SCENARIO_SIGNING_SECRET=
OPENAI_BASE_URL=https://api.openai.com/v1
ELEVENLABS_VOICE_ID=
ALLOW_MOCK=true
OPENAI_MODEL=gpt-5.6-luna
ELEVENLABS_STT_MODEL=scribe_v2_realtime
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5
```

## Cloudflare 部署与匿名验证数据

`wrangler.jsonc` 已声明 `VALIDATION_DB` D1 binding、`migrations/` 目录和每日 UTC 清理任务。首次部署或迁移新环境时，先确认配置中的 `database_id` 指向目标数据库，再执行：

```bash
npx wrangler d1 migrations apply kaiwa-validation --local
npx wrangler d1 migrations apply kaiwa-validation --remote
npm run deploy
```

生产环境还必须通过 Worker Secrets 配置永久密钥；不要把密钥写入 `wrangler.jsonc`：

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put SCENARIO_SIGNING_SECRET
```

首页仅在用户明确同意后发送匿名技术指标。`VALIDATION_DB` 缺失、D1 写入失败、浏览器存储不可用或遥测上传失败都只会丢失对应验证数据，不得阻断训练。隐私字段、撤销语义和保留期见 [PRIVACY.md](./PRIVACY.md)。

可直接用 D1 SQL 检查首要验证漏斗，不需要先建设独立看板：

```bash
npx wrangler d1 execute kaiwa-validation --remote --command "SELECT COUNT(*) AS started, SUM(closed_naturally) AS completed, SUM(feedback_completed) AS feedback_ready, SUM(redo_started) AS redo_started, SUM(redo_completed) AS redo_completed FROM validation_sessions;"
npx wrangler d1 execute kaiwa-validation --remote --command "SELECT event, failure_domain, failure_code, COUNT(*) AS occurrences FROM validation_events WHERE event IN ('failure_occurred', 'failure_recovered') GROUP BY event, failure_domain, failure_code ORDER BY occurrences DESC;"
npx wrangler d1 execute kaiwa-validation --remote --command "SELECT input_mode, listening_scaffold_level, expression_scaffold_level, COUNT(*) AS rounds, AVG(stt_finalize_latency_ms) AS avg_stt_ms, AVG(llm_first_text_latency_ms) AS avg_llm_first_text_ms, AVG(tts_first_audio_latency_ms) AS avg_tts_first_audio_ms FROM validation_rounds WHERE round_completed = 1 GROUP BY input_mode, listening_scaffold_level, expression_scaffold_level ORDER BY rounds DESC;"
```

## 质量检查与构建

```bash
npm run check
npm test
npm run build
npm run preview
```

1. 原型为回合制交互，不包含全双工打断、发音或声调打分、长期成长曲线。
2. 尾部静音检测（trailing silence）用于语音辅助触发，也用于 10 秒开始倒计时、13 秒自动停止录音；它不能恢复历史声学停顿。字段 A 仅对文本中的填充词与重复片段做确定性删除清理。
3. `sessionStorage` 只恢复当前浏览器标签页中的单场会话，不构成长期历史、数据库存储、账号同步或跨设备恢复；用户仍需主动点击“导出训练数据 JSON”保存报告。
4. 真实语音识别和合成受浏览器麦克风权限、音频采样率和网络延迟影响。
