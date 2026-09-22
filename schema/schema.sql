-- prompt-koubou D1 スキーマ (Phase 2)
-- 適用方法: wrangler d1 execute prompt-koubou-db --file=./schema/schema.sql

-- 教員フィードバック(匿名)
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_id TEXT NOT NULL,        -- 例: "kokugo-0-p" (教科id-場面index-PDCA記号)
  action TEXT NOT NULL,           -- "copy" | "good" | "comment"
  comment_text TEXT,              -- action="comment" の場合のみ
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_prompt_id ON feedback(prompt_id);

-- AIによる自動評価スコア(プロンプトごとの最新値。履歴は evaluations に保存)
CREATE TABLE IF NOT EXISTS prompt_scores (
  prompt_id TEXT PRIMARY KEY,
  clarity_score INTEGER,          -- 明確さ 1-10
  specificity_score INTEGER,      -- 具体性 1-10
  versatility_score INTEGER,      -- 汎用性 1-10
  safety_score INTEGER,           -- 安全性 1-10
  reasoning TEXT,                 -- AIによる採点理由
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 評価バッチの実行履歴(月次バッチの監査ログ)
CREATE TABLE IF NOT EXISTS evaluation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at TEXT NOT NULL DEFAULT (datetime('now')),
  prompts_evaluated INTEGER,
  status TEXT                     -- "success" | "partial" | "failed"
);

-- 新規提案キュー(自動生成・自動拡充の提案。Slack承認待ち/承認済み/却下)
CREATE TABLE IF NOT EXISTS proposal_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,             -- "manual_generate" | "auto_expand"
  subject_id TEXT,                -- 教科・領域id (既存 or 新規)
  scene_title TEXT,
  pdca_json TEXT NOT NULL,        -- {"p":"...","d":"...","c":"...","a":"..."}
  status TEXT NOT NULL DEFAULT 'pending', -- "pending" | "approved" | "rejected" | "revise_requested"
  slack_message_ts TEXT,          -- 承認用Slackメッセージのタイムスタンプ
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposal_status ON proposal_queue(status);
