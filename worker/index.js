/**
 * prompt-koubou Worker (Phase 2)
 *
 * ルート:
 *  GET  /                    -> 静的サイト(site/index.html, assets binding経由)
 *  POST /api/feedback        -> フィードバック保存 (D1: feedback)
 *  POST /api/generate        -> その場生成 (Gemini API呼び出し、承認キューにも追加)
 *  GET  /api/extra-prompts   -> Slack承認済みの追加プロンプト一覧(フロントで既存データにマージ表示)
 *  POST /slack/events        -> Slack Events API(reaction_addedで承認/却下を検知し自動反映)
 *  POST /slack/interactions  -> Slack Interactivity(承認/却下ボタン。署名検証あり、要 SLACK_SIGNING_SECRET)
 *  Scheduled (cron)          -> 月次バッチ: 全プロンプト再評価 + 自動拡充提案 + Slack通知
 *
 * 必要なバインディング (wrangler.toml):
 *  - DB (D1 database)
 *  - ASSETS (静的アセット / site ディレクトリ)
 *  - Secrets: GEMINI_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID
 *
 * Slack Events API利用には別途、Slack App側で以下が必要:
 *  - Bot Token Scopeに reactions:read を追加して再インストール
 *  - Event Subscriptions を有効化し、Request URLに
 *    https://<worker-domain>/slack/events を設定
 *  - Subscribe to bot events に reaction_added を追加
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
    if (url.pathname === "/api/extra-prompts" && request.method === "GET") {
      return handleExtraPrompts(request, env);
    }
    if (url.pathname === "/slack/events" && request.method === "POST") {
      return handleSlackEvents(request, env);
    }
    if (url.pathname === "/slack/interactions" && request.method === "POST") {
      return handleSlackInteractions(request, env);
    }
    if (url.pathname === "/api/health") {
      return json({ ok: true });
    }

    // 静的サイトへフォールバック
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMonthlyBatch(env, event.scheduledTime));
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

  // Slack承認依頼を送信し、メッセージのtsをproposal_queueに記録(承認リアクション検知に使う)
  try {
    const ts = await postSlackApproval(env, proposalId, {
      kind: "その場生成(教員リクエスト)",
      subject_name,
      scene_title,
      pdca,
    });
    if (ts) {
      await env.DB.prepare(
        `UPDATE proposal_queue SET slack_message_ts = ? WHERE id = ?`
      )
        .bind(ts, proposalId)
        .run();
    }
  } catch (err) {
    console.error("slack post failed", err);
  }

  return json({ ok: true, pdca, proposal_id: proposalId });
}

// ---------- 承認済み追加プロンプトの取得 ----------
async function handleExtraPrompts(request, env) {
  const rows = await env.DB.prepare(
    `SELECT id, subject_id, scene_title, pdca_json, created_at FROM approved_prompts ORDER BY created_at DESC`
  ).all();

  const items = rows.results.map((r) => ({
    id: r.id,
    subject_id: r.subject_id,
    scene_title: r.scene_title,
    pdca: JSON.parse(r.pdca_json),
    created_at: r.created_at,
  }));

  return json({ items });
}

// ---------- Slack Events API (reaction_added で承認/却下を自動反映) ----------
async function handleSlackEvents(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // Slackがエンドポイント検証時に送ってくるチャレンジに応答
  if (body.type === "url_verification") {
    return json({ challenge: body.challenge });
  }

  if (body.type === "event_callback" && body.event) {
    const ev = body.event;
    if (ev.type === "reaction_added" && ev.item && ev.item.ts) {
      await handleReaction(env, ev.reaction, ev.item.ts);
    }
  }

  // Slackへは常に200を即返す(処理自体はここまでで完了、リトライ防止)
  return json({ ok: true });
}

async function handleReaction(env, reaction, messageTs) {
  const row = await env.DB.prepare(
    `SELECT id, subject_id, scene_title, pdca_json, status FROM proposal_queue WHERE slack_message_ts = ?`
  )
    .bind(messageTs)
    .first();

  if (!row || row.status !== "pending") return; // 対象なし、または処理済み

  if (reaction === "white_check_mark" || reaction === "+1") {
    await decideProposal(env, row, "approve", messageTs);
  } else if (reaction === "x") {
    await decideProposal(env, row, "reject", messageTs);
  }
}

// 承認/却下の共通処理(リアクションでもボタンでも同じ結果になる)。
// 先にstatusをpendingから更新できた場合だけ処理するので、二重に押されても二重登録されない。
// 戻り値: 処理した場合 "approved" / "rejected"、すでに処理済みなら null
async function decideProposal(env, row, decision, messageTs) {
  const newStatus = decision === "approve" ? "approved" : "rejected";
  const upd = await env.DB.prepare(
    `UPDATE proposal_queue SET status = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'`
  )
    .bind(newStatus, row.id)
    .run();
  if (!upd.meta || upd.meta.changes !== 1) return null;

  if (decision === "approve") {
    await env.DB.prepare(
      `INSERT INTO approved_prompts (subject_id, scene_title, pdca_json) VALUES (?, ?, ?)`
    )
      .bind(row.subject_id, row.scene_title, row.pdca_json)
      .run();
    await postSlackReply(env, messageTs, "✅ 承認されました。サイトに反映されました(数分以内に表示されます)。");
  } else {
    await postSlackReply(env, messageTs, "❌ 却下されました。");
  }
  return newStatus;
}

// ---------- Slack Interactivity (承認/却下ボタン) ----------
async function handleSlackInteractions(request, env) {
  const rawBody = await request.text();

  // 署名検証(SLACK_SIGNING_SECRET未設定なら安全側に倒して拒否)
  const ok = await verifySlackSignature(request, rawBody, env.SLACK_SIGNING_SECRET);
  if (!ok) return new Response("invalid signature", { status: 401 });

  let payload;
  try {
    payload = JSON.parse(new URLSearchParams(rawBody).get("payload") || "");
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  const action = payload.type === "block_actions" && payload.actions && payload.actions[0];
  if (!action) return new Response("", { status: 200 });

  const decision =
    action.action_id === "approve_proposal" ? "approve" :
    action.action_id === "reject_proposal" ? "reject" : null;
  if (!decision) return new Response("", { status: 200 });

  const messageTs = payload.message && payload.message.ts;
  const row = await env.DB.prepare(
    `SELECT id, subject_id, scene_title, pdca_json, status FROM proposal_queue WHERE id = ? AND slack_message_ts = ?`
  )
    .bind(Number(action.value), messageTs)
    .first();

  let resultText;
  if (!row) {
    resultText = "⚠️ 対象の提案が見つかりませんでした。";
  } else {
    const done = await decideProposal(env, row, decision, messageTs);
    const who = payload.user && payload.user.id ? ` (<@${payload.user.id}>)` : "";
    if (done === "approved") resultText = `✅ 承認済み${who}`;
    else if (done === "rejected") resultText = `❌ 却下済み${who}`;
    else resultText = row.status === "approved" ? "✅ すでに承認済みです" : "❌ すでに却下済みです";
  }

  // 元のメッセージからボタンを外し、結果を表示する
  if (payload.response_url && payload.message && Array.isArray(payload.message.blocks)) {
    const blocks = payload.message.blocks
      .filter((b) => b.type !== "actions")
      .concat([{ type: "context", elements: [{ type: "mrkdwn", text: resultText }] }]);
    await fetch(payload.response_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        replace_original: true,
        text: payload.message.text || "新規プロンプト提案",
        blocks,
      }),
    });
  }

  return new Response("", { status: 200 });
}

async function verifySlackSignature(request, rawBody, secret) {
  if (!secret) return false;
  const ts = request.headers.get("x-slack-request-timestamp");
  const sig = request.headers.get("x-slack-signature");
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false; // リプレイ対策

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${rawBody}`));
  const expected =
    "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

  // 定数時間比較
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
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
// 制約への配慮:
//  - 1場面(P/D/C/Aの4プロンプト)を1回のGemini呼び出しで評価する(外部通信は1回の実行で最大43回、全場面は2日に分けて評価)
//  - Gemini無料枠の速度制限(毎分10回程度)に合わせ、呼び出し間に待機を入れる
//  - D1への書き込みは最後に1回のbatchでまとめる
const BATCH_WAIT_MS = 6500;
// Workers無料枠の外部通信上限(50回/実行)に収めるため、1回の実行で評価する場面数の上限。
// 場面が多い場合は複数日に分割し、実行日(UTC)の日番号で担当ブロックを決める(1日→1番目、2日→2番目…)。
const BATCH_MAX_SCENES = 43;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runMonthlyBatch(env, scheduledTime) {
  const promptsRes = await env.ASSETS.fetch(
    new Request("https://internal/data/prompts.json")
  );
  if (!promptsRes.ok) {
    await env.DB.prepare(
      `INSERT INTO evaluation_runs (prompts_evaluated, status) VALUES (0, 'failed')`
    ).run();
    console.error("prompts.json not found", promptsRes.status);
    return;
  }
  const subjects = await promptsRes.json();

  // 全場面を1列に並べ、今回の担当ブロックだけを評価する
  const all = [];
  for (const subject of subjects) {
    for (let i = 0; i < subject.scenes.length; i++) {
      all.push({ subject, i, scene: subject.scenes[i] });
    }
  }
  const blocks = Math.max(1, Math.ceil(all.length / BATCH_MAX_SCENES));
  const day = new Date(scheduledTime || Date.now()).getUTCDate();
  const block = (day - 1) % blocks;
  const targets = all.slice(block * BATCH_MAX_SCENES, (block + 1) * BATCH_MAX_SCENES);
  console.log(`batch block ${block + 1}/${blocks}: ${targets.length} scenes of ${all.length}`);

  const stmts = [];
  let evaluated = 0;
  let attempted = 0;
  let first = true;

  for (const { subject, i, scene } of targets) {
    {
      attempted += 4;
      if (!first) await sleep(BATCH_WAIT_MS);
      first = false;

      try {
        const scores = await evaluateScene(env.GEMINI_API_KEY, scene);
        for (const key of ["p", "d", "c", "a"]) {
          const sc = scores[key];
          if (!sc) continue;
          stmts.push(
            env.DB.prepare(
              `INSERT INTO prompt_scores (prompt_id, clarity_score, specificity_score, versatility_score, safety_score, reasoning, evaluated_at)
               VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(prompt_id) DO UPDATE SET
                 clarity_score=excluded.clarity_score,
                 specificity_score=excluded.specificity_score,
                 versatility_score=excluded.versatility_score,
                 safety_score=excluded.safety_score,
                 reasoning=excluded.reasoning,
                 evaluated_at=excluded.evaluated_at`
            ).bind(
              `${subject.id}-${i}-${key}`,
              sc.clarity,
              sc.specificity,
              sc.versatility,
              sc.safety,
              sc.reasoning
            )
          );
          evaluated++;
        }
      } catch (err) {
        console.error("evaluate failed", subject.id, i, String(err));
      }
    }
  }

  if (stmts.length > 0) {
    await env.DB.batch(stmts);
  }

  const status = evaluated === 0 ? "failed" : evaluated < attempted ? "partial" : "success";
  await env.DB.prepare(
    `INSERT INTO evaluation_runs (prompts_evaluated, status) VALUES (?, ?)`
  )
    .bind(evaluated, status)
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

async function evaluateScene(apiKey, scene) {
  const evalPrompt = `以下は、ある場面で使うPDCA4段階のプロンプトです。それぞれを4つの観点(明確さ・具体性・汎用性・安全性)で1〜10点で採点し、
JSON形式のみで返してください:
{"p": {"clarity": 数値, "specificity": 数値, "versatility": 数値, "safety": 数値, "reasoning": "短い理由"}, "d": {...}, "c": {...}, "a": {...}}

P・計画: ${scene.prompts.p}
D・実践: ${scene.prompts.d}
C・評価: ${scene.prompts.c}
A・改善: ${scene.prompts.a}`;
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
    `承認する場合は下の「承認」ボタン(または :white_check_mark: のリアクション)、却下する場合は「却下」ボタン(または :x:)を使ってください (proposal_id=${proposalId})`,
  ].join("\n");

  // ボタン付きメッセージ(textは通知・古いクライアント向けのフォールバック)
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🆕 *新規プロンプト提案 (${kind})*\n教科・領域: ${subject_name} / 場面: ${scene_title}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*P・計画*: ${pdca.p}`,
          `*D・実践*: ${pdca.d}`,
          `*C・評価*: ${pdca.c}`,
          `*A・改善*: ${pdca.a}`,
        ].join("\n\n").slice(0, 2900),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "承認" },
          style: "primary",
          action_id: "approve_proposal",
          value: String(proposalId),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "却下" },
          style: "danger",
          action_id: "reject_proposal",
          value: String(proposalId),
        },
      ],
    },
  ];

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: env.SLACK_CHANNEL_ID, text, blocks }),
  });
  const data = await res.json();
  return data.ok ? data.ts : null;
}

async function postSlackReply(env, threadTs, text) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: env.SLACK_CHANNEL_ID, text, thread_ts: threadTs }),
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
