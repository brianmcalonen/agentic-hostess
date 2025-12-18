import express from "express";
import dotenv from "dotenv";
import http from "http";
import twilio from "twilio";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// --- Path helpers for ESM ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Load restaurant knowledge file ---
const restaurantInfoPath = path.join(__dirname, "data", "restaurant.json");
let restaurantInfo = {};

try {
  const raw = fs.readFileSync(restaurantInfoPath, "utf-8");
  restaurantInfo = JSON.parse(raw);
  console.log("📖 Loaded restaurant info:", restaurantInfo.name);
} catch (err) {
  console.error("❌ Failed to load restaurant.json:", err);
  restaurantInfo = {
    name: "The Restaurant",
  };
}

// --- Express app setup ---

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --- OpenAI setup ---

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is not set in .env");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// System prompt with embedded restaurant knowledge
const SYSTEM_PROMPT =
  "You are Agentic Hostess, the phone assistant for " +
  restaurantInfo.name +
  ". Use the following restaurant information to answer questions accurately:\n\n" +
  JSON.stringify(restaurantInfo, null, 2) +
  "\n\n" +
  "Guidelines:\n" +
  "- Speak as if you are a human hostess on the phone.\n" +
  "- Keep responses short, friendly, and easy to understand when spoken.\n" +
  "- Answer questions about hours, location, parking, menu, and policies using this data.\n" +
  "- For reservations, ALWAYS ask for and confirm: name, party size, date, time, and phone number.\n" +
  "- Do not mention JSON, internal data, or that you are an AI.\n" +
  "- If you don't know something, say you are not sure but keep it confident and helpful.\n";

// --- Helper: call OpenAI for a reply ---

async function generateReplyFromOpenAI(userText, sessionState) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userText || "The caller said nothing." },
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini", // adjust to a different model if you like
    messages,
    temperature: 0.7,
  });

  const reply =
    completion.choices?.[0]?.message?.content?.trim() ||
    "I'm sorry, I didn't catch that. How can I help you with your visit or reservation?";
  return reply;
}

// --- Routes ---

// Health check
app.get("/", (req, res) => {
  res.send("Agentic Hostess API (Twilio + restaurant knowledge) running");
});

// 1) First entry point for incoming calls
app.post("/voice", (req, res) => {
  console.log("✅ /voice webhook hit");

  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    { voice: "woman" },
    `Hi, this is Agentic Hostess for ${restaurantInfo.name}.`,
  );

  // Ask an open question, then gather speech
  const gather = twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    speechTimeout: "auto", // Twilio ends when caller stops talking
  });

  gather.say(
    { voice: "woman" },
    "How can I help you today? You can ask about our hours, location, menu, or make a reservation.",
  );

  // If no input, send them back to the start
  twiml.redirect("/voice");

  res.type("text/xml");
  res.send(twiml.toString());
});

// 2) Handle caller speech (one turn of the conversation)
app.post("/gather", async (req, res) => {
  const speechResult = req.body.SpeechResult || "";
  const callSid = req.body.CallSid;
  console.log("🗣 Caller said (Twilio STT):", speechResult);
  console.log("📞 CallSid:", callSid);

  const twiml = new twilio.twiml.VoiceResponse();

  if (!speechResult) {
    twiml.say(
      { voice: "woman" },
      "I'm sorry, I didn't hear anything. Could you please repeat that?",
    );
    twiml.redirect("/voice");
    res.type("text/xml").send(twiml.toString());
    return;
  }

  try {
    // sessionState placeholder – later we can track reservation progress per CallSid
    const aiReply = await generateReplyFromOpenAI(speechResult, null);

    console.log("🤖 Agentic Hostess reply:", aiReply);

    twiml.say({ voice: "woman" }, aiReply);

    // Loop conversation: ask again
    const gather = twiml.gather({
      input: "speech",
      action: "/gather",
      method: "POST",
      speechTimeout: "auto",
    });

    gather.say(
      { voice: "woman" },
      "You can ask another question, continue your reservation, or say 'that's all' to finish.",
    );

    // Safety fallback
    twiml.redirect("/voice");

    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("❌ Error talking to OpenAI:", err);
    twiml.say(
      { voice: "woman" },
      "Sorry, I'm having trouble right now. Please call back a little later.",
    );
    res.type("text/xml").send(twiml.toString());
  }
});

// --- Start HTTP server ---

const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
