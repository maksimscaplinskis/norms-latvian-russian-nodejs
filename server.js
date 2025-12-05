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
const elevenClient = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});
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

const logger = {
  info: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
  warn:  (...args) => console.warn(...args),
};

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

  ws.on("message", async (message) => {
    try {
      const jsonStr = message.toString("utf8");
      const data = JSON.parse(jsonStr);
      const event = data.event;

      if (event === "connected") {
        logger.info("Twilio event=connected");
        return;
      }

      if (event === "start") {
        const streamSid = data.start.streamSid;
        logger.info(`Twilio stream START: ${streamSid}`);

        // --- запуск Scribe-сессии ---
        const scribe = new ScribeSession(streamSid);
        scribeSessions.set(streamSid, scribe);
        scribe.start().catch((err) => {
          logger.error(
            `[${streamSid}] Scribe start failed: ${err.stack || err}`
          );
        });

        twilioSockets.set(streamSid, ws);

        // приветствие (TTS) — см. ниже
        streamTtsToTwilio(streamSid, greetingText).catch((err) => {
          console.error(`[${streamSid}] Error sending greeting TTS:`, err);
        });
        return;
      }

      if (event === "media") {
        const streamSid = data.streamSid;
        const payloadBase64 = data.media?.payload;

        if (!payloadBase64) {
          logger.warn(
            `[${streamSid || "noSid"}] Media event without payload: ${jsonStr}`
          );
          return;
        }

        const scribe = scribeSessions.get(streamSid);
        if (scribe) {
          scribe.sendAudio(payloadBase64);
        } else {
          logger.warn(
            `[${streamSid}] Media received but no ScribeSession found`
          );
        }

        return;
      }

      if (event === "stop") {
        const streamSid = data.stop.streamSid;
        logger.info(`Twilio stream STOP: ${streamSid}`);

        const scribe = scribeSessions.get(streamSid);
        if (scribe) {
          scribe.close();
          scribeSessions.delete(streamSid);
        }

        // тут же можешь чистить LLM-сессии и т.п.
        return;
      }

      // остальные события Twilio (mark и т.п.)
      logger.info(`Twilio event=${event} (ignored)`);

    } catch (err) {
      logger.error("Error in Twilio WS message handler:", err);
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
    this.isReady = false;
    this.buffer = []; // сюда складываем чанки до session_started
  }

  async start() {
    logger.info(`[${this.streamSid}] Starting Scribe session`);

    try {
      this.connection = await elevenClient.speechToText.realtime.connect({
        modelId: "scribe_v2_realtime",
        audioFormat: AudioFormat.ULAW_8000, // важно!
        sampleRate: 8000,                   // тоже важно!
        commitStrategy: CommitStrategy.VAD, // пусть сам режет по тишине
        // languageCode НЕ задаем -> авто-детект RU/LV
        vadSilenceThresholdSecs: 0.5,
        vadThreshold: 0.4,
        minSpeechDurationMs: 150,
        minSilenceDurationMs: 150,
        includeTimestamps: false,
      });

      const conn = this.connection;

      // --- события Scribe ---

      conn.on(RealtimeEvents.SESSION_STARTED, (data) => {
        logger.info(
          `[${this.streamSid}] Scribe session started: ${data.session_id}`
        );
        this.isReady = true;

        if (this.buffer.length > 0) {
          logger.info(
            `[${this.streamSid}] Flushing ${this.buffer.length} buffered audio chunks`
          );
          for (const b64 of this.buffer) {
            conn.send({
              audioBase64: b64,
              sampleRate: 8000,
            });
          }
          this.buffer = [];
        }
      });

      conn.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data) => {
        if (!data?.text) return;
        logger.info(
          `[${this.streamSid}] Scribe partial: ${JSON.stringify(data)}`
        );
      });

      conn.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (data) => {
        if (!data?.text) return;
        logger.info(
          `[${this.streamSid}] Scribe committed: ${JSON.stringify(data)}`
        );

        // language_code может быть в data.language_code
        const langCode =
          data.language_code || data.languageCode || null;

        // тут дергаем твой LLM+TTS пайплайн
        handleFinalUserUtterance(this.streamSid, data.text, langCode);
      });

      conn.on(RealtimeEvents.ERROR, (err) => {
        logger.error(
          `[${this.streamSid}] Scribe ERROR: ${JSON.stringify(err)}`
        );
      });

      conn.on(RealtimeEvents.AUTH_ERROR, (err) => {
        logger.error(
          `[${this.streamSid}] Scribe AUTH_ERROR: ${JSON.stringify(err)}`
        );
      });

      conn.on(RealtimeEvents.QUOTA_EXCEEDED, (err) => {
        logger.error(
          `[${this.streamSid}] Scribe QUOTA_EXCEEDED: ${JSON.stringify(err)}`
        );
      });

      conn.on(RealtimeEvents.CLOSE, () => {
        logger.info(`[${this.streamSid}] Scribe connection closed`);
      });
    } catch (err) {
      logger.error(
        `[${this.streamSid}] Failed to start Scribe: ${err.stack || err}`
      );
      throw err;
    }
  }

  sendAudio(base64) {
    // Twilio всегда шлет ulaw_8000 -> передаем как есть, плюс sampleRate=8000
    if (!this.connection || !this.isReady) {
      this.buffer.push(base64);
      return;
    }

    try {
      this.connection.send({
        audioBase64: base64,
        sampleRate: 8000, // важно явно проставить
      });
    } catch (err) {
      logger.error(
        `[${this.streamSid}] Scribe send error: ${err.stack || err}`
      );
    }
  }

  close() {
    if (this.connection) {
      try {
        this.connection.close();
      } catch (err) {
        logger.error(
          `[${this.streamSid}] Error closing Scribe connection: ${
            err.stack || err
          }`
        );
      }
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

async function handleFinalUserUtterance(streamSid, text, langCode) {
  logger.info(
    `[${streamSid}] Final transcript for LLM [langCode=${langCode}]: ${text}`
  );

  // 1) Берем/создаем LLMConversation (ты уже делал в Python)
  let conv = llmSessions[streamSid];
  if (!conv) {
    conv = new LLMConversation(streamSid);
    llmSessions[streamSid] = conv;
  }

  const replyText = await conv.handleUserUtterance(text, langCode);

  if (!replyText) {
    return;
  }

  logger.info(
    `[${streamSid}] LLM reply ready (for TTS): ${JSON.stringify(replyText)}`
  );

  // 2) Прогоняем через ElevenLabs TTS и отправляем в Twilio
  await streamTtsToTwilio(streamSid, replyText);
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
  const response = await elevenClient.textToSpeech.convert(voiceId, {
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
