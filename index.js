const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
require("dotenv").config();

const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

// --- OPTIONAL UPSTASH REDIS SETUP (FALLS BACK TO MEMORY IF UNSET) ---
let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const { Redis } = require("@upstash/redis");
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
} else {
  console.log("[DB] Upstash Redis env vars not set; using in-memory fallback.");
}

const memoryWallets = new Map();
const memorySavedPolls = new Map();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

const PORT = process.env.PORT || 3000;
const SLOT_SECONDS = 30;
const SLOT_PRICE_CENTS = 100;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB max
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.set("trust proxy", 1);

// --- SOLANA PAYMENT SETUP ---
const MASTER_WALLET = new PublicKey(
  process.env.MASTER_WALLET_ADDRESS || "9SxTNp2FiRHTotGLZhDsN5oMVrCb7Ln16mfo6Jx6LTLZ"
);
const connection = new Connection(
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  "confirmed"
);
const paymentSessions = new Map();

// --- FAST PRICING ENGINE ---
async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function getLiveSolPrice() {
  try {
    const res = await fetchWithTimeout("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
    const data = await res.json();
    if (data.price) return parseFloat(data.price);
  } catch {}

  try {
    const res = await fetchWithTimeout("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const data = await res.json();
    if (data.solana && data.solana.usd) return parseFloat(data.solana.usd);
  } catch {}

  return 175.0; // Fallback price
}

async function sweepToMaster(fromKeypair, currentBalance) {
  try {
    const balanceBigInt = BigInt(currentBalance);
    const feeBigInt = BigInt(5000);
    const sweepAmount = balanceBigInt - feeBigInt;
    if (sweepAmount <= 0n) return;

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromKeypair.publicKey,
        toPubkey: MASTER_WALLET,
        lamports: sweepAmount,
      })
    );
    await sendAndConfirmTransaction(connection, tx, [fromKeypair]);
    console.log(`🧹 Swept ${(Number(sweepAmount) / LAMPORTS_PER_SOL).toFixed(6)} SOL to Master Wallet!`);
  } catch (err) {
    console.error("[SWEEP ERROR]", err.message);
  }
}

// --- USER WALLET MANAGEMENT ---
async function getOrCreateWallet(deviceId) {
  if (!deviceId) throw new Error("No device ID");

  if (redis) {
    try {
      const storedKey = await redis.get(`wallet:${deviceId}`);
      if (storedKey) {
        const secretArray = typeof storedKey === "string" ? JSON.parse(storedKey) : storedKey;
        if (Array.isArray(secretArray) && secretArray.length === 64) {
          return Keypair.fromSecretKey(Uint8Array.from(secretArray));
        }
      }
    } catch (e) {
      console.error("[REDIS GET ERROR]", e.message);
    }
  } else if (memoryWallets.has(deviceId)) {
    return memoryWallets.get(deviceId);
  }

  console.log(`[WALLET] Creating NEW wallet for ${deviceId}`);
  const newKeypair = Keypair.generate();

  if (redis) {
    try {
      const secretArray = Array.from(newKeypair.secretKey);
      await redis.set(`wallet:${deviceId}`, JSON.stringify(secretArray));
    } catch (e) {
      console.error("[REDIS SET ERROR]", e.message);
    }
  } else {
    memoryWallets.set(deviceId, newKeypair);
  }

  return newKeypair;
}

// --- TELEGRAM MODERATION SETUP ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_ENABLED = Boolean(TELEGRAM_TOKEN && ADMIN_CHAT_ID);
const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendTelegramMessage(caption, inlineKeyboard) {
  if (!TELEGRAM_ENABLED) return;
  try {
    await fetch(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        text: caption,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: inlineKeyboard },
      }),
    });
  } catch (err) {
    console.error("[TG SEND ERROR]", err.message);
  }
}

async function sendTelegramDocument(filePath, caption, inlineKeyboard, fallbackUrl = null) {
  if (!TELEGRAM_ENABLED) return;
  try {
    const fileSize = fs.statSync(filePath).size;
    if (fileSize > 48 * 1024 * 1024) {
      const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
      const linkText = fallbackUrl
        ? `\n\nLarge Image (${sizeMB}MB) - Review here:\n${fallbackUrl}`
        : `\n\n(File is ${sizeMB}MB - too large for Telegram preview)`;
      return sendTelegramMessage(caption + linkText, inlineKeyboard);
    }

    const fileBuffer = fs.readFileSync(filePath);
    const form = new FormData();
    form.append("chat_id", ADMIN_CHAT_ID);
    form.append("caption", caption);
    form.append("parse_mode", "Markdown");
    form.append("document", new Blob([fileBuffer]), path.basename(filePath));
    form.append("reply_markup", JSON.stringify({ inline_keyboard: inlineKeyboard }));

    const tgRes = await fetch(`${TG_API}/sendDocument`, { method: "POST", body: form });
    if (!tgRes.ok) {
      const linkText = fallbackUrl ? `\n\nReview file here:\n${fallbackUrl}` : "";
      await sendTelegramMessage(caption + linkText, inlineKeyboard);
    }
  } catch (err) {
    console.error("[TG MEDIA ERROR]", err.message);
    if (fallbackUrl) sendTelegramMessage(`${caption}\n\nReview file here:\n${fallbackUrl}`, inlineKeyboard);
  }
}

let lastUpdateId = 0;
async function pollTelegram() {
  if (!TELEGRAM_ENABLED) return;
  while (true) {
    try {
      const res = await fetch(`${TG_API}/getUpdates?offset=${lastUpdateId}&timeout=30`);
      const data = await res.json();

      if (data.ok && Array.isArray(data.result) && data.result.length > 0) {
        for (const update of data.result) {
          lastUpdateId = update.update_id + 1;
          if (update.callback_query) {
            handleTelegramAction(update.callback_query);
          }
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}

// --- DATABASE STATE (RAM + UPSTASH REDIS) ---
const emptyDb = () => ({ queue: [], archive: [], active: null, pending: [] });
let db = emptyDb();

async function bootDatabase() {
  if (!redis) return;
  try {
    const savedData = await redis.get("spotlight:db");
    if (savedData) {
      db = { ...emptyDb(), ...savedData };
      console.log("[DB] Loaded state from Upstash Redis");
    }
  } catch (err) {
    console.error("[DB ERROR] Could not connect to Upstash Redis:", err.message);
  }
}

function saveDb() {
  if (!redis) return;
  redis.set("spotlight:db", db).catch((err) => {
    console.error("[DB ERROR] Failed to save state to Upstash:", err.message);
  });
}

// --- UTILITIES ---
function id() {
  return crypto.randomBytes(8).toString("hex");
}

function cleanText(value, max = 180) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function publicPollData(pollData) {
  if (!pollData) return null;
  return {
    options: pollData.options.map((o) => ({ id: o.id, text: o.text, votes: o.votes })),
    totalVotes: pollData.totalVotes || 0,
  };
}

function publicSpotlight(item, clientId = null) {
  if (!item) return null;
  const reactions = item.reactions || {};
  const pollVotes = item.pollData && Array.isArray(item.pollData.votedMap) ? item.pollData.votedMap : [];

  const result = {
    id: item.id,
    username: item.username,
    type: item.type,
    text: item.text,
    mediaUrl: item.mediaUrl,
    linkUrl: item.linkUrl,
    pollData: publicPollData(item.pollData),
    likes: item.likes || 0,
    dislikes: item.dislikes || 0,
    createdAt: item.createdAt,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
  };

  if (clientId) {
    result.myReaction = reactions[clientId] || null;
    const foundVote = pollVotes.find((v) => v.clientId === clientId);
    result.myPollVote = foundVote ? foundVote.optionId : null;
  }

  return result;
}

let viewersCount = 0;

function stateSnapshot(clientId = null) {
  return {
    active: publicSpotlight(db.active, clientId),
    nextMediaUrl: db.queue[0] && db.queue[0].mediaUrl ? db.queue[0].mediaUrl : null,
    queue: db.queue.slice(0, 30).map((x, i) => ({
      id: x.id,
      username: x.username,
      type: x.type,
      position: i + 1,
    })),
    queueCount: db.queue.length,
    archive: db.archive.slice(0, 24).map((x) => publicSpotlight(x)),
    slotSeconds: SLOT_SECONDS,
    priceCents: SLOT_PRICE_CENTS,
    viewersCount,
    serverTime: Date.now(),
  };
}

function deleteMedia(mediaUrl) {
  if (!mediaUrl || !String(mediaUrl).startsWith("/uploads/")) return;
  const filename = path.basename(mediaUrl);
  const filePath = path.join(UPLOAD_DIR, filename);
  fs.unlink(filePath, (err) => {
    if (!err) console.log(`[TRASHED] Ephemeral image deleted: ${filename}`);
  });
}

// --- EXPRESS SETUP ---
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "1d", immutable: true }));

app.get("/", (req, res, next) => {
  const publicIndex = path.join(__dirname, "public", "index.html");
  const rootIndex = path.join(__dirname, "index.html");
  if (fs.existsSync(publicIndex)) return res.sendFile(publicIndex);
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  next();
});

app.get("/api/state", (req, res) => res.json(stateSnapshot()));

app.post("/api/init-payment", async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    if (!deviceId || typeof deviceId !== "string") {
      return res.status(400).json({ error: "Missing device ID" });
    }
    const keypair = await getOrCreateWallet(deviceId.slice(0, 64));
    res.json({ depositAddress: keypair.publicKey.toBase58() });
  } catch {
    res.status(500).json({ error: "Init error" });
  }
});

// --- MULTER STORAGE ---
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    cb(null, `${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`);
  },
});

const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const upload = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (_, file, cb) => {
    if (allowedImageTypes.has(file.mimetype)) {
      return cb(null, true);
    }
    return cb(new Error("Only JPG, PNG, GIF, and WebP images are supported."));
  },
});

// --- PRE-UPLOAD IMAGE ROUTE ---
app.post("/api/upload-media", (req, res) => {
  upload.single("media")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "Image is too large. Maximum allowed size is 8MB." });
      }
      return res.status(400).json({ error: err.message || "Invalid image upload." });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded or format not allowed (JPG, PNG, GIF, WebP)." });
    }
    if (!req.file.mimetype.startsWith("image/") || req.file.size > MAX_IMAGE_BYTES) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "Only images up to 8MB are allowed." });
    }

    res.json({
      ok: true,
      mediaUrl: `/uploads/${req.file.filename}`,
      mediaPath: req.file.path,
      filename: req.file.originalname,
      size: req.file.size,
    });
  });
});

// --- SUBMIT SPOTLIGHT & PREPARE SOLANA PAYMENT ---
app.post("/api/submit", (req, res, next) => {
  if (req.is("multipart/form-data")) {
    upload.single("media")(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ error: "Image is too large. Maximum size is 8MB." });
        }
        return res.status(400).json({ error: err.message || "Invalid file upload." });
      }
      next();
    });
  } else {
    next();
  }
}, async (req, res) => {
  try {
    if (db.queue.length >= 50) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(429).json({ error: "The queue is currently full. Please try again in a minute." });
    }

    const deviceId = cleanText(req.body?.deviceId, 64);
    if (!deviceId) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "Missing device ID. Please refresh and try again." });
    }

    const username = cleanText(req.body?.username || "", 20);
    if (username.length < 2 || !/^[a-zA-Z0-9_.\s-]+$/.test(username)) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "Name must be 2–20 characters (letters, numbers, spaces, _ . -)." });
    }

    const type = cleanText(req.body?.type || "text", 12);
    if (!["text", "media", "poll"].includes(type)) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "Invalid spotlight type." });
    }

    const text = cleanText(req.body?.text, type === "poll" ? 120 : 180);

    let mediaUrl = null;
    let mediaPath = null;

    // Allow image attachment on both 'media' (required) and 'poll' (optional)
    if (type === "media" || type === "poll") {
      const preMediaUrl = cleanText(req.body?.preMediaUrl, 250);

      if (preMediaUrl && preMediaUrl.startsWith("/uploads/")) {
        const filename = path.basename(preMediaUrl);
        const expectedPath = path.join(UPLOAD_DIR, filename);
        if (fs.existsSync(expectedPath)) {
          mediaUrl = `/uploads/${filename}`;
          mediaPath = expectedPath;
        }
      } else if (req.file) {
        mediaUrl = `/uploads/${req.file.filename}`;
        mediaPath = req.file.path;
      }

      if (type === "media" && !mediaUrl) {
        return res.status(400).json({ error: "Please upload an image (JPG, PNG, GIF, or WebP)." });
      }
    } else if (req.file) {
      fs.unlink(req.file.path, () => {});
    }

    if (type === "text" && (!text || text.length < 3)) {
      return res.status(400).json({ error: "Message must be at least 3 characters long." });
    }

    let pollData = null;
    if (type === "poll") {
      if (!text || text.length < 5) {
        return res.status(400).json({ error: "Poll question must be at least 5 characters long." });
      }
      const opts = [req.body?.pollOpt1, req.body?.pollOpt2, req.body?.pollOpt3, req.body?.pollOpt4]
        .map((t) => cleanText(t, 35))
        .filter((t) => t.length > 0);

      if (opts.length < 2) {
        return res.status(400).json({ error: "Polls require at least 2 options." });
      }

      pollData = {
        options: opts.map((opt, i) => ({ id: i, text: opt, votes: 0 })),
        totalVotes: 0,
        votedIps: [],
        votedMap: [],
      };
    }

    const rawUrl = String(req.body?.linkUrl || "").trim().slice(0, 250);
    let linkUrl = null;
    if (rawUrl) {
      const withProtocol = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
      try {
        const parsed = new URL(withProtocol);
        if (["http:", "https:"].includes(parsed.protocol)) {
          linkUrl = parsed.toString();
        } else {
          return res.status(400).json({ error: "Links must start with http:// or https://" });
        }
      } catch {
        return res.status(400).json({ error: "Please enter a valid URL (e.g. https://example.com)." });
      }
    }

    const publicBase = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
    const mediaFullUrl = mediaUrl ? `${publicBase}${mediaUrl}` : null;

    const item = {
      id: id(),
      username,
      type,
      text,
      mediaUrl,
      linkUrl,
      mediaPath,
      mediaFullUrl,
      pollData,
      createdAt: Date.now(),
      paymentStatus: "pending",
    };

    const keypair = await getOrCreateWallet(deviceId);
    const depositAddress = keypair.publicKey.toBase58();

    let currentBalance = 0;
    try {
      const rawBal = await connection.getBalance(keypair.publicKey);
      currentBalance = Number(rawBal);
    } catch {}

    const solPrice = await getLiveSolPrice();
    const solAmountStr = (1.0 / solPrice).toFixed(4);
    const requiredLamports = Math.floor(parseFloat(solAmountStr) * LAMPORTS_PER_SOL) + currentBalance;

    paymentSessions.set(depositAddress, { item, requiredLamports, keypair, createdAt: Date.now() });

    res.json({
      ok: true,
      depositAddress,
      solAmount: solAmountStr,
      solPrice: solPrice.toFixed(2),
      qrUrl: `solana:${depositAddress}?amount=${solAmountStr}&label=Spotlight`,
      itemId: item.id,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// Cleanup stale payment sessions older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [addr, session] of paymentSessions.entries()) {
    if (session.createdAt < cutoff) {
      if (session.item.paymentStatus !== "paid" && session.item.mediaUrl) {
        deleteMedia(session.item.mediaUrl);
      }
      paymentSessions.delete(addr);
    }
  }
}, 15 * 60 * 1000).unref();

// --- CHECK PAYMENT & SEND TO MODERATION ---
app.get("/api/check-payment/:address", async (req, res) => {
  const depositAddress = req.params.address;
  const session = paymentSessions.get(depositAddress);

  if (!session) return res.status(404).json({ error: "Session expired or not found" });
  if (session.item.paymentStatus === "paid") {
    return res.json({ paid: true, autoApproved: !TELEGRAM_ENABLED });
  }

  try {
    const pubkey = new PublicKey(depositAddress);
    const rawBalance = await connection.getBalance(pubkey);
    const balance = Number(rawBalance);

    if (balance >= session.requiredLamports) {
      session.item.paymentStatus = "paid";
      paymentSessions.set(depositAddress, session);

      sweepToMaster(session.keypair, balance);

      if (TELEGRAM_ENABLED) {
        db.pending.push(session.item);
        saveDb();

        const pollStr =
          session.item.type === "poll"
            ? `\nPoll Options:\n` + session.item.pollData.options.map((o) => `- ${o.text}`).join("\n")
            : "";
        const caption = `🔥 *New Paid Submission*\nUser: @${session.item.username}\nType: ${session.item.type}\nText: ${
          session.item.text || "N/A"
        }\nLink: ${session.item.linkUrl || "N/A"}${pollStr}`;
        const buttons = [
          [
            { text: "✅ Approve", callback_data: `approve_${session.item.id}` },
            { text: "❌ Reject", callback_data: `reject_${session.item.id}` },
          ],
        ];

        // Send image attachment for both media posts AND polls with an attached image
        if (session.item.mediaPath) {
          sendTelegramDocument(session.item.mediaPath, caption, buttons, session.item.mediaFullUrl);
        } else {
          sendTelegramMessage(caption, buttons);
        }

        return res.json({ paid: true, autoApproved: false });
      } else {
        console.log(`[MODERATION] Telegram not configured; auto-approving @${session.item.username}`);
        db.queue.push(session.item);
        saveDb();
        io.emit("state", stateSnapshot());
        io.emit("submission-status", { id: session.item.id, status: "approved" });
        if (!db.active) advanceSpotlight();
        return res.json({ paid: true, autoApproved: true });
      }
    }
  } catch {
    // Ignore transient RPC fetch errors
  }

  res.json({ paid: false });
});

// --- TELEGRAM ACTION HANDLER ---
async function handleTelegramAction(query) {
  const action = query.data;
  const msg = query.message;
  if (!action || !action.includes("_")) return;

  const [decision, itemId] = action.split("_");
  const pendingIndex = db.pending.findIndex((i) => i.id === itemId);

  fetch(`${TG_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: query.id }),
  }).catch(() => {});

  if (pendingIndex === -1) return;

  const item = db.pending[pendingIndex];
  db.pending.splice(pendingIndex, 1);

  if (msg && msg.chat) {
    fetch(`${TG_API}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: { inline_keyboard: [] },
      }),
    }).catch(() => {});
  }

  if (decision === "approve") {
    db.queue.push(item);
    saveDb();
    io.emit("state", stateSnapshot());
    io.emit("submission-status", { id: item.id, status: "approved" });
    if (!db.active) advanceSpotlight();
    sendTelegramMessage(`✅ Approved @${item.username}`, []);
  } else if (decision === "reject") {
    if (item.mediaUrl) deleteMedia(item.mediaUrl);
    saveDb();
    io.emit("submission-status", { id: item.id, status: "rejected" });
    sendTelegramMessage(`❌ Rejected @${item.username}`, []);
  }
}

// --- LIVE POLLING ROUTES ---
app.post("/api/vote", (req, res) => {
  const { itemId, optionId, deviceId } = req.body || {};
  if (!db.active || db.active.id !== itemId || db.active.type !== "poll") {
    return res.status(400).json({ error: "Poll is no longer active." });
  }

  const voterId = String(deviceId || req.ip);
  if (db.active.pollData.votedIps.includes(voterId)) {
    return res.status(400).json({ error: "You already voted on this poll." });
  }

  const parsedOptionId = parseInt(optionId, 10);
  const opt = db.active.pollData.options.find((o) => o.id === parsedOptionId);
  if (!opt) return res.status(400).json({ error: "Invalid option." });

  opt.votes++;
  db.active.pollData.totalVotes++;
  db.active.pollData.votedIps.push(voterId);
  if (!Array.isArray(db.active.pollData.votedMap)) db.active.pollData.votedMap = [];
  db.active.pollData.votedMap.push({ clientId: voterId, optionId: parsedOptionId });

  io.emit("poll-update", {
    itemId,
    options: db.active.pollData.options,
    totalVotes: db.active.pollData.totalVotes,
  });

  saveDb();
  res.json({ ok: true });
});

app.get("/api/poll/:id", async (req, res) => {
  try {
    let data = null;
    if (redis) {
      data = await redis.hget("saved_polls", req.params.id);
    } else {
      data = memorySavedPolls.get(req.params.id) || null;
    }
    if (!data) return res.status(404).json({ error: "Poll not found." });
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    res.json(publicPollData(parsed));
  } catch {
    res.status(500).json({ error: "Server error." });
  }
});

// --- SPOTLIGHT ENGINE ---
function advanceSpotlight() {
  if (db.active) {
    if (db.active.type === "poll" && db.active.pollData) {
      const cleanPoll = publicPollData(db.active.pollData);
      if (redis) {
        redis
          .hset("saved_polls", { [db.active.id]: cleanPoll })
          .catch((e) => console.error("Poll Save Error:", e));
      } else {
        memorySavedPolls.set(db.active.id, cleanPoll);
      }
    }

    db.archive.unshift({ ...db.active, endedAt: Date.now() });
    db.archive = db.archive.slice(0, 100);
    if (db.active.mediaUrl) deleteMedia(db.active.mediaUrl);
  }

  const next = db.queue.shift();
  if (next) {
    next.startsAt = Date.now();
    next.endsAt = next.startsAt + SLOT_SECONDS * 1000;
    next.likes = 0;
    next.dislikes = 0;
    next.reactions = {}; // clientId -> 'like' | 'dislike'
    db.active = next;
  } else {
    db.active = null;
  }

  saveDb();
  io.emit("state", stateSnapshot());
}

function tick() {
  if (db.active && Date.now() >= db.active.endsAt) advanceSpotlight();
  else if (!db.active && db.queue.length) advanceSpotlight();
}
setInterval(tick, 500);

// --- SOCKETS & LIVE VIEWERS ---
io.on("connection", (socket) => {
  viewersCount++;
  const clientId =
    typeof socket.handshake.auth?.clientId === "string" &&
    socket.handshake.auth.clientId.length <= 64
      ? socket.handshake.auth.clientId
      : socket.id;

  io.emit("viewers-count", viewersCount);
  socket.emit("state", stateSnapshot(clientId));

  socket.on("request-state", () => {
    socket.emit("state", stateSnapshot(clientId));
  });

  socket.on("spotlight:react", (payload) => {
    if (!payload || typeof payload !== "object") return;
    const { postId, type } = payload;

    if (!db.active || db.active.id !== postId) return;
    if (type !== "like" && type !== "dislike") return;

    if (!db.active.reactions || typeof db.active.reactions !== "object") {
      db.active.reactions = {};
    }
    if (typeof db.active.likes !== "number") db.active.likes = 0;
    if (typeof db.active.dislikes !== "number") db.active.dislikes = 0;

    const previous = db.active.reactions[clientId];

    if (previous === type) {
      delete db.active.reactions[clientId];
      if (type === "like") db.active.likes = Math.max(0, db.active.likes - 1);
      else db.active.dislikes = Math.max(0, db.active.dislikes - 1);
    } else {
      if (previous === "like") db.active.likes = Math.max(0, db.active.likes - 1);
      if (previous === "dislike") db.active.dislikes = Math.max(0, db.active.dislikes - 1);

      db.active.reactions[clientId] = type;
      if (type === "like") db.active.likes++;
      else db.active.dislikes++;
    }

    const pollVotes = db.active.pollData && Array.isArray(db.active.pollData.votedMap)
      ? db.active.pollData.votedMap.find((v) => v.clientId === clientId)
      : null;

    socket.emit("spotlight:my-votes", {
      postId: db.active.id,
      myReaction: db.active.reactions[clientId] || null,
      myPollVote: pollVotes ? pollVotes.optionId : null,
    });

    io.emit("reaction-update", {
      itemId: db.active.id,
      likes: db.active.likes,
      dislikes: db.active.dislikes,
    });

    saveDb();
  });

  socket.on("disconnect", () => {
    viewersCount = Math.max(0, viewersCount - 1);
    io.emit("viewers-count", viewersCount);
  });
});

// --- SERVER BOOT SEQUENCE ---
async function startServer() {
  await bootDatabase();

  if (db.active && db.active.endsAt <= Date.now()) {
    db.archive.unshift({ ...db.active, endedAt: Date.now() });
    if (db.active.mediaUrl) deleteMedia(db.active.mediaUrl);
    db.active = null;
    saveDb();
  }
  if (!db.active && db.queue.length) advanceSpotlight();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Spotlight running on port ${PORT}`);
    console.log(`Moderation: ${TELEGRAM_ENABLED ? "Telegram Bot active" : "Auto-approve (set TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID to enable)"}`);
    pollTelegram();
  });
}

startServer();
