# KaiwaDemo - AI 日语自然对话练习系统
React + TypeScript + Vite + Cloudflare Workers + Web Audio API + ElevenLabs Realtime STT / TTS

<directory>
以下成员数不含目录内的 AGENTS.md。
src/ - 前端应用入口、会话编排、样式与领域类型 (5直属文件，5子目录: lib/、components/、data/、scenarios/、assets/)
src/lib/ - 音频流处理、STT/TTS 引擎、会话生命周期与辅助纯函数 (17成员)
shared/ - 浏览器与 Worker 共用的 wire schema 与推导类型 (2成员)
worker/ - Cloudflare Worker 服务端路由、模型代理、校验与签名边界 (11成员)
scripts/ - 构建期依赖校验与产物清洗脚本 (2成员)
tests/ - 客户端、Worker 与组件契约测试 (3子目录: client/、worker/、components/)
docs/ - 产品基线、理论依据、延期边界与验证材料 (6成员)
</directory>

<config>
package.json - 项目依赖与构建脚本
wrangler.jsonc - Cloudflare Worker 配置文件
</config>
