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
  "  DATABASE_URL: ",
  process.env.DATABASE_URL ? "(set)" : "(missing)"
);

const app = express();
app.use(cors());
app.use(express.json());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // used for notifications
// ADMIN ID: who is allowed to run /clear (fallback to TELEGRAM_CHAT_ID)
const TELEGRAM_ADMIN_ID =
  (process.env.TELEGRAM_ADMIN_ID || TELEGRAM_CHAT_ID) + "";

const DATABASE_URL = process.env.DATABASE_URL;

// Postgres pool
if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing. Set it in .env or Render env.");
  process.exit(1);
}
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Create table if not exists
const ensureTable = async () => {
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
};
ensureTable().catch((e) => {
  console.error("Failed to ensure table:", e);
  process.exit(1);
});

// Helper: send message to the configured admin chat (used for notifications)
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("Telegram not configured - skipping send.");
    return { ok: false, reason: "no-telegram-config" };
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  });
  const data = await resp.json();
  if (!data.ok) console.error("Telegram API error:", data);
  return data;
}

// Helper: send message to a specific chat id (useful to reply to the chat which sent a command)
async function sendTelegramTo(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("Telegram not configured - skipping sendTelegramTo.");
    return { ok: false, reason: "no-telegram-config" };
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const data = await resp.json();
  if (!data.ok) console.error("Telegram API error:", data);
  return data;
}

// Polling getUpdates for replies and admin commands
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

      // -----------------------
      // Admin clear flow
      // -----------------------
      // If admin sends "/clear" -> ask for confirmation (reply with /confirm_clear)
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
          "⚠️ Are you sure you want to delete ALL grievances? If yes, reply with:\n/confirm_clear\n\nThis action is irreversible."
        );
        continue;
      }

      // If admin sends "/confirm_clear" -> perform deletion
      if (/^\/confirm_clear\b/i.test(text)) {
        if (fromChatId !== TELEGRAM_ADMIN_ID) {
          await sendTelegramTo(
            fromChatId,
            "⛔ You are not authorized to clear history."
          );
          continue;
        }

        try {
          const delRes = await pool.query("DELETE FROM grievances");
          const deletedCount = delRes.rowCount || 0;
          await sendTelegramTo(
            fromChatId,
            `✅ Deleted ${deletedCount} grievance(s).`
          );
          console.log(
            `Admin ${fromChatId} cleared ${deletedCount} grievances.`
          );
        } catch (err) {
          console.error("Failed to delete grievances:", err);
          await sendTelegramTo(
            fromChatId,
            `❌ Failed to delete grievances: ${err.message}`
          );
        }
        continue;
      }

      // -----------------------
      // Normal reply parsing (reply <ID> <message> or id:<ID> <message>)
      // -----------------------
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
        // Not a recognized command — optionally nudge admin for proper format
        // We'll only send the nudge to admin to avoid spamming others
        if (fromChatId === TELEGRAM_ADMIN_ID) {
          await sendTelegramTo(
            fromChatId,
            "To reply to a grievance, send:\nreply <GRIEVANCE_ID> <your message>\n\nOr to clear all history send:\n/clear"
          );
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

// read grievances (ordered newest first)
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

// notify (login)
app.post("/notify", async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "username required" });
    const tg = await sendTelegramMessage(
      `✅ Login: ${username} (${new Date().toLocaleString()})`
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
    // notify admin with ID
    const tg = await sendTelegramMessage(
      `📢 New grievance from ${username}:\n\n${text}\n\nID: ${id}\n\nReply using:\nreply ${id} <your message>`
    ).catch((e) => ({ ok: false, e }));
    res.json({ ok: true, grievance: { id, username, text }, telegram: tg });
  } catch (err) {
    console.error("POST /grievances error:", err);
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
