// server.js
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import OpenAI from "openai";
import {
  ElevenLabsClient,
  AudioFormat,
  CommitStrategy,
  RealtimeEvents,
} from "@elevenlabs/elevenlabs-js";

// ==== Env ====
const PORT = process.env.PORT || 8000;

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVENLABS_MODEL_ID =
  process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.1";

if (!ELEVENLABS_API_KEY) console.warn("ELEVENLABS_API_KEY is not set");
if (!ELEVENLABS_VOICE_ID) console.warn("ELEVENLABS_VOICE_ID is not set");
if (!OPENAI_API_KEY) console.warn("OPENAI_API_KEY is not set");

// ==== Клиенты ====
const eleven = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ==== Express + HTTP + WS ====
const app = express();
app.use(express.urlencoded({ extended: false }));

// Twilio voice webhook -> TwiML с Media Stream
app.post("/voice", (req, res) => {
  const host = req.headers["host"];
  const wsUrl = `wss://${host}/twilio-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="botSession" value="car-assistant" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ==== Мапы по streamSid ====
/** @type {Map<string, ScribeSession>} */
const sttSessions = new Map();
/** @type {Map<string, LLMConversation>} */
const llmSessions = new Map();
/** @type {Map<string, WebSocket>} */
const twilioSockets = new Map();

// upgrade -> /twilio-stream
server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (url.startsWith("/twilio-stream")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ==== WebSocket handler для Twilio Media Streams ====
wss.on("connection", (ws, req) => {
  console.log("Twilio WS connected");
  let streamSid = null;

  ws.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const event = data.event;

    if (event === "connected") {
      console.log("Twilio event=connected");
      return;
    }

    if (event === "start") {
      streamSid = data.start.streamSid;
      console.log("Twilio stream START:", streamSid);

      twilioSockets.set(streamSid, ws);

      // STT сессия ElevenLabs Scribe
      const scribe = new ScribeSession(
        streamSid,
        eleven,
        handleFinalTranscript
      );
      sttSessions.set(streamSid, scribe);
      scribe.start().catch((err) =>
        console.error(`[${streamSid}] Scribe start error:`, err)
      );

      // Приветствие (опционально)
      sendGreeting(streamSid).catch((err) =>
        console.error(`[${streamSid}] Greeting error:`, err)
      );

      return;
    }

    if (event === "media") {
      if (!streamSid) return;
      const payloadB64 = data.media.payload;

      const scribe = sttSessions.get(streamSid);
      if (scribe) {
        scribe.sendAudio(payloadB64);
      }
      return;
    }

    if (event === "stop") {
      console.log("Twilio stream STOP:", streamSid);

      if (streamSid) {
        const scribe = sttSessions.get(streamSid);
        if (scribe) {
          scribe.stop();
          sttSessions.delete(streamSid);
        }
        twilioSockets.delete(streamSid);
        llmSessions.delete(streamSid);
      }

      try {
        ws.close();
      } catch {}
      return;
    }

    console.log("Unknown Twilio event:", event);
  });

  ws.on("close", () => {
    console.log("Twilio WS closed");
    if (streamSid) {
      const scribe = sttSessions.get(streamSid);
      if (scribe) {
        scribe.stop();
        sttSessions.delete(streamSid);
      }
      twilioSockets.delete(streamSid);
      llmSessions.delete(streamSid);
    }
  });

  ws.on("error", (err) => {
    console.error("WS error:", err);
  });
});

// ==== ScribeSession: ElevenLabs STT на один streamSid ====
class ScribeSession {
  /**
   * @param {string} streamSid
   * @param {ElevenLabsClient} client
   * @param {(sid: string, text: string) => void | Promise<void>} onFinal
   */
  constructor(streamSid, client, onFinal) {
    this.streamSid = streamSid;
    this.client = client;
    this.onFinal = onFinal;

    /** @type {import("@elevenlabs/elevenlabs-js").RealtimeConnection | null} */
    this.connection = null;

    this.ready = false;
    this.stopped = false;
    this.buffer = []; // чанки base64, пока соединение не готово
  }

  async start() {
    console.log(`[${this.streamSid}] Starting Scribe session`);
    try {
      const conn = await this.client.speechToText.realtime.connect({
        modelId: "scribe_v2_realtime",
        audioFormat: AudioFormat.ULAW_8000, // Twilio даёт μ-law 8kHz
        sampleRate: 8000,
        commitStrategy: CommitStrategy.VAD,
        vadSilenceThresholdSecs: 0.5,
        vadThreshold: 0.4,
        minSpeechDurationMs: 100,
        minSilenceDurationMs: 150,
        // languageCode не задаём — автоопределение
      });

      this.connection = conn;
      this.ready = true;

      conn.on(RealtimeEvents.SESSION_STARTED, (info) => {
        console.log(
          `[${this.streamSid}] Scribe session started:`,
          info.session_id
        );
      });

      conn.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (msg) => {
        if (!msg?.text) return;
        console.log(`[${this.streamSid}] STT partial:`, msg.text);
      });

      conn.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (msg) => {
        if (!msg?.text) return;
        console.log(`[${this.streamSid}] STT final:`, msg.text);
        try {
          this.onFinal?.(this.streamSid, msg.text);
        } catch (e) {
          console.error(
            `[${this.streamSid}] onFinal callback error:`,
            e
          );
        }
      });

      conn.on(RealtimeEvents.ERROR, (err) => {
        console.error(`[${this.streamSid}] Scribe ERROR:`, err);
      });
      conn.on(RealtimeEvents.AUTH_ERROR, (err) => {
        console.error(`[${this.streamSid}] Scribe AUTH_ERROR:`, err);
      });
      conn.on(RealtimeEvents.QUOTA_EXCEEDED, (err) => {
        console.error(`[${this.streamSid}] Scribe QUOTA_EXCEEDED:`, err);
      });
      conn.on(RealtimeEvents.CLOSE, () => {
        console.log(`[${this.streamSid}] Scribe connection closed`);
      });

      // отправляем то, что накопилось до готовности
      for (const payload of this.buffer) {
        conn.send({ audioBase64: payload });
      }
      this.buffer = [];
    } catch (err) {
      console.error(`[${this.streamSid}] Failed to start Scribe:`, err);
    }
  }

  sendAudio(payloadB64) {
    if (this.stopped) return;
    if (this.ready && this.connection) {
      try {
        this.connection.send({ audioBase64: payloadB64 });
      } catch (err) {
        console.error(`[${this.streamSid}] Scribe send error:`, err);
      }
    } else {
      this.buffer.push(payloadB64);
    }
  }

  stop() {
    this.stopped = true;
    if (this.connection) {
      try {
        this.connection.close();
      } catch {}
      this.connection = null;
    }
    this.buffer = [];
  }
}

// ==== LLM-сессия на один streamSid ====
class LLMConversation {
  constructor(streamSid) {
    this.streamSid = streamSid;
    /** @type {{role: "system" | "user" | "assistant", content: string}[]} */
    this.messages = [
      {
        role: "system",
        content:
          "Tu esi auto servisa balss asistents. " +
          "Sākumā uzmanīgi noklausies klienta problēmu. " +
          "Pēc pirmajiem vārdiem nosaki, vai klients runā latviski vai krieviski, " +
          "un atbildi tikai šajā valodā. " +
          "Runā īsiem, vienkāršiem teikumiem, ne vairāk kā viens–divi teikumi vienlaikus. " +
          "Kad saproti problēmu, piedāvā pierakstu uz auto pārbaudi un palīdz izvēlēties dienu un laiku. " +
          "Kad pieraksts apstiprināts, pateicies un pieklājīgi nobeidz sarunu. " +
          "Neuzdod pārāk detalizētus tehniskus jautājumus par auto uzbūvi. " +
          "Neaizsāc atbildi ar sveicienu – saruna jau notiek.",
      },
    ];
  }

  async reply(userText) {
    this.messages.push({ role: "user", content: userText });

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: this.messages,
      max_completion_tokens: 80,
      temperature: 0.4,
      reasoning_effort: "none",
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() || "";

    if (reply) {
      this.messages.push({ role: "assistant", content: reply });
    }

    console.log(`[${this.streamSid}] LLM reply:`, reply);
    return reply;
  }
}

// ==== Обработка финального транскрипта от Scribe ====
async function handleFinalTranscript(streamSid, text) {
  const normalized = text.trim();
  if (!normalized) return;

  let conv = llmSessions.get(streamSid);
  if (!conv) {
    conv = new LLMConversation(streamSid);
    llmSessions.set(streamSid, conv);
  }

  try {
    const replyText = await conv.reply(normalized);
    if (replyText) {
      await streamTtsToTwilio(streamSid, replyText);
    }
  } catch (err) {
    console.error(`[${streamSid}] handleFinalTranscript error:`, err);
  }
}

// ==== ElevenLabs TTS -> Twilio Media Stream ====
async function streamTtsToTwilio(streamSid, text) {
  const ws = twilioSockets.get(streamSid);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn(`[${streamSid}] No WS for TTS`);
    return;
  }
  if (!ELEVENLABS_VOICE_ID) {
    console.warn(`[${streamSid}] ELEVENLABS_VOICE_ID not set, skip TTS`);
    return;
  }

  console.log(
    `[${streamSid}] TTS: sending text to ElevenLabs (${text.length} chars)`
  );

  const ttsStream = await eleven.textToSpeech.stream(ELEVENLABS_VOICE_ID, {
    text,
    modelId: ELEVENLABS_MODEL_ID,
    outputFormat: "ulaw_8000", // важно для Twilio
    // можно добавить voiceSettings при необходимости
    // voiceSettings: { stability: 0.5, similarityBoost: 0.0, useSpeakerBoost: true, style: 0, speakingRate: 1.3 }
  });

  for await (const chunk of ttsStream) {
    if (!ws || ws.readyState !== WebSocket.OPEN) break;
    if (!Buffer.isBuffer(chunk)) continue;

    const payloadB64 = chunk.toString("base64");
    const msg = {
      event: "media",
      streamSid,
      media: { payload: payloadB64 },
    };

    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error(`[${streamSid}] Error sending TTS chunk:`, err);
      break;
    }
  }
}

// Приветствие в начале звонка (если нужно)
async function sendGreeting(streamSid) {
  const greeting =
    "Labdien! Esmu virtuālais autoservisa palīgs. Pastāstiet, lūdzu, kas notiek ar auto.";
  await streamTtsToTwilio(streamSid, greeting);
}

// ==== Start server ====
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
