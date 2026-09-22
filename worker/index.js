/**
 * prompt-koubou Worker (Phase 2)
 *
 * ルート:
 *  GET  /                 -> 静的サイト(site/index.html, assets binding経由)
 *  POST /api/feedback     -> フィードバック保存 (D1: feedback)
 *  POST /api/generate     -> その場生成 (Gemini API呼び出し、承認キューにも追加)
 *  Scheduled (cron)       -> 月次バッチ: 全プロンプト再評価 + 自動拡充提案 + Slack通知
 *
 * 必要なバインディング (wrangler.toml):
 *  - DB (D1 database)
 *  - ASSETS (静的アセット / site ディレクトリ)
 *  - Secrets: GEMINI_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID
 */

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/feedback" && request.method === "POST") {
      return handleFeedback(request, env);
    }
    if (url.pathname === "/api/generate" && request.method === "POST") {
      return handleGenerate(request, env);
    }
    if (url.pathname === "/api/health") {
      return json({ ok: true });
    }

    // 静的サイトへフォールバック
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMonthlyBatch(env));
  },
};

// ---------- フィードバック収集 ----------
async function handleFeedback(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const { prompt_id, action, comment_text } = body;
  if (!prompt_id || !["copy", "good", "comment"].includes(action)) {
    return json({ error: "invalid_params" }, 400);
  }
  if (action === "comment" && (!comment_text || comment_text.length > 500)) {
    return json({ error: "invalid_comment" }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO feedback (prompt_id, action, comment_text) VALUES (?, ?, ?)`
  )
    .bind(prompt_id, action, action === "comment" ? comment_text : null)
    .run();

  return json({ ok: true });
}

// ---------- その場生成 ----------
async function handleGenerate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const { subject_name, scene_title, grade } = body;
  if (!subject_name || !scene_title) {
    return json({ error: "invalid_params" }, 400);
  }

  const prompt = buildGenerationPrompt({ subject_name, scene_title, grade });

  let pdca;
  try {
    pdca = await callGemini(env.GEMINI_API_KEY, prompt);
  } catch (err) {
    return json({ error: "generation_failed", detail: String(err) }, 502);
  }

  // 承認キューに追加(即時反映はしない)
  const result = await env.DB.prepare(
    `INSERT INTO proposal_queue (kind, subject_id, scene_title, pdca_json, status)
     VALUES ('manual_generate', ?, ?, ?, 'pending')`
  )
    .bind(subject_name, scene_title, JSON.stringify(pdca))
    .run();

  const proposalId = result.meta.last_row_id;

  // Slack承認依頼を送信(失敗してもユーザーへの応答は継続)
  try {
    await postSlackApproval(env, proposalId, {
      kind: "その場生成(教員リクエスト)",
      subject_name,
      scene_title,
      pdca,
    });
  } catch (err) {
    console.error("slack post failed", err);
  }

  return json({ ok: true, pdca, proposal_id: proposalId });
}

function buildGenerationPrompt({ subject_name, scene_title, grade }) {
  return `あなたは小学校教員向けの生成AIプロンプト作成の専門家です。
以下の条件で、教員が生成AIにそのまま入力できる4つのプロンプト例(PDCAサイクル形式)を作成してください。

教科・領域: ${subject_name}
場面: ${scene_title}
学年: ${grade || "指定なし(【学年】のようなプレースホルダーを使ってください)"}

出力は必ず以下のJSON形式のみで返してください(説明文は不要):
{"p": "計画段階で使うプロンプト", "d": "実践段階で使うプロンプト", "c": "評価段階で使うプロンプト", "a": "改善段階で使うプロンプト"}

各プロンプトは、既存の学校向けプロンプト集の文体(丁寧語、【 】でプレースホルダーを示す)に合わせてください。`;
}

async function callGemini(apiKey, promptText) {
  const res = await fetch(GEMINI_ENDPOINT(apiKey), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) {
    throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("empty_response");
  return JSON.parse(text);
}

// ---------- 月次バッチ: 自動評価 + 自動拡充提案 ----------
async function runMonthlyBatch(env) {
  const promptsRes = await env.ASSETS.fetch(
    new Request("https://internal/data/prompts.json")
  );
  const subjects = await promptsRes.json();

  let evaluated = 0;
  for (const subject of subjects) {
    for (let i = 0; i < subject.scenes.length; i++) {
      const scene = subject.scenes[i];
      for (const key of ["p", "d", "c", "a"]) {
        const promptId = `${subject.id}-${i}-${key}`;
        const text = scene.prompts[key];
        try {
          const score = await evaluatePrompt(env.GEMINI_API_KEY, text);
          await env.DB.prepare(
            `INSERT INTO prompt_scores (prompt_id, clarity_score, specificity_score, versatility_score, safety_score, reasoning, evaluated_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(prompt_id) DO UPDATE SET
               clarity_score=excluded.clarity_score,
               specificity_score=excluded.specificity_score,
               versatility_score=excluded.versatility_score,
               safety_score=excluded.safety_score,
               reasoning=excluded.reasoning,
               evaluated_at=excluded.evaluated_at`
          )
            .bind(
              promptId,
              score.clarity,
              score.specificity,
              score.versatility,
              score.safety,
              score.reasoning
            )
            .run();
          evaluated++;
        } catch (err) {
          console.error("evaluate failed", promptId, err);
        }
      }
    }
  }

  await env.DB.prepare(
    `INSERT INTO evaluation_runs (prompts_evaluated, status) VALUES (?, 'success')`
  )
    .bind(evaluated)
    .run();

  // 低評価プロンプトの一覧をSlackに通知(改善のトリガー)
  const low = await env.DB.prepare(
    `SELECT prompt_id, clarity_score, specificity_score FROM prompt_scores
     WHERE clarity_score <= 5 OR specificity_score <= 5
     ORDER BY clarity_score ASC LIMIT 10`
  ).all();

  if (low.results.length > 0) {
    await postSlackLowScoreReport(env, low.results);
  }

  // TODO: 自動拡充提案(未収録の場面の検出)は別関数 suggestNewScenes() として次段階で実装
}

async function evaluatePrompt(apiKey, promptText) {
  const evalPrompt = `以下のプロンプトを4つの観点(明確さ・具体性・汎用性・安全性)で1〜10点で採点し、
JSON形式のみで返してください: {"clarity": 数値, "specificity": 数値, "versatility": 数値, "safety": 数値, "reasoning": "短い理由"}

評価対象:
${promptText}`;
  return callGemini(apiKey, evalPrompt);
}

// ---------- Slack通知 ----------
async function postSlackApproval(env, proposalId, { kind, subject_name, scene_title, pdca }) {
  const text = [
    `🆕 *新規プロンプト提案 (${kind})*`,
    `教科・領域: ${subject_name} / 場面: ${scene_title}`,
    "",
    `*P・計画*: ${pdca.p}`,
    `*D・実践*: ${pdca.d}`,
    `*C・評価*: ${pdca.c}`,
    `*A・改善*: ${pdca.a}`,
    "",
    `承認する場合はこのメッセージに :white_check_mark: でリアクションしてください (proposal_id=${proposalId})`,
  ].join("\n");

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: env.SLACK_CHANNEL_ID, text }),
  });
}

async function postSlackLowScoreReport(env, rows) {
  const lines = rows.map(
    (r) => `- ${r.prompt_id}: 明確さ${r.clarity_score} / 具体性${r.specificity_score}`
  );
  const text = [`📉 *月次評価: 改善検討プロンプト TOP${rows.length}*`, ...lines].join("\n");

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: env.SLACK_CHANNEL_ID, text }),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
