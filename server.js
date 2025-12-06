import 'dotenv/config';
import { createServer } from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import {
  ElevenLabsClient,
  AudioFormat,
  CommitStrategy,
  RealtimeEvents,
} from '@elevenlabs/elevenlabs-js';
import fs from 'fs';
import alawmulaw from 'alawmulaw';

// ==== Конфиг ====

const PORT = process.env.PORT || 3000;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const SCRIBE_MODEL_ID = process.env.SCRIBE_MODEL_ID || 'scribe_v2_realtime';

if (!ELEVENLABS_API_KEY) {
  console.warn('⚠️ ELEVENLABS_API_KEY is not set – Scribe работать не будет');
}

const elevenClient = new ElevenLabsClient({
  apiKey: ELEVENLABS_API_KEY,
});

const VoiceResponse = twilio.twiml.VoiceResponse;

// ==== HTTP-сервер (Express) ====

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (req, res) => {
  res.type('text').send('Twilio ↔ ElevenLabs Scribe bridge is running');
});

// Twilio voice webhook — отдаем TwiML
app.post('/voice', (req, res) => {
  const host = req.headers.host;
  const wsUrl = `wss://${host}/twilio-stream`;

  console.log('[/voice] Incoming call');
  console.log('[/voice] Host:', host);
  console.log('[/voice] WebSocket URL for media stream:', wsUrl);

  const twiml = new VoiceResponse();

  // Первая фраза — чтобы понять, что звонок стартовал
  twiml.say(
    {
      language: 'lv-LV',
      voice: 'Google.lv-LV-Standard-B', // Twilio TTS для латышского :contentReference[oaicite:0]{index=0}
    },
    'Labdien! Esmu virtuālais autoservisa palīgs.'
  );

  const connect = twiml.connect();
  const stream = connect.stream({ url: wsUrl });
  stream.parameter({ name: 'botSession', value: 'car-assistant' });

  const twimlStr = twiml.toString();
  console.log('[/voice] Responding with TwiML:\n', twimlStr);

  res.type('text/xml').send(twimlStr);
});

// ==== WebSocket-сервер для Twilio Media Streams ====

const server = createServer(app);

const wss = new WebSocketServer({
  server,
  path: '/twilio-stream',
});

wss.on('connection', async (twilioWs, req) => {
  console.log('=========================================');
  console.log('== Twilio Media Stream WebSocket CONNECT ==');
  console.log('Client IP:', req.socket.remoteAddress);
  console.log('Headers:', req.headers);

  let streamSid = null;
  let scribeConn = null;
  let scribeReady = false;
  const pendingAudioChunks = [];
  let rawUlawChunks = [];

  // Безопасная отправка аудио в Scribe (с буферизацией до старта сессии)
  const safeSendToScribe = (payloadBase64) => {
    if (!scribeConn || !scribeReady) {
      pendingAudioChunks.push(payloadBase64);
      return;
    }
    try {
      scribeConn.send({
        audioBase64: payloadBase64,
        sampleRate: 8000, // ВАЖНО: Twilio всегда 8000 Hz
      });
    } catch (err) {
      console.error(`[${streamSid}] ❌ Error sending audio to Scribe:`, err);
    }
  };

  // Подключаемся к ElevenLabs Scribe v2 Realtime
  const setupScribeConnection = async () => {
    if (!ELEVENLABS_API_KEY) {
      console.error('❌ ELEVENLABS_API_KEY missing – cannot connect to Scribe');
      return;
    }

    try {
      console.log(
        `[${streamSid}] Connecting to ElevenLabs Scribe v2 Realtime (ulaw_8000, VAD)...`
      );

      scribeConn = await elevenClient.speechToText.realtime.connect({
        modelId: SCRIBE_MODEL_ID,
        audioFormat: AudioFormat.PCM_8000,
        sampleRate: 8000,
        // Сегментация - на основе VAD
        commitStrategy: CommitStrategy.VAD,
        // 1) Сколько тишины после речи, прежде чем зафиксировать сегмент
        // 0.35–0.4сек — компромисс между скоростью и "не рубить слова"
        vadSilenceThresholdSecs: 0.35,
        // 2) Чувствительность к речи vs шуму
        // 0.5 – строже, чем 0.4, но не конский 0.7
        vadThreshold: 0.5,
        // 3) Минимальная длина речи для сегмента
        // 250ms — хватает для "да"/"нет", но резкий шум + щелчок уже сложнее пролезть
        minSpeechDurationMs: 250,
        // 4) Минимальная длина тишины между сегментами
        // Меньше — быстрее коммит, но больше риск нарубить длинную фразу на куски
        minSilenceDurationMs: 180,
        languageCode: 'ru',        // 'lv' для латышского; позже можно авто
        includeTimestamps: true,
      });

      // ==== Scribe events ====

      scribeConn.on(RealtimeEvents.SESSION_STARTED, (data) => {
        console.log(
          `[${streamSid}] 🔵 Scribe SESSION_STARTED`,
          {
            sessionId: data.session_id,
            config: data.config,
          }
        );
        scribeReady = true;

        if (pendingAudioChunks.length) {
          console.log(
            `[${streamSid}] Sending ${pendingAudioChunks.length} buffered audio chunks to Scribe`
          );
          for (const chunk of pendingAudioChunks) {
            scribeConn.send({
              audioBase64: chunk,
              sampleRate: 8000, // тоже явно указываем
            });
          }
          pendingAudioChunks.length = 0;
        }
      });

      scribeConn.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data) => {
        if (!data?.text) return;
        console.log(`[${streamSid}] ✏️ Scribe PARTIAL: "${data.text}"`);
      });

      scribeConn.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (data) => {
        let text = (data.text || '').trim();

        // 1) Пусто — считаем шумом/тишиной
        if (!text) {
          console.log(`[${streamSid}] FINAL empty → шум, игнорируем`);
          return;
        }

        // 2) Явные шумовые теги от модели
        if (/^\*static\*$/i.test(text) || /^\*noise\*$/i.test(text)) {
          console.log(`[${streamSid}] FINAL noise tag (${text}) → игнорируем`);
          return;
        }

        // 3) Защита от "мусора": слишком коротко и без букв
        if (text.length < 3 || !/[a-zA-Zа-яА-Яāēīūščņļģķž]/.test(text)) {
          console.log(
            `[${streamSid}] FINAL too short or no letters (${text}) → игнорируем`
          );
          return;
        }

        console.log(`[${streamSid}] ✅ REAL FINAL: "${text}"`);

        // Здесь уже:
        // - пушим текст в GPT
        // - логируем диалог
        // - триггерим ответ бота и т.п.
      });

      scribeConn.on(
        RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS,
        (data) => {
          console.log(
            `[${streamSid}] ✅ Scribe FINAL+TS: "${data.text}" (words: ${data.words?.length ?? 0})`
          );
        }
      );

      scribeConn.on(RealtimeEvents.ERROR, (error) => {
        console.error(`[${streamSid}] ❌ Scribe ERROR:`, error);
      });

      scribeConn.on(RealtimeEvents.AUTH_ERROR, (error) => {
        console.error(`[${streamSid}] ❌ Scribe AUTH_ERROR:`, error);
      });

      scribeConn.on(RealtimeEvents.QUOTA_EXCEEDED, (error) => {
        console.error(`[${streamSid}] ❌ Scribe QUOTA_EXCEEDED:`, error);
      });

      scribeConn.on(RealtimeEvents.CLOSE, () => {
        console.log(`[${streamSid}] 🔴 Scribe connection CLOSED`);
        scribeReady = false;
      });
    } catch (err) {
      console.error(
        `[${streamSid}] ❌ Failed to connect to ElevenLabs Scribe:`,
        err
      );
    }
  };

  // ==== Twilio WebSocket messages ====

  twilioWs.on('message', async (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch (err) {
      console.error('❌ Failed to parse Twilio message as JSON:', err);
      console.error('Raw message:', rawData.toString());
      return;
    }

    const event = msg.event;

    switch (event) {
      case 'connected':
        console.log('🔵 Twilio event=connected');
        console.log('Payload:', msg);
        break;

      case 'start':
        streamSid = msg.start?.streamSid ?? msg.streamSid ?? 'unknown';
        console.log('▶️ Twilio stream START', {
          streamSid,
          start: msg.start,
        });
        await setupScribeConnection();
        break;

      case 'media': {
        if (!streamSid) {
          console.warn('⚠️ Got media before start; ignoring');
          return;
        }

        const { sequenceNumber, media } = msg;
        const { timestamp, chunk, payload } = media || {};

        if (!payload) break;

        // 🔴 Раньше: отправляли μ-law как есть
        // safeSendToScribe(payload);

        // 🟢 Теперь: декодируем μ-law → PCM16 и только потом отправляем
        const pcmBase64 = twilioMulawBase64ToPcm16Base64(payload);
        safeSendToScribe(pcmBase64);

        break;
      }

      case 'stop':
        console.log('⏹ Twilio stream STOP', { streamSid, msg });
        if (scribeConn) {
          scribeConn.close();
          scribeConn = null;
        }
        if (rawUlawChunks.length) {
          const rawPath = `/home/site/${streamSid || 'unknown'}-twilio-ulaw8k.raw`;
          fs.writeFile(rawPath, Buffer.concat(rawUlawChunks), (err) => {
            if (err) {
              console.error(`[${streamSid}] ❌ Failed to write raw audio:`, err);
            } else {
              console.log(`[${streamSid}] 💾 Saved raw Twilio audio to ${rawPath}`);
            }
          });
        }
        twilioWs.close();
        break;

      default:
        console.log('ℹ️ Twilio UNKNOWN event:', msg);
    }
  });

  twilioWs.on('close', (code, reason) => {
    console.log(
      `[${streamSid}] 🔴 Twilio WebSocket CLOSED`,
      { code, reason: reason.toString() }
    );
    if (scribeConn) {
      scribeConn.close();
      scribeConn = null;
    }
  });

  twilioWs.on('error', (err) => {
    console.error(`[${streamSid}] ❌ Twilio WebSocket ERROR:`, err);
    if (scribeConn) {
      scribeConn.close();
      scribeConn = null;
    }
  });
});

// ==== Запуск сервера ====

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`   Voice webhook URL: POST https://<your-host>/voice`);
  console.log(`   Media WebSocket URL: wss://<your-host>/twilio-stream`);
});

function twilioMulawBase64ToPcm16Base64(mulawB64) {
  // Twilio payload (base64) -> raw bytes
  const muLawBuffer = Buffer.from(mulawB64, 'base64');

  // Uint8Array для alawmulaw
  const muLawArray = new Uint8Array(
    muLawBuffer.buffer,
    muLawBuffer.byteOffset,
    muLawBuffer.byteLength
  );

  // 🟢 mu-law 8-bit -> PCM Int16
  const pcmInt16 = alawmulaw.mulaw.decode(muLawArray);

  // Int16Array -> Buffer -> base64
  const pcmBuffer = Buffer.from(pcmInt16.buffer);
  return pcmBuffer.toString('base64');
}
