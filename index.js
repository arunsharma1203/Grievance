// server/index.js (ES modules)
// Run: node index.js  (ensure package.json has "type":"module")

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import pkg from "pg";
const { Pool } = pkg;

dotenv.config();

const mask = (s) =>
  !s ? "(missing)" : s.length > 12 ? `${s.slice(0, 6)}...${s.slice(-6)}` : s;

console.log("startup env:");
console.log("  TELEGRAM_BOT_TOKEN:", mask(process.env.TELEGRAM_BOT_TOKEN));
console.log(
  "  TELEGRAM_CHAT_ID: ",
  process.env.TELEGRAM_CHAT_ID ? "(set)" : "(missing)"
);
console.log(
  "  TELEGRAM_ADMIN_ID: ",
  process.env.TELEGRAM_ADMIN_ID ? "(set)" : "(missing)"
);
console.log(
  "  DATABASE_URL: ",
  process.env.DATABASE_URL ? "(set)" : "(missing)"
);

const app = express();
app.use(cors());
app.use(express.json({ limit: "200kb" })); // small limit, diary bodies can be larger if needed

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // used for broadcasts/notifications
const TELEGRAM_ADMIN_ID =
  (process.env.TELEGRAM_ADMIN_ID || TELEGRAM_CHAT_ID) + "";

const DATABASE_URL = process.env.DATABASE_URL;

// Postgres pool
if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing. Set it in .env or your hosting env.");
  process.exit(1);
}
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Create tables if not exists
const ensureTables = async () => {
  // grievances (already used by the app)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grievances (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      text TEXT NOT NULL,
      reply TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      replied_at TIMESTAMP WITH TIME ZONE
    );
  `);

  // moods table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moods (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      value INTEGER NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);

  // diary notes table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS diary_notes (
      id TEXT PRIMARY KEY,
      username TEXT,
      title TEXT,
      body TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);
};
ensureTables().catch((e) => {
  console.error("Failed to ensure tables:", e);
  process.exit(1);
});

// Helper: escape HTML for Telegram HTML parse_mode
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Helper: send message to the configured admin chat (used for notifications)
// supports parse_mode optional ('HTML' or 'Markdown' etc.)
async function sendTelegramMessage(text, parse_mode = "HTML") {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("Telegram not configured - skipping send.");
    return { ok: false, reason: "no-telegram-config" };
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode }),
  });
  const data = await resp.json();
  if (!data.ok) console.error("Telegram API error:", data);
  return data;
}

// Helper: send message to a specific chat id (useful to reply to the chat which sent a command)
async function sendTelegramTo(chatId, text, parse_mode = "HTML") {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("Telegram not configured - skipping sendTelegramTo.");
    return { ok: false, reason: "no-telegram-config" };
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode }),
  });
  const data = await resp.json();
  if (!data.ok) console.error("Telegram API error:", data);
  return data;
}

// Polling getUpdates for replies and admin commands (your existing logic)
let tgUpdateOffset = 0;
async function pollTelegramUpdates() {
  if (!TELEGRAM_BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=1&offset=${
    tgUpdateOffset + 1
  }`;
  try {
    const res = await fetch(url);
    const body = await res.json();
    if (!body.ok || !Array.isArray(body.result) || body.result.length === 0)
      return;
    for (const update of body.result) {
      if (update.update_id && update.update_id > tgUpdateOffset)
        tgUpdateOffset = update.update_id;
      const msg = update.message || update.edited_message;
      if (!msg || !msg.text) continue;
      const text = msg.text.trim();
      const fromChatId =
        msg.chat && msg.chat.id ? msg.chat.id.toString() : null;

      console.log("Telegram message received from", fromChatId, "text:", text);

      // Admin /clear flow
      if (/^\/clear\b/i.test(text)) {
        if (fromChatId !== TELEGRAM_ADMIN_ID) {
          await sendTelegramTo(
            fromChatId,
            "⛔ You are not authorized to clear history."
          );
          continue;
        }
        await sendTelegramTo(
          fromChatId,
          "⚠️ Are you sure you want to delete ALL grievances, moods and diary notes? If yes, reply with:\n/confirm_clear\n\nThis action is irreversible."
        );
        continue;
      }
      if (/^\/confirm_clear\b/i.test(text)) {
        if (fromChatId !== TELEGRAM_ADMIN_ID) {
          await sendTelegramTo(
            fromChatId,
            "⛔ You are not authorized to clear history."
          );
          continue;
        }
        try {
          const delG = await pool.query("DELETE FROM grievances");
          const delM = await pool.query("DELETE FROM moods");
          const delD = await pool.query("DELETE FROM diary_notes");
          const deletedCountGrievances = delG.rowCount || 0;
          const deletedCountMoods = delM.rowCount || 0;
          const deletedCountDiary = delD.rowCount || 0;
          await sendTelegramTo(
            fromChatId,
            `✅ Deleted ${deletedCountGrievances} grievances, ${deletedCountMoods} moods and ${deletedCountDiary} diary notes.`
          );
          console.log(
            `Admin ${fromChatId} cleared data: grievances=${deletedCountGrievances}, moods=${deletedCountMoods}, diary=${deletedCountDiary}`
          );
        } catch (err) {
          console.error("Failed to delete data:", err);
          await sendTelegramTo(
            fromChatId,
            `❌ Failed to delete data: ${err.message}`
          );
        }
        continue;
      }

      // Reply parsing for grievances (same as before)
      const replyMatch = text.match(/^(?:reply)\s+(\S+)\s+([\s\S]+)/i);
      const idMatch = text.match(/^(?:id[:#]?)\s*(\S+)\s+([\s\S]+)/i);
      let id, replyText;
      if (replyMatch) {
        id = replyMatch[1];
        replyText = replyMatch[2].trim();
      } else if (idMatch) {
        id = idMatch[1];
        replyText = idMatch[2].trim();
      } else {
        // Not a recognized command — only nudge admin
        if (fromChatId === TELEGRAM_ADMIN_ID) {
          await sendTelegramTo(
            fromChatId,
            "Commands:\nreply <GRIEVANCE_ID> <message>\n/clear to delete data\n/confirm_clear to confirm deletion\n\n(You can also delete a diary note by sending: delete_diary <id>)"
          );
        }
        // Also support admin deleting diary via `delete_diary <id>`
        const delDiaryMatch = text.match(/^delete_diary\s+(\S+)/i);
        if (delDiaryMatch && fromChatId === TELEGRAM_ADMIN_ID) {
          const delId = delDiaryMatch[1];
          try {
            const r = await pool.query(
              "DELETE FROM diary_notes WHERE id=$1 RETURNING *",
              [delId]
            );
            if (r.rowCount === 0) {
              await sendTelegramTo(
                fromChatId,
                `No diary note found with ID ${delId}.`
              );
            } else {
              await sendTelegramTo(fromChatId, `Deleted diary note ${delId}.`);
            }
          } catch (err) {
            await sendTelegramTo(
              fromChatId,
              `Failed to delete diary ${delId}: ${err.message}`
            );
          }
        }
        continue;
      }

      // attach reply in DB
      try {
        const q = `UPDATE grievances SET reply = $1, replied_at = now() WHERE id = $2 RETURNING *`;
        const r = await pool.query(q, [replyText, id]);
        if (r.rowCount === 0) {
          await sendTelegramTo(fromChatId, `No grievance found with ID ${id}.`);
          continue;
        }
        await sendTelegramTo(
          fromChatId,
          `Reply recorded for grievance ID ${id}:\n\n${replyText}`
        );
        console.log(`Recorded reply for grievance ${id}`);
      } catch (err) {
        console.error("Failed to record reply:", err);
        await sendTelegramTo(
          fromChatId,
          `Failed to record reply for ${id}: ${err.message}`
        );
      }
    }
  } catch (err) {
    console.error("pollTelegramUpdates error:", err);
  }
}
setInterval(() => {
  pollTelegramUpdates().catch(console.error);
}, 3000);

// -------- Endpoints --------

// health
app.get("/", (req, res) => res.json({ ok: true }));

// read grievances (ordered oldest-first for UI continuity)
app.get("/grievances", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, text, reply, created_at, replied_at FROM grievances ORDER BY created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /grievances error:", err);
    res.status(500).json({ error: err.message });
  }
});

// read moods (recent)
app.get("/moods", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, value, created_at FROM moods ORDER BY created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /moods error:", err);
    res.status(500).json({ error: err.message });
  }
});

// get latest mood for a user
app.get("/mood/latest", async (req, res) => {
  try {
    const username = req.query.username;
    if (!username) return res.status(400).json({ error: "username required" });
    const { rows } = await pool.query(
      `SELECT id, username, value, created_at FROM moods WHERE username=$1 ORDER BY created_at DESC LIMIT 1`,
      [username]
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error("GET /mood/latest error:", err);
    res.status(500).json({ error: err.message });
  }
});

// notify (login)
app.post("/notify", async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "username required" });
    const tg = await sendTelegramMessage(
      `✅ Login: ${escapeHtml(username)} (${new Date().toLocaleString()})`
    );
    res.json({ ok: true, telegram: tg });
  } catch (err) {
    console.error("/notify error:", err);
    res.status(500).json({ error: err.message });
  }
});

// create grievance
app.post("/grievances", async (req, res) => {
  try {
    const { username, text } = req.body;
    if (!username || !text)
      return res.status(400).json({ error: "username and text required" });
    const id = Date.now().toString();
    await pool.query(
      `INSERT INTO grievances(id, username, text) VALUES($1,$2,$3)`,
      [id, username, text]
    );
    const tg = await sendTelegramMessage(
      `📢 New grievance from ${escapeHtml(username)}:\n\n${escapeHtml(
        text
      )}\n\nID: ${escapeHtml(id)}\n\nReply using:\nreply ${escapeHtml(
        id
      )} <your message>`
    ).catch((e) => ({ ok: false, e }));
    res.json({ ok: true, grievance: { id, username, text }, telegram: tg });
  } catch (err) {
    console.error("POST /grievances error:", err);
    res.status(500).json({ error: err.message });
  }
});

// create mood
app.post("/mood", async (req, res) => {
  try {
    const { username, value } = req.body;
    if (!username || typeof value === "undefined")
      return res.status(400).json({ error: "username and value required" });
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0 || v > 10)
      return res.status(400).json({ error: "value must be 0-10" });

    const insert = await pool.query(
      `INSERT INTO moods(username, value) VALUES($1,$2) RETURNING id, username, value, created_at`,
      [username, v]
    );
    const row = insert.rows[0];

    // Notify admin via Telegram
    const tgText = `📊 Mood update from ${escapeHtml(
      username
    )}: ${v}/10\n\nAt: ${escapeHtml(
      new Date(row.created_at).toLocaleString()
    )}\nID: ${row.id}`;
    const tg = await sendTelegramMessage(tgText).catch((e) => ({
      ok: false,
      e,
    }));

    res.json({ ok: true, mood: row, telegram: tg });
  } catch (err) {
    console.error("POST /mood error:", err);
    res.status(500).json({ error: err.message });
  }
});

// admin reply via API (optional)
app.post("/grievances/:id/reply", async (req, res) => {
  try {
    const { id } = req.params;
    const { reply } = req.body;
    if (!reply) return res.status(400).json({ error: "reply required" });
    const r = await pool.query(
      `UPDATE grievances SET reply=$1, replied_at=now() WHERE id=$2 RETURNING *`,
      [reply, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, grievance: r.rows[0] });
  } catch (err) {
    console.error("POST /grievances/:id/reply error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Diary endpoints ----

// create a diary note: stores in DB and forwards to Telegram (so others can see)
app.post("/diary", async (req, res) => {
  try {
    const { username, title, body } = req.body;
    if (!body || !body.trim())
      return res.status(400).json({ error: "body required" });

    const id = Date.now().toString();
    const t = new Date().toISOString();

    await pool.query(
      `INSERT INTO diary_notes(id, username, title, body, created_at) VALUES($1,$2,$3,$4,$5)`,
      [id, username || null, title || null, body, t]
    );

    // forward to Telegram for group visibility
    let tgRes = null;
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      const text = `<b>Bittu's Diary</b>\n<b>${escapeHtml(
        title || "Untitled"
      )}</b>\n<i>${escapeHtml(
        new Date(t).toLocaleString()
      )}</i>\n\n${escapeHtml(body)}`;
      tgRes = await sendTelegramMessage(text, "HTML").catch((e) => ({
        ok: false,
        e,
      }));
    }

    res.json({
      ok: true,
      note: { id, username, title, body, created_at: t },
      telegram: tgRes,
    });
  } catch (err) {
    console.error("POST /diary error:", err);
    res.status(500).json({ error: err.message });
  }
});

// read recent diary notes (public)
app.get("/diary", async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "20")));
    const { rows } = await pool.query(
      `SELECT id, username, title, body, created_at FROM diary_notes ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /diary error:", err);
    res.status(500).json({ error: err.message });
  }
});

// optional admin-only delete diary note (via API)
// note: in production add auth (API key, OAuth, etc.)
app.delete("/diary/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const r = await pool.query(
      "DELETE FROM diary_notes WHERE id=$1 RETURNING *",
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, deleted: r.rows[0] });
  } catch (err) {
    console.error("DELETE /diary/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
