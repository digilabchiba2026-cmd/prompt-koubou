# プロンプト工房 (Phase 2)

学校教職員向け生成AIプロンプト集システム。Cloudflare Workers + D1 + Gemini API構成。

## 構成

```
site/            静的フロントエンド(index.html) — フィードバックボタン実装済み
data/prompts.json  プロンプトデータ(9教科・領域 x 5場面、JSON化済み)
worker/index.js  Cloudflare Worker本体(API + 静的配信 + 月次バッチ)
schema/schema.sql  D1データベーススキーマ
wrangler.toml    Cloudflare Workers設定
.github/workflows/deploy.yml  GitHub Actions自動デプロイ
```

## セットアップ手順

### 1. GitHubリポジトリ作成(要手動)
このフォルダの中身をそのまま新規リポジトリにpushしてください。

### 2. Cloudflare D1データベース作成(要手動)
```
wrangler d1 create prompt-koubou-db
```
出力された `database_id` を `wrangler.toml` の該当箇所に貼り付けてください。

```
wrangler d1 execute prompt-koubou-db --file=./schema/schema.sql
```

### 3. Secrets登録(要手動)
```
wrangler secret put GEMINI_API_KEY      # Google AI Studioで発行したキー
wrangler secret put SLACK_BOT_TOKEN     # Slack Appのボットトークン(chat:write権限)
wrangler secret put SLACK_CHANNEL_ID    # #prj-prompt-gen のチャンネルID (C0C2V0D3G11)
```

### 4. GitHub Actions用シークレット登録(要手動、GitHubリポジトリのSettings→Secrets)
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

### 5. デプロイ
main ブランチにpushすると自動デプロイされます。手動実行する場合は `wrangler deploy`。

## 実装済み機能
- 各プロンプトカードに「👍使ってみた」ボタンとコピー計測を追加、`/api/feedback` でD1に保存
- 「＋新しいプロンプトを作る」でその場生成(`/api/generate`)。提案はD1の `proposal_queue` に保存され、Slackへ通知
- Slackで ✅ を付けると承認され `approved_prompts` に反映、`/api/extra-prompts` 経由でサイトに表示。❌ は却下
- 月次バッチ(毎月1日18:00 UTC = 毎月2日03:00 JST)で全45場面をGeminiが自動評価し、`prompt_scores` / `evaluation_runs` に保存。低評価はSlackに報告

## 運用メモ
- `wrangler.toml` の `[placement] region = "gcp:asia-northeast1"` は、Geminiの地域制限エラーを避けるための設定です(削除しない)。
- デプロイはWrangler 4を使用します(`.github/workflows/deploy.yml` の `wranglerVersion`)。
- `keep_vars = true` により、デプロイしてもCloudflareの変数(Secrets)は消えません。
- 月次バッチが読む `site/data/prompts.json` は `data/prompts.json` と同じ内容にしてください。
- Slack AppはEvent Subscriptions(`reaction_added`)を有効にし、Socket Modeをオフにしてください。
