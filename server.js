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
import { Readable } from "stream";

// ==== базовый лог ошибок процесса, чтобы сервер не падал молча ====
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT_EXCEPTION:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED_REJECTION:", reason);
});

// ==== ENV ====
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

// ==== клиенты ====
const eleven = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ==== Express + HTTP + WS ====
const app = express();
app.use(express.urlencoded({ extended: false }));

// Twilio voice webhook -> TwiML с Media Stream
app.post("/voice", (req, res) => {
  const host = req.headers["host"];
  const wsUrl = `wss://${host}/twilio-stream`;

  console.log("[/voice] building TwiML with wsUrl=", wsUrl);

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

// ==== мапы по streamSid ====
/** @type {Map<string, ScribeSession>} */
const sttSessions = new Map();
/** @type {Map<string, LLMConversation>} */
const llmSessions = new Map();
/** @type {Map<string, WebSocket>} */
const twilioSockets = new Map();

const scribeSessions = new Map(); // streamSid -> ScribeSession
const conversations = new Map(); // streamSid -> message[]

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

  ws.on("message", async (data) => {
    const msg = JSON.parse(data.toString());
    const event = msg.event;

    if (event === "connected") {
      console.log("Twilio event=connected");
    } else if (event === "start") {
      const streamSid = msg.start.streamSid;
      console.log(`Twilio stream START: ${streamSid}`);

      twilioSockets.set(streamSid, ws);

      // стартуем Scribe для этого streamSid
      const session = new ScribeSession(streamSid);
      scribeSessions.set(streamSid, session);
      session.start().catch((err) => {
        console.error(`[${streamSid}] Failed to start Scribe:`, err);
      });

      // приветствие (TTS) — см. ниже
      streamTtsToTwilio(streamSid, greetingText).catch((err) => {
        console.error(`[${streamSid}] Error sending greeting TTS:`, err);
      });
    } else if (event === "media") {
      const streamSid = msg.streamSid;
      const payloadBase64 = msg.media.payload;

      const session = scribeSessions.get(streamSid);
      if (session) {
        session.sendAudioBase64(payloadBase64);
      }
    } else if (event === "stop") {
      const streamSid = msg.streamSid;
      console.log(`Twilio stream STOP: ${streamSid}`);

      const session = scribeSessions.get(streamSid);
      if (session) {
        session.stop();
        scribeSessions.delete(streamSid);
      }
      twilioSockets.delete(streamSid);
    }
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

// ==================== Scribe STT session ====================

class ScribeSession {
  constructor(streamSid) {
    this.streamSid = streamSid;
    this.connection = null;
    this.ready = false;
    this.buffer = [];          // сюда временно складываем аудио
    this.transcript = "";      // общий текст для логов/отладки
  }

  async start() {
    console.log(`[${this.streamSid}] Starting Scribe session`);

    this.connection = await eleven.speechToText.realtime.connect({
      modelId: "scribe_v2_realtime",
      audioFormat: AudioFormat.ULAW_8000,
      sampleRate: 8000,
      commitStrategy: CommitStrategy.VAD,  // авто-коммиты по VAD
      vadSilenceThresholdSecs: 0.5,
      vadThreshold: 0.5,
      includeTimestamps: false,
      // languageCode можно не задавать — Scribe сам детектит язык
    });

    // --- регистрируем события ---

    this.connection.on(RealtimeEvents.SESSION_STARTED, (data) => {
      console.log(
        `[${this.streamSid}] Scribe session started: ${data.session_id}`
      );

      // важно: сначала включаем ready, потом льём буфер
      this.ready = true;

      if (this.buffer.length > 0) {
        console.log(
          `[${this.streamSid}] Flushing ${this.buffer.length} buffered audio chunks`
        );
        for (const base64 of this.buffer) {
          try {
            this.connection.send({ audioBase64: base64 });
          } catch (err) {
            console.error(
              `[${this.streamSid}] Error sending buffered chunk to Scribe:`,
              err
            );
          }
        }
        this.buffer = [];
      }
    });

    this.connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data) => {
      if (!data?.text) return;
      console.log(
        `[${this.streamSid}] Scribe partial: ${JSON.stringify(data)}`
      );
    });

    this.connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, async (data) => {
      if (!data?.text) return;

      console.log(
        `[${this.streamSid}] Scribe final: ${data.text} (lang=${data.language_code})`
      );
      this.transcript += (this.transcript ? " " : "") + data.text;

      // здесь вызываем LLM + TTS
      try {
        const replyText = await handleFinalTranscript(
          this.streamSid,
          data.text,
          data.language_code
        );
        if (replyText) {
          console.log(
            `[${this.streamSid}] LLM reply ready: ${replyText.replace(
              /\s+/g,
              " "
            )}`
          );
          await streamTtsToTwilio(this.streamSid, replyText);
        }
      } catch (err) {
        console.error(
          `[${this.streamSid}] Error in LLM/TTS pipeline:`,
          err
        );
      }
    });

    this.connection.on(RealtimeEvents.ERROR, (err) => {
      console.error(`[${this.streamSid}] Scribe ERROR:`, err);
    });

    this.connection.on(RealtimeEvents.AUTH_ERROR, (err) => {
      console.error(`[${this.streamSid}] Scribe AUTH_ERROR:`, err);
    });

    this.connection.on(RealtimeEvents.QUOTA_EXCEEDED, (err) => {
      console.error(`[${this.streamSid}] Scribe QUOTA_EXCEEDED:`, err);
    });

    this.connection.on(RealtimeEvents.CLOSE, () => {
      console.log(`[${this.streamSid}] Scribe connection closed`);
    });
  }

  /**
   * Получает base64 μ-law/8000 от Twilio и отправляет в Scribe.
   * До старта сессии просто копит в буфере.
   */
  sendAudioBase64(base64Payload) {
    if (!this.connection || !this.ready) {
      this.buffer.push(base64Payload);
      return;
    }

    try {
      this.connection.send({ audioBase64: base64Payload });
    } catch (err) {
      console.error(
        `[${this.streamSid}] Scribe send error:`,
        err
      );
    }
  }

  stop() {
    try {
      if (this.connection) {
        this.connection.close();
      }
    } catch (err) {
      console.error(`[${this.streamSid}] Error closing Scribe:`, err);
    }
  }
}

// ==== LLM-сессия на один streamSid ====
class LLMConversation {
  constructor(streamSid) {
    this.streamSid = streamSid;
    /** @type {{role:"system"|"user"|"assistant",content:string}[]} */
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
function getConversation(streamSid) {
  if (!conversations.has(streamSid)) {
    const systemPrompt =
      "Tu esi auto servisa balss asistents. " +
      "Sākumā uzmanīgi noklausies klienta problēmu. " +
      "Pēc pirmajiem vārdiem nosaki, vai klients runā latviski vai krieviski, un turpmāk runā tikai šajā valodā. " +
      "Runā īsiem, vienkāršiem teikumiem, ne vairāk kā divi teikumi vienlaikus. " +
      "Kad saproti problēmu, piedāvā pierakstu uz auto pārbaudi un palīdz izvēlēties dienu un laiku. " +
      "Kad pieraksts apstiprināts, pateicies un pieklājīgi nobeidz sarunu. " +
      "Neprasi tehniskas detaļas par auto, tikai to, kas nepieciešams pierakstam.";

    conversations.set(streamSid, [{ role: "system", content: systemPrompt }]);
  }
  return conversations.get(streamSid);
}

async function handleFinalTranscript(streamSid, text, languageCode) {
  const messages = getConversation(streamSid);

  messages.push({
    role: "user",
    content: text,
  });

  const stream = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages,
    max_completion_tokens: 80,
    temperature: 0.4,
    stream: true,
  });

  let reply = "";
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content || "";
    if (delta) reply += delta;
  }

  reply = reply.trim();
  if (!reply) return "";

  messages.push({ role: "assistant", content: reply });

  return reply;
}

// ==== ElevenLabs TTS -> Twilio Media Stream ====
async function bufferFromIterable(iterable) {
  const chunks = [];
  for await (const chunk of iterable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function streamTtsToTwilio(streamSid, text) {
  const ws = twilioSockets.get(streamSid);
  if (!ws) {
    console.warn(`[${streamSid}] No Twilio WS for TTS`);
    return;
  }

  console.log(`[${streamSid}] TTS: sending text to ElevenLabs (${text.length} chars)`);

  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const modelId = process.env.ELEVENLABS_TTS_MODEL_ID || "eleven_flash_v2_5";

  // 1) Получаем весь аудио-стрим целиком (ulaw_8000)
  const response = await eleven.textToSpeech.convert(voiceId, {
    modelId,
    outputFormat: "ulaw_8000",
    text,
  });

  const readable = Readable.from(response);
  const audioBuffer = await bufferFromIterable(readable);

  const payload = audioBuffer.toString("base64");

  // 2) Отправляем в Twilio одним куском
  ws.send(
    JSON.stringify({
      event: "media",
      streamSid,
      media: {
        payload,
      },
    })
  );

  console.log(
    `[${streamSid}] TTS: sent ${audioBuffer.length} bytes of ulaw_8000 to Twilio`
  );
}

// где-то рядом:
const greetingText =
  "Labdien! Esmu virtuālais autoservisa palīgs. Lūdzu, īsi pastāstiet, kāda ir problēma ar auto.";

// Приветствие в начале звонка (если нужно)
async function sendGreeting(streamSid) {
  const greeting =
    "Labdien! Esmu virtuālais autoservisa palīgs.";
  await streamTtsToTwilio(streamSid, greeting);
}

// ==== Start server ====
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
