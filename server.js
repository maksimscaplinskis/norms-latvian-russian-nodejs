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
  apiKey: ELEVENLABS_API_KEY,
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
  warn: (...args) => console.warn(...args),
};

// ==== мапы по streamSid ====
/** streamSid -> ScribeSession */
const scribeSessions = new Map();
/** streamSid -> LLMConversation */
const llmSessions = new Map();
/** streamSid -> WebSocket (Twilio) */
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
  logger.info("Twilio WS connected");

  // текущий streamSid для этого WS-соединения
  let currentStreamSid = null;

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
        // у start streamSid обычно лежит в data.start.streamSid
        currentStreamSid = data.start?.streamSid || data.streamSid;
        const streamSid = currentStreamSid;
        logger.info(`Twilio stream START: ${streamSid}`);

        // --- запуск Scribe-сессии ---
        const scribe = new ScribeSession(streamSid);
        scribeSessions.set(streamSid, scribe);
        twilioSockets.set(streamSid, ws);

        scribe.start().catch((err) => {
          logger.error(
            `[${streamSid}] Scribe start failed: ${err.stack || err}`
          );
        });

        // приветствие
        streamTtsToTwilio(streamSid, greetingText).catch((err) => {
          console.error(`[${streamSid}] Error sending greeting TTS:`, err);
        });

        return;
      }

      if (event === "media") {
        const streamSid = data.streamSid || currentStreamSid;
        const payloadBase64 = data.media?.payload;

        if (!payloadBase64) {
          logger.warn(
            `[${streamSid || "noSid"}] Media event without payload: ${jsonStr}`
          );
          return;
        }

        const scribe = scribeSessions.get(streamSid);
        if (!scribe) {
          logger.warn(
            `[${streamSid}] Media received but no ScribeSession found`
          );
          return;
        }

        // Отладка: видно, что аудио реально идёт
        // Можно потом убрать/закомментировать
        logger.info(
          `[${streamSid}] Media chunk received, len=${payloadBase64.length}`
        );

        scribe.sendAudio(payloadBase64);
        return;
      }

      if (event === "stop") {
        // у stop streamSid лежит в data.streamSid
        const streamSid = data.streamSid || currentStreamSid;
        logger.info(`Twilio stream STOP: ${streamSid}`);

        const scribe = scribeSessions.get(streamSid);
        if (scribe) {
          scribe.close();
          scribeSessions.delete(streamSid);
        }

        twilioSockets.delete(streamSid);
        llmSessions.delete(streamSid);
        return;
      }

      // остальные события Twilio (mark и т.п.)
      logger.info(`Twilio event=${event} (ignored)`);
    } catch (err) {
      logger.error("Error in Twilio WS message handler:", err);
    }
  });

  ws.on("close", () => {
    logger.info("Twilio WS closed");
    if (!currentStreamSid) return;

    const scribe = scribeSessions.get(currentStreamSid);
    if (scribe) {
      scribe.close();
      scribeSessions.delete(currentStreamSid);
    }
    twilioSockets.delete(currentStreamSid);
    llmSessions.delete(currentStreamSid);
  });

  ws.on("error", (err) => {
    logger.error("WS error:", err);
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
        sampleRate: 8000, // тоже важно!
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
        const langCode = data.language_code || data.languageCode || null;

        // дергаем LLM+TTS пайплайн
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
    this.langCode = null;

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

  async reply(userText, langCodeFromStt) {
    if (langCodeFromStt && !this.langCode) {
      this.langCode = langCodeFromStt;
    }

    this.messages.push({ role: "user", content: userText });

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: this.messages,
      max_tokens: 80,
      temperature: 0.4,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() || "";

    if (reply) {
      this.messages.push({ role: "assistant", content: reply });
    }

    logger.info(`[${this.streamSid}] LLM reply: ${reply}`);
    return reply;
  }
}

// ==== Обработка финального транскрипта от Scribe ====
async function handleFinalUserUtterance(streamSid, text, langCode) {
  logger.info(
    `[${streamSid}] Final transcript for LLM [langCode=${langCode}]: ${text}`
  );

  let conv = llmSessions.get(streamSid);
  if (!conv) {
    conv = new LLMConversation(streamSid);
    llmSessions.set(streamSid, conv);
  }

  const replyText = await conv.reply(text, langCode);

  if (!replyText) return;

  logger.info(
    `[${streamSid}] LLM reply ready (for TTS): ${JSON.stringify(replyText)}`
  );

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

  logger.info(
    `[${streamSid}] TTS: sending text to ElevenLabs (${text.length} chars)`
  );

  const voiceId = ELEVENLABS_VOICE_ID;
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

  logger.info(
    `[${streamSid}] TTS: sent ${audioBuffer.length} bytes of ulaw_8000 to Twilio`
  );
}

const greetingText =
  "Labdien! Esmu virtuālais autoservisa palīgs. Lūdzu, īsi pastāstiet, kāda ir problēma ar auto.";

// ==== Start server ====
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
