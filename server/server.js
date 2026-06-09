require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");

const app = express();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024, files: 1 } }); // memory storage, 25MB cap

// Honor X-Forwarded-For only when explicitly behind a trusted proxy, so the
// rate limiter keys on the real client IP rather than the proxy's.
if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);

// CORS: if ALLOWED_ORIGINS is set (comma-separated), restrict to it; otherwise
// stay open to any origin (preserves existing behavior) but warn so a public
// deployment isn't accidentally left wide open.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (allowedOrigins.length === 0) {
  console.warn("[regal] ALLOWED_ORIGINS not set — CORS is open to any origin. Set it in production.");
  app.use(cors());
} else {
  app.use(
    cors({
      origin(origin, cb) {
        // Allow no-Origin requests (curl, same-origin, health checks) and any whitelisted origin.
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error("Not allowed by CORS"));
      },
    })
  );
}

app.use(express.json());

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Minimal in-memory per-IP rate limiter for the paid Deepgram proxy, so a
// runaway client or abuse can't rack up the API bill. Zero-dependency on
// purpose (no npm install needed); window and cap are env-configurable.
const RATE_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX) || 30;
const rateHits = new Map(); // ip -> { count, resetAt }

function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  let rec = rateHits.get(ip);
  if (!rec || now >= rec.resetAt) {
    rec = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateHits.set(ip, rec);
  }
  rec.count += 1;
  if (rec.count > RATE_MAX) {
    res.set("Retry-After", String(Math.ceil((rec.resetAt - now) / 1000)));
    return res.status(429).json({ error: "Too many requests, slow down" });
  }
  next();
}

// Periodically evict expired buckets so the Map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rateHits) if (now >= rec.resetAt) rateHits.delete(ip);
}, RATE_WINDOW_MS).unref();

app.post("/api/transcribe", rateLimit, upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded (field name must be 'audio')" });
    }

    const dgKey = process.env.DEEPGRAM_API_KEY;
    if (!dgKey) {
      return res.status(500).json({ error: "Missing DEEPGRAM_API_KEY env var" });
    }

    const contentType = req.file.mimetype || "audio/webm";

    const url =
      "https://api.deepgram.com/v1/listen" +
      "?model=nova-2" +
      "&smart_format=true" +
      "&punctuate=true" +
      "&diarize=true" +
      "&utterances=true";

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${dgKey}`,
        "Content-Type": contentType,
      },
      body: req.file.buffer,
    });

    const data = await r.json();

    if (!r.ok) {
      console.error("Deepgram error:", data);
      return res.status(r.status).json({ error: "Deepgram request failed" });
    }

    res.json({ utterances: data?.results?.utterances ?? [] });
  } catch (e) {
    console.error("Transcribe error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend on http://localhost:${PORT}`));
