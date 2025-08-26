// server/index.js (ES modules)
// Run: node index.js  (ensure package.json has "type":"module")

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import pkg from "pg";
import multer from "multer";
import fs from "fs";
import path from "path";
import FormData from "form-data";

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
  process.env.TELEGRAM_ADMIN_ID
    ? "(set)"
    : "(missing (will default to CHAT_ID))"
);
console.log(
  "  DATABASE_URL: ",
  process.env.DATABASE_URL ? "(set)" : "(missing)"
);

const app = express();
app.use(cors());
// keep small JSON limit (diary body uses separate flow via POST /diary)
app.use(express.json({ limit: "200kb" }));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_ADMIN_ID =
  (process.env.TELEGRAM_ADMIN_ID || process.env.TELEGRAM_CHAT_ID || "") + "";
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

// Create / migrate tables if not exists and add audio columns if missing
const ensureTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grievances (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      text TEXT NOT NULL,
      reply TEXT,
      audio_url TEXT,
      telegram_file_id TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      replied_at TIMESTAMP WITH TIME ZONE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS moods (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      value INTEGER NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS diary_notes (
      id TEXT PRIMARY KEY,
      username TEXT,
      title TEXT,
      body TEXT,
      audio_url TEXT,
      telegram_file_id TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);

  // For safety on older installs: ensure columns exist (Postgres supports IF NOT EXISTS)
  await pool.query(
    `ALTER TABLE grievances ADD COLUMN IF NOT EXISTS audio_url TEXT;`
  );
  await pool.query(
    `ALTER TABLE grievances ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;`
  );
  await pool.query(
    `ALTER TABLE diary_notes ADD COLUMN IF NOT EXISTS audio_url TEXT;`
  );
  await pool.query(
    `ALTER TABLE diary_notes ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;`
  );
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

// Robust sendMessage with fallback: try parse_mode (if provided), if Telegram complains about entities, resend plain text
async function sendTelegramMessage(text, parse_mode = "HTML") {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("Telegram not configured - skipping send.");
    return { ok: false, reason: "no-telegram-config" };
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  // First attempt: send with parse_mode if requested
  let body = { chat_id: TELEGRAM_CHAT_ID, text };
  if (parse_mode) body.parse_mode = parse_mode;

  try {
    console.log("Telegram sendMessage request (attempt1):", {
      chat_id: TELEGRAM_CHAT_ID,
      length: String(text).length,
      parse_mode,
    });
    let resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = await resp.json().catch(() => ({ ok: false }));
    if (data.ok) return data;

    // If Telegram returned an entity parsing error, retry without parse_mode (plain text)
    const desc = (data.description || "").toString().toLowerCase();
    if (
      desc.includes("can't parse entities") ||
      desc.includes("unsupported start tag") ||
      desc.includes("can't parse")
    ) {
      console.warn(
        "Telegram parse error, retrying as plain text:",
        data.description
      );
      const p2 = { chat_id: TELEGRAM_CHAT_ID, text }; // plain text, no parse_mode
      const resp2 = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p2),
      });
      const data2 = await resp2.json().catch(() => ({ ok: false }));
      if (!data2.ok)
        console.error(
          "Telegram API error after fallback (sendMessage):",
          data2
        );
      return data2;
    }

    console.error("Telegram API error (sendMessage):", data);
    return data;
  } catch (err) {
    console.error("sendTelegramMessage error:", err);
    return { ok: false, error: err.message || String(err) };
  }
}

// Robust send to specific chat id (tries parse_mode then fallback)
async function sendTelegramTo(chatId, text, parse_mode = "HTML") {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("Telegram not configured - skipping sendTelegramTo.");
    return { ok: false, reason: "no-telegram-config" };
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    let body = { chat_id: chatId, text };
    if (parse_mode) body.parse_mode = parse_mode;
    console.log("Telegram sendMessage to specific chat (attempt1):", chatId, {
      length: String(text).length,
      parse_mode,
    });
    let resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = await resp.json().catch(() => ({ ok: false }));

    if (data.ok) return data;
    const desc = (data.description || "").toString().toLowerCase();
    if (
      desc.includes("can't parse entities") ||
      desc.includes("unsupported start tag") ||
      desc.includes("can't parse")
    ) {
      console.warn(
        "Telegram parse error for sendTelegramTo, retrying plain text:",
        data.description
      );
      const body2 = { chat_id: chatId, text };
      const r2 = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body2),
      });
      const d2 = await r2.json().catch(() => ({ ok: false }));
      if (!d2.ok)
        console.error(
          "Telegram API error after fallback (sendTelegramTo):",
          d2
        );
      return d2;
    }

    console.error("Telegram API error (sendTelegramTo):", data);
    return data;
  } catch (err) {
    console.error("sendTelegramTo error:", err);
    return { ok: false, error: err.message || String(err) };
  }
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
      if (!msg) continue;

      const fromChatId =
        msg.chat && msg.chat.id ? msg.chat.id.toString() : null;
      console.log("Telegram update:", {
        from: fromChatId,
        hasText: !!msg.text,
        hasVoice: !!msg.voice,
        hasAudio: !!msg.audio,
        caption: msg.caption ? msg.caption.slice(0, 100) : null,
      });

      // Accept commands in text or in caption for audio messages
      const rawText = (msg.text || msg.caption || "").trim();
      const text = rawText;

      // Admin-only commands: /clear and /confirm_clear — only allowed from TELEGRAM_ADMIN_ID (defaults to CHAT_ID)
      if (/^\/clear\b/i.test(text)) {
        if (fromChatId !== TELEGRAM_ADMIN_ID) {
          await sendTelegramTo(
            fromChatId,
            "⛔ You are not authorized to clear history.",
            null
          );
          continue;
        }
        await sendTelegramTo(
          fromChatId,
          "⚠️ Are you sure you want to delete ALL grievances, moods and diary notes? If yes, reply with:\n/confirm_clear\n\nThis action is irreversible.",
          null
        );
        continue;
      }

      if (/^\/confirm_clear\b/i.test(text)) {
        if (fromChatId !== TELEGRAM_ADMIN_ID) {
          await sendTelegramTo(
            fromChatId,
            "⛔ You are not authorized to clear history.",
            null
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
            `✅ Deleted ${deletedCountGrievances} grievances, ${deletedCountMoods} moods and ${deletedCountDiary} diary notes.`,
            null
          );
          console.log(`Admin ${fromChatId} cleared data`);
        } catch (err) {
          console.error("Failed to delete data:", err);
          await sendTelegramTo(
            fromChatId,
            `❌ Failed to delete data: ${err.message}`,
            null
          );
        }
        continue;
      }

      // delete_diary <id> (admin)
      const delDiaryMatch = text.match(/^delete_diary\s+(\S+)/i);
      if (delDiaryMatch) {
        if (fromChatId !== TELEGRAM_ADMIN_ID) {
          await sendTelegramTo(
            fromChatId,
            "⛔ You are not authorized to delete diary notes.",
            null
          );
          continue;
        }
        const delId = delDiaryMatch[1];
        try {
          const r = await pool.query(
            "DELETE FROM diary_notes WHERE id=$1 RETURNING *",
            [delId]
          );
          if (r.rowCount === 0) {
            await sendTelegramTo(
              fromChatId,
              `No diary note found with ID ${delId}.`,
              null
            );
          } else {
            await sendTelegramTo(
              fromChatId,
              `Deleted diary note ${delId}.`,
              null
            );
          }
        } catch (err) {
          await sendTelegramTo(
            fromChatId,
            `Failed to delete diary ${delId}: ${err.message}`,
            null
          );
        }
        continue;
      }

      // Parse replies: Accept in message text OR in caption (for audio/voice)
      const replyMatch = text.match(/^(?:reply)\s+(\S+)\s+([\s\S]+)/i);
      const idMatch = text.match(/^(?:id[:#]?)\s*(\S+)\s+([\s\S]+)/i);
      let id = null;
      let replyText = null;
      if (replyMatch) {
        id = replyMatch[1];
        replyText = replyMatch[2].trim();
      } else if (idMatch) {
        id = idMatch[1];
        replyText = idMatch[2].trim();
      }

      if (!id) {
        // Not a reply; if admin (i.e. TELEGRAM_ADMIN_ID) ask for help (send plain text to avoid parse issues)
        if (fromChatId === TELEGRAM_ADMIN_ID) {
          await sendTelegramTo(
            fromChatId,
            "Commands (examples):\nreply <GRIEVANCE_ID> <message>\n/clear to delete data\n/confirm_clear to confirm deletion\n\ndelete_diary <id>",
            null
          );
        }
        continue;
      }

      // We have an id and a reply text — record it in DB
      try {
        const q = `UPDATE grievances SET reply = $1, replied_at = now() WHERE id = $2 RETURNING *`;
        const r = await pool.query(q, [replyText, id]);
        if (r.rowCount === 0) {
          await sendTelegramTo(
            fromChatId,
            `No grievance found with ID ${id}.`,
            null
          );
          continue;
        }
        const updated = r.rows[0];
        // Confirm to admin
        await sendTelegramTo(
          fromChatId,
          `Reply recorded for grievance ID ${id}:\n\n${replyText}`,
          null
        );
        console.log(`Recorded reply for grievance ${id}`);
      } catch (err) {
        console.error("Failed to record reply:", err);
        await sendTelegramTo(
          fromChatId,
          `Failed to record reply for ${id}: ${err.message}`,
          null
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

// -------- STATIC uploads folder --------
const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

// -------- Multer for handling file uploads --------
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

// Helper: call Telegram getFile to get file_path -> return URL
async function telegramGetFileUrl(fileId) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  try {
    const gf = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(
        fileId
      )}`
    );
    const gj = await gf.json();
    if (!gj.ok || !gj.result || !gj.result.file_path) return null;
    const filePath = gj.result.file_path;
    const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
    return url;
  } catch (err) {
    console.warn("telegramGetFileUrl error:", err);
    return null;
  }
}

// Helper: upload local file to Telegram using sendVoice OR sendAudio depending on extension.
// Returns { ok:true, fileId, url, kind } or { ok:false, error }
async function uploadFileToTelegram(localFilePath, caption = null) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)
    return { ok: false, error: "no-telegram-config" };
  try {
    const ext = (path.extname(localFilePath) || "").toLowerCase();
    const voiceExts = new Set([".ogg", ".oga", ".opus"]);
    const useVoice = voiceExts.has(ext);
    const apiMethod = useVoice ? "sendVoice" : "sendAudio";
    const fieldName = useVoice ? "voice" : "audio";

    const form = new FormData();
    form.append("chat_id", TELEGRAM_CHAT_ID);
    if (caption) form.append("caption", caption);
    // try adding parse_mode for caption (Telegram accepts parse_mode with multipart in many cases)
    form.append("parse_mode", "HTML");
    form.append(fieldName, fs.createReadStream(localFilePath));

    console.log(
      `Uploading file to Telegram via ${apiMethod} (localPath=${localFilePath})`
    );
    const resp = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${apiMethod}`,
      {
        method: "POST",
        body: form,
        headers: form.getHeaders(),
      }
    );
    const j = await resp.json().catch(() => ({ ok: false }));
    if (!j.ok) {
      console.warn(`${apiMethod} failed:`, j);
      // Try fallback: send as multipart without parse_mode
      // (but usually this won't help; caller can fallback to sendMessage)
      return { ok: false, error: j };
    }

    const fileId =
      (j.result &&
        ((j.result.voice && j.result.voice.file_id) ||
          (j.result.audio && j.result.audio.file_id))) ||
      null;
    const url = fileId
      ? await telegramGetFileUrl(fileId).catch(() => null)
      : null;
    const kind = useVoice ? "voice" : "audio";
    return { ok: true, fileId, url, kind, raw: j };
  } catch (err) {
    console.warn("uploadFileToTelegram error:", err);
    return { ok: false, error: err.message || String(err) };
  }
}

// Helper: send an existing telegram file_id to chat trying voice then fallback to audio
async function sendTelegramFileIdWithFallback(fileId, caption = null) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)
    return { ok: false, error: "no-telegram-config" };
  try {
    // Attempt sendVoice (works for .ogg/opus etc.)
    let body = { chat_id: TELEGRAM_CHAT_ID, voice: fileId };
    if (caption) body.caption = caption;
    // try parse_mode too
    body.parse_mode = "HTML";
    let resp = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVoice`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    let j = await resp.json().catch(() => ({ ok: false }));
    if (j.ok) return { ok: true, kind: "voice", raw: j };

    // fallback to sendAudio
    body = { chat_id: TELEGRAM_CHAT_ID, audio: fileId };
    if (caption) body.caption = caption;
    body.parse_mode = "HTML";
    resp = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendAudio`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    j = await resp.json().catch(() => ({ ok: false }));
    if (j.ok) return { ok: true, kind: "audio", raw: j };

    // if both fail, return the last error
    return { ok: false, error: { voiceAttempt: j } };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// -------- Endpoints --------

// health
app.get("/", (req, res) => res.json({ ok: true }));

// read grievances (ordered oldest-first)
app.get("/grievances", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, text, reply, audio_url, telegram_file_id, created_at, replied_at FROM grievances ORDER BY created_at ASC`
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
    // safe: escape username parts
    const text = `✅ Login: ${escapeHtml(
      username
    )} (${new Date().toLocaleString()})`;
    const tg = await sendTelegramMessage(text, "HTML");
    res.json({ ok: true, telegram: tg });
  } catch (err) {
    console.error("/notify error:", err);
    res.status(500).json({ error: err.message });
  }
});

// create grievance (accept optional audio_url and telegram_file_id)
app.post("/grievances", async (req, res) => {
  try {
    const { username, text, audio_url, telegram_file_id } = req.body;
    if (!username || !text)
      return res.status(400).json({ error: "username and text required" });

    const id = Date.now().toString();
    const created_at = new Date().toISOString();

    await pool.query(
      `INSERT INTO grievances(id, username, text, audio_url, telegram_file_id, created_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        id,
        username,
        text,
        audio_url || null,
        telegram_file_id || null,
        created_at,
      ]
    );

    // forward to Telegram for group visibility (robust handling)
    let tgRes = null;
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      try {
        const caption = `<b>New grievance</b>\nFrom: ${escapeHtml(
          username
        )}\nID: ${escapeHtml(id)}`;
        if (telegram_file_id) {
          // try send by file_id and fallback
          tgRes = await sendTelegramFileIdWithFallback(
            telegram_file_id,
            caption
          );
          if (!tgRes.ok) {
            console.warn("sendTelegramFileIdWithFallback failed:", tgRes);
            // fallback to plain text message
            tgRes = await sendTelegramMessage(
              `<b>New grievance</b>\nFrom: ${escapeHtml(
                username
              )}\nID: ${escapeHtml(id)}\n\n${escapeHtml(text)}`,
              "HTML"
            );
          }
        } else if (audio_url && String(audio_url).startsWith("/")) {
          // local file path served from /uploads -> upload and send
          const localPath = path.join(
            process.cwd(),
            audio_url.replace(/^\//, "")
          );
          if (fs.existsSync(localPath)) {
            const upl = await uploadFileToTelegram(localPath, caption);
            if (!upl.ok) {
              console.warn("uploadFileToTelegram failed:", upl);
              tgRes = await sendTelegramMessage(
                `<b>New grievance</b>\nFrom: ${escapeHtml(
                  username
                )}\nID: ${escapeHtml(id)}\n\n${escapeHtml(text)}`,
                "HTML"
              );
            } else {
              tgRes = { ok: true, note: "uploaded and sent", file: upl };
            }
          } else {
            console.warn("Local audio path not found:", localPath);
            tgRes = await sendTelegramMessage(
              `<b>New grievance</b>\nFrom: ${escapeHtml(
                username
              )}\nID: ${escapeHtml(id)}\n\n${escapeHtml(text)}`,
              "HTML"
            );
          }
        } else {
          // fallback: send text message
          const textMsg = `<b>New grievance</b>\nFrom: ${escapeHtml(
            username
          )}\nID: ${escapeHtml(id)}\n\n${escapeHtml(text)}`;
          tgRes = await sendTelegramMessage(textMsg, "HTML");
        }
      } catch (e) {
        console.error("Telegram forward error (grievance):", e);
        tgRes = { ok: false, e: String(e) };
      }
    } else {
      console.warn("Telegram not configured - skipping send for grievance");
      tgRes = { ok: false, reason: "no-telegram-config" };
    }

    res.json({
      ok: true,
      grievance: {
        id,
        username,
        text,
        audio_url: audio_url || null,
        telegram_file_id: telegram_file_id || null,
        created_at,
      },
      telegram: tgRes,
    });
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

    // Notify admin via Telegram (try HTML then fallback)
    const tgText = `📊 Mood update from ${escapeHtml(
      username
    )}: ${v}/10\n\nAt: ${escapeHtml(
      new Date(row.created_at).toLocaleString()
    )}\nID: ${row.id}`;
    const tg = await sendTelegramMessage(tgText, "HTML").catch((e) => ({
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
// (unchanged from your code, with safe forwarding using sendTelegramMessage/sendTelegramFileIdWithFallback)
app.post("/diary", async (req, res) => {
  try {
    const { username, title, body, audio_url, telegram_file_id } = req.body;
    if (!body || !body.trim())
      return res.status(400).json({ error: "body required" });

    const id = Date.now().toString();
    const t = new Date().toISOString();

    await pool.query(
      `INSERT INTO diary_notes(id, username, title, body, audio_url, telegram_file_id, created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        username || null,
        title || null,
        body,
        audio_url || null,
        telegram_file_id || null,
        t,
      ]
    );

    let tgRes = null;
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      try {
        const captionText = `<b>Bittu's Diary</b>\n${escapeHtml(
          title || "Untitled"
        )}`;
        if (telegram_file_id) {
          tgRes = await sendTelegramFileIdWithFallback(
            telegram_file_id,
            captionText
          );
          if (!tgRes.ok) {
            console.warn(
              "sendTelegramFileIdWithFallback (diary) failed:",
              tgRes
            );
            tgRes = await sendTelegramMessage(
              `<b>Bittu's Diary</b>\n<b>${escapeHtml(
                title || "Untitled"
              )}</b>\n<i>${escapeHtml(
                new Date(t).toLocaleString()
              )}</i>\n\n${escapeHtml(body)}`,
              "HTML"
            );
          }
        } else if (audio_url && String(audio_url).startsWith("/")) {
          const localPath = path.join(
            process.cwd(),
            audio_url.replace(/^\//, "")
          );
          if (fs.existsSync(localPath)) {
            const upl = await uploadFileToTelegram(localPath, captionText);
            if (!upl.ok) {
              console.warn("uploadFileToTelegram (diary) failed:", upl);
              tgRes = await sendTelegramMessage(
                `<b>Bittu's Diary</b>\n<b>${escapeHtml(
                  title || "Untitled"
                )}</b>\n<i>${escapeHtml(
                  new Date(t).toLocaleString()
                )}</i>\n\n${escapeHtml(body)}`,
                "HTML"
              );
            } else {
              tgRes = { ok: true, note: "uploaded and sent", file: upl };
            }
          } else {
            console.warn("Local diary audio path not found:", localPath);
            tgRes = await sendTelegramMessage(
              `<b>Bittu's Diary</b>\n<b>${escapeHtml(
                title || "Untitled"
              )}</b>\n<i>${escapeHtml(
                new Date(t).toLocaleString()
              )}</i>\n\n${escapeHtml(body)}`,
              "HTML"
            );
          }
        } else {
          const text = `<b>Bittu's Diary</b>\n<b>${escapeHtml(
            title || "Untitled"
          )}</b>\n<i>${escapeHtml(
            new Date(t).toLocaleString()
          )}</i>\n\n${escapeHtml(body)}`;
          tgRes = await sendTelegramMessage(text, "HTML");
        }
      } catch (e) {
        console.error("Telegram forward error (diary):", e);
        tgRes = { ok: false, e: String(e) };
      }
    } else {
      console.warn("Telegram not configured - skipping diary forward");
      tgRes = { ok: false, reason: "no-telegram-config" };
    }

    res.json({
      ok: true,
      note: {
        id,
        username,
        title,
        body,
        audio_url: audio_url || null,
        telegram_file_id: telegram_file_id || null,
        created_at: t,
      },
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
      `SELECT id, username, title, body, audio_url, telegram_file_id, created_at FROM diary_notes ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /diary error:", err);
    res.status(500).json({ error: err.message });
  }
});

// optional admin-only delete diary note (via API)
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

// -------- Upload audio endpoint (used by frontend) --------
// Accepts multipart/form-data with field "file"
app.post("/upload-audio", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ ok: false, error: "file required" });

    // local URL served by express.static
    const localUrl = `/uploads/${path.basename(req.file.path)}`;

    let telegramFileId = null;
    let telegramUrl = null;

    // If Telegram configured, upload file to Telegram and get file_id & file url
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      const localPath = req.file.path;
      const upl = await uploadFileToTelegram(localPath);
      if (upl.ok) {
        telegramFileId = upl.fileId;
        telegramUrl = upl.url || null;
      } else {
        console.warn(
          "upload-audio -> uploadFileToTelegram returned error:",
          upl
        );
      }
    }

    res.json({ ok: true, localUrl, telegramFileId, telegramUrl });
  } catch (err) {
    console.error("/upload-audio error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET telegram file helper: returns a JSON with downloadable URL for a telegram file_id
app.get("/telegram/file/:file_id", async (req, res) => {
  try {
    const fileId = req.params.file_id;
    if (!fileId)
      return res.status(400).json({ ok: false, error: "file_id required" });
    const url = await telegramGetFileUrl(fileId);
    if (!url)
      return res
        .status(404)
        .json({ ok: false, error: "not found or telegram not configured" });
    res.json({ ok: true, url });
  } catch (err) {
    console.error("GET /telegram/file/:file_id error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Start server ----------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
