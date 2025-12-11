import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// AI API Key from environment variables (we're using Google Gemini only)
const GOOGLE_GEMINI_KEY = process.env.GOOGLE_GEMINI_KEY;

// Which AI to use for refinement (set via environment or default to "gemini")
// Accepted value: "gemini" or "none"
const AI_PROVIDER = process.env.AI_PROVIDER || "gemini";

app.use(cors());
app.use(express.json());

// Serve static files from client folder
app.use(express.static(path.join(__dirname, "..", "client")));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// AI Refinement Functions
async function refineWithGemini(text, language) {
  if (!GOOGLE_GEMINI_KEY) {
    console.log("No Gemini key provided, skipping refinement");
    return text;
  }

  try {
    const prompt = `You are a professional dental communication expert. Your job is to refine and polish messages for clarity and professionalism in a dental clinic context.

IMPORTANT: Apply these refinements:
1. Fix capitalization (capitalize first word, proper nouns, "I")
2. Add proper punctuation (periods, commas, question marks, exclamation marks)
3. Improve grammar and natural flow
4. Keep the original meaning and intent
5. Make sentences clear and professional for a medical setting

Original message in ${language}: "${text}"

Output ONLY the refined message. Do NOT include any explanation, quotes, or extra text. Just output the refined message exactly as it should be spoken or written.`;

    console.log("Sending to Gemini...");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GOOGLE_GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: prompt
            }]
          }]
        }),
        signal: controller.signal
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      console.error("Gemini API error status:", response.status);
      const errorText = await response.text();
      console.error("Gemini API error response:", errorText);
      return text;
    }

    const data = await response.json();
    console.log("Gemini response status: ok");
    
    const refined = data.candidates?.[0]?.content?.parts?.[0]?.text || text;
    console.log("Refined text:", refined);
    return refined.trim();
  } catch (err) {
    console.error("Gemini refinement error:", err.message);
    return text;
  }
}
// Main refinement dispatcher (Gemini only)
async function refineOriginalText(text, language) {
  console.log(`Refining original text with ${AI_PROVIDER}...`);
  if (AI_PROVIDER === "gemini") {
    return await refineWithGemini(text, language);
  }
  console.log("AI refinement disabled or unsupported provider, returning original text");
  return text;
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

// Return AI provider status (accept both GET and POST for compatibility)
function aiStatusHandler(req, res) {
  res.json({
    provider: AI_PROVIDER,
    geminiEnabled: !!GOOGLE_GEMINI_KEY
  });
}

app.post("/ai-status", aiStatusHandler);
app.get("/ai-status", aiStatusHandler);

// Lightweight diagnostic endpoint for quick health checks
app.get("/ping", (req, res) => {
  res.json({ ok: true, provider: AI_PROVIDER, geminiEnabled: !!GOOGLE_GEMINI_KEY });
});

app.post("/translate", async (req, res) => {
  try {
    console.log("Received request:", req.body);
    const { text, target, source } = req.body;

    if (!text || !target) {
      return res.status(400).json({ error: "Missing text or target" });
    }

    console.log(`Translating "${text}" to ${target}`);

    // Refine the ORIGINAL text with AI if provider is enabled and client requests it
    let refinedText = text;
    const refineRequested = req.body.refine !== false; // default true unless explicitly false
    if (AI_PROVIDER !== "none" && refineRequested) {
      try {
        refinedText = await refineOriginalText(text, source || "English");
        console.log("Using refined original text:", refinedText);
      } catch (refineErr) {
        console.error("Original text refinement failed, using raw text:", refineErr && refineErr.message ? refineErr.message : refineErr);
        refinedText = text;
      }
    }

    // Map full language names to language codes
    const languages = {
      "Spanish": "es",
      "French": "fr",
      "Mandarin": "zh-CN",
      "German": "de",
      "Portuguese": "pt",
      "Italian": "it",
      "Japanese": "ja",
      "English": "en"
    };

    const targetLang = languages[target] || target;

    // If the client provided a source language, use it; otherwise fall back to detection
    let sourceLangCode = source ? (languages[source] || source) : null;

    if (!sourceLangCode) {
      // First, detect the source language using MyMemory API
      const detectResponse = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(refinedText)}&langpair=en|en`
      );
      const detectData = await detectResponse.json();
      sourceLangCode = detectData.responseDetails?.match(/Language pair not supported/) ? "en" : detectData.responseMetadata?.detectedLanguage || "en";
      console.log(`Detected source language: ${sourceLangCode}`);
    } else {
      console.log(`Using client-provided source language: ${source} -> ${sourceLangCode}`);
    }

    // Now translate from source language to target language (using the refined text)
    const translationResponse = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(refinedText)}&langpair=${sourceLangCode}|${targetLang}`
    );

    const data = await translationResponse.json();
    console.log("Translation API response:", data);

    // Read the translation from the response
    let translation = data.responseData?.translatedText || "Error: no translation";
    console.log("Raw translation:", translation);

    res.json({ translation });

  } catch (err) {
    console.error("Error details:", err.message);
    console.error("Full error:", err);
    res.status(500).json({ error: "Translation failed: " + err.message });
  }
});

app.use(express.static(path.join(__dirname, "../client")));

// Serve index.html for all unmatched routes (SPA fallback)
app.get("/*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "client", "index.html"));
});

// Log unhandled errors so they show up in the server terminal
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err && err.stack ? err.stack : err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

// Bind explicitly to 0.0.0.0 so local network interfaces are listening as well
app.listen(3000, "0.0.0.0", () => {
  console.log("Server running on http://localhost:3000 and http://0.0.0.0:3000");
  console.log(`AI Provider: ${AI_PROVIDER}  (Gemini key present: ${!!GOOGLE_GEMINI_KEY})`);
});
