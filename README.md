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

## 実装済み機能 (Phase 2 Step 2)
- 各プロンプトカードに「👍使ってみた」ボタンとコピー計測を追加、`/api/feedback` でD1に保存

## 未実装(次のステップ)
- Step 3: 月次バッチのAI自動評価は `worker/index.js` にコード実装済みだが、実際のCronトリガー動作確認は未検証
- Step 4: 「その場で新規プロンプトを生成」のフロントエンドUI(モーダル等)。バックエンドAPI `/api/generate` は実装済み
- Step 5: Slack承認後にproposal_queueのstatusを更新し本番データへ反映する仕組み(現状はSlack通知のみで、承認後の自動反映ロジックは未実装)

## Slack承認の仕組みについて
現時点ではSlackへの通知(提案内容の投稿)までを実装しています。「✅リアクションで承認 → 自動的にdata/prompts.jsonへ反映 → 再デプロイ」まで自動化するには、Slack側のイベント購読(reaction_added)を受け取るWorkerエンドポイントの追加が必要です。これは次のステップで実装します。
