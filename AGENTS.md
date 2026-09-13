# KaiwaDemo - AI 日语自然对话练习系统
React + TypeScript + Vite + Cloudflare Workers + Web Audio API + ElevenLabs Realtime STT / TTS

<directory>
以下成员数不含目录内的 AGENTS.md。
src/ - 前端应用入口、双开场会话编排、样式与领域类型 (5直属文件，5子目录: lib/、components/、data/、scenarios/、assets/)
src/lib/ - 音频流处理、STT/TTS 引擎、会话生命周期、首页恢复、本机恢复形状守卫与匿名验证辅助纯函数 (35成员)
shared/ - 浏览器与 Worker 共用的双开场 wire schema 与推导类型 (6成员)
worker/ - Cloudflare Worker 服务端双开场路由、模型代理、校验、签名、匿名验证与 Workflow 持久任务边界 (19成员)
migrations/ - D1 匿名技术验证基础表、分析索引与 summary 序列迁移 (3成员)
scripts/ - 构建期依赖校验与产物清洗脚本 (2成员)
tests/ - 客户端、Worker 与组件契约测试 (3子目录: client/、worker/、components/)
docs/ - 活文档入口：产品契约、系统边界与人工测试模板 (3成员)
DESIGN.md - Calm Conversational Studio 视觉、组件、移动优先布局与实现边界规范
</directory>

<config>
package.json - 项目依赖与构建脚本
wrangler.jsonc - Cloudflare Worker 配置文件
</config>

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
