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
        audioFormat: AudioFormat.ULAW_8000, // идеально под Twilio ulaw_8000 :contentReference[oaicite:1]{index=1}
        sampleRate: 8000,
        commitStrategy: CommitStrategy.VAD,
        vadSilenceThresholdSecs: 0.5,
        vadThreshold: 0.4,
        minSpeechDurationMs: 100,
        minSilenceDurationMs: 100,
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
        console.log(`[${streamSid}] ✅ Scribe FINAL: "${data.text}"`);
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

        // payload — уже base64 ulaw 8000 от Twilio → отправляем как есть
        safeSendToScribe(payload);
        break;
      }

      case 'stop':
        console.log('⏹ Twilio stream STOP', { streamSid, msg });
        if (scribeConn) {
          scribeConn.close();
          scribeConn = null;
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
