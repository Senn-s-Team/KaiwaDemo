-- [INPUT]: 0001_validation_telemetry.sql 中的遥测基础表
-- [OUTPUT]: 面向场景、完成状态、失败与检查点分析的定向查询索引
-- [POS]: 匿名验证遥测的增量索引迁移
-- [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

CREATE INDEX IF NOT EXISTS validation_sessions_scenario_mode_idx ON validation_sessions(scenario_id, mode);
CREATE INDEX IF NOT EXISTS validation_sessions_completion_idx ON validation_sessions(completion_reason, closed_naturally);
CREATE INDEX IF NOT EXISTS validation_events_failure_idx ON validation_events(event, failure_domain, occurred_at);
CREATE INDEX IF NOT EXISTS validation_events_checkpoint_stage_idx ON validation_events(kind, stage, occurred_at);
