-- [INPUT]: 来自 shared wire fact 的同意式技术验证数据
-- [OUTPUT]: 面向隐私安全、幂等遥测持久化的严格 D1 表
-- [POS]: 匿名验证遥测的基础 schema 迁移
-- [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md

CREATE TABLE IF NOT EXISTS validation_sessions (
 session_id TEXT PRIMARY KEY, anonymous_client_hash TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
 scenario_id TEXT, scenario_version INTEGER, variant_id TEXT, mode TEXT, scenario_source TEXT, practice_trigger TEXT,
 device_class TEXT, os_family TEXT, browser_family TEXT, browser_major INTEGER, network_class TEXT, audio_device_class TEXT,
 started_at INTEGER, ended_at INTEGER, duration_milliseconds INTEGER, last_stage TEXT, completion_reason TEXT,
 closed_naturally INTEGER, feedback_completed INTEGER, redo_started INTEGER, redo_completed INTEGER, round_count INTEGER,
 failure_count INTEGER, retry_count INTEGER, text_fallback_count INTEGER, listening_scaffold_rounds_count INTEGER, expression_scaffold_rounds_count INTEGER,
 speech_assist_request_count INTEGER, speech_assist_displayed_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
 stt_audio_milliseconds INTEGER, llm_request_count INTEGER, tts_request_count INTEGER, tts_character_count INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS validation_events (
 event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES validation_sessions(session_id), sequence INTEGER NOT NULL,
 occurred_at INTEGER NOT NULL, kind TEXT NOT NULL, stage TEXT, turn INTEGER, event TEXT, failure_domain TEXT, failure_code TEXT,
 recoverable INTEGER, recovered INTEGER, latency_ms INTEGER, UNIQUE(session_id, sequence)
) STRICT;
CREATE TABLE IF NOT EXISTS validation_rounds (
 event_id TEXT PRIMARY KEY REFERENCES validation_events(event_id), session_id TEXT NOT NULL REFERENCES validation_sessions(session_id), sequence INTEGER NOT NULL,
 occurred_at INTEGER NOT NULL, turn INTEGER NOT NULL, input_mode TEXT NOT NULL, listening_scaffold_level INTEGER NOT NULL, expression_scaffold_level INTEGER NOT NULL,
 speech_assist_displayed INTEGER NOT NULL, transcript_modified INTEGER NOT NULL, transcript_modification_count INTEGER NOT NULL, rerecord_count INTEGER NOT NULL,
 tts_replay_count INTEGER NOT NULL, failure_count INTEGER NOT NULL, retry_count INTEGER NOT NULL, speech_start_latency_ms INTEGER, stt_finalize_latency_ms INTEGER,
 transcript_confirm_latency_ms INTEGER, llm_first_text_latency_ms INTEGER, llm_complete_latency_ms INTEGER, tts_first_audio_latency_ms INTEGER, round_wait_latency_ms INTEGER, round_completed INTEGER NOT NULL,
 UNIQUE(session_id, sequence)
) STRICT;
CREATE TABLE IF NOT EXISTS validation_reviews (
 event_id TEXT PRIMARY KEY REFERENCES validation_events(event_id), session_id TEXT NOT NULL REFERENCES validation_sessions(session_id), sequence INTEGER NOT NULL,
 occurred_at INTEGER NOT NULL, review_kind TEXT NOT NULL, turn INTEGER, evaluation_version TEXT NOT NULL, model_version TEXT NOT NULL, prompt_version TEXT NOT NULL,
 outcome TEXT, improvement TEXT, citation_valid INTEGER, model_human_agreement INTEGER, UNIQUE(session_id, sequence)
) STRICT;
CREATE INDEX IF NOT EXISTS validation_events_occurred_at_idx ON validation_events(occurred_at);
CREATE INDEX IF NOT EXISTS validation_rounds_occurred_at_idx ON validation_rounds(occurred_at);
CREATE INDEX IF NOT EXISTS validation_reviews_occurred_at_idx ON validation_reviews(occurred_at);
CREATE INDEX IF NOT EXISTS validation_sessions_last_seen_idx ON validation_sessions(last_seen_at);
