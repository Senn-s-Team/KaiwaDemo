-- [INPUT]: 依赖 0001_validation_telemetry.sql 建立的验证 telemetry sessions 表
-- [OUTPUT]: 提供 session summary 序列游标，保证乱序与重放安全
-- [POS]: 验证 telemetry session 聚合的增量迁移
-- [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

ALTER TABLE validation_sessions ADD COLUMN last_summary_sequence INTEGER;
