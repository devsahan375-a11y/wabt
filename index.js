import 'dotenv/config';

import process from 'node:process';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const SESSION_FOLDER = 'session_data';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://wabt-f47e4-default-rtdb.firebaseio.com';
const FIREBASE_SETTINGS_PATH = process.env.FIREBASE_SETTINGS_PATH || 'botSettings';
const DISCOVERY_PLACEHOLDER_JIDS = new Set([
  '000@g.us',
  '0000@g.us',
  '120363000000000000@g.us'
]);

const logger = pino({
  level: LOG_LEVEL
});

const defaultSettings = {
  ALLOWED_GROUP_JID: process.env.ALLOWED_GROUP_JID || '',
  LOG_LEVEL,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
  AI_REPLY_TIMEOUT_MS: Number(process.env.AI_REPLY_TIMEOUT_MS || 30000),
  AI_MAX_REPLY_LENGTH: Number(process.env.AI_MAX_REPLY_LENGTH || 1200),
  AI_HISTORY_LIMIT: Number(process.env.AI_HISTORY_LIMIT || 12),
  AI_MAX_TOKENS: Number(process.env.AI_MAX_TOKENS || 1200),
  AI_TEMPERATURE: Number(process.env.AI_TEMPERATURE || 0.7),
  SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || '',
  BOT_ENABLED: process.env.BOT_ENABLED !== 'false',
  AI_ENABLED: process.env.AI_ENABLED !== 'false'
};

let settings = { ...defaultSettings };
let firebaseSettingsRef;

let sock;
let isShuttingDown = false;
let isStarting = false;
let reconnectTimer;
const chatHistory = new Map();

// Commands are plain words, so normalization keeps matching simple and predictable.
function normalizeText(text = '') {
  return text.trim().toLowerCase();
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() !== 'false';
  return fallback;
}

function normalizeSettings(rawSettings = {}) {
  return {
    ...defaultSettings,
    ...rawSettings,
    ALLOWED_GROUP_JID: String(rawSettings.ALLOWED_GROUP_JID ?? defaultSettings.ALLOWED_GROUP_JID).trim(),
    LOG_LEVEL: String(rawSettings.LOG_LEVEL ?? defaultSettings.LOG_LEVEL).trim() || 'info',
    OPENROUTER_API_KEY: String(rawSettings.OPENROUTER_API_KEY ?? defaultSettings.OPENROUTER_API_KEY).trim(),
    OPENROUTER_MODEL: String(rawSettings.OPENROUTER_MODEL ?? defaultSettings.OPENROUTER_MODEL).trim(),
    AI_REPLY_TIMEOUT_MS: toNumber(rawSettings.AI_REPLY_TIMEOUT_MS, defaultSettings.AI_REPLY_TIMEOUT_MS),
    AI_MAX_REPLY_LENGTH: toNumber(rawSettings.AI_MAX_REPLY_LENGTH, defaultSettings.AI_MAX_REPLY_LENGTH),
    AI_HISTORY_LIMIT: toNumber(rawSettings.AI_HISTORY_LIMIT, defaultSettings.AI_HISTORY_LIMIT),
    AI_MAX_TOKENS: toNumber(rawSettings.AI_MAX_TOKENS, defaultSettings.AI_MAX_TOKENS),
    AI_TEMPERATURE: toNumber(rawSettings.AI_TEMPERATURE, defaultSettings.AI_TEMPERATURE),
    SYSTEM_PROMPT: String(rawSettings.SYSTEM_PROMPT ?? defaultSettings.SYSTEM_PROMPT).trim(),
    BOT_ENABLED: toBoolean(rawSettings.BOT_ENABLED, defaultSettings.BOT_ENABLED),
    AI_ENABLED: toBoolean(rawSettings.AI_ENABLED, defaultSettings.AI_ENABLED)
  };
}

function applySettings(nextSettings, source) {
  settings = normalizeSettings(nextSettings);
  logger.level = settings.LOG_LEVEL;

  logger.info(
    {
      source,
      allowedGroupJid: settings.ALLOWED_GROUP_JID,
      model: settings.OPENROUTER_MODEL,
      botEnabled: settings.BOT_ENABLED,
      aiEnabled: settings.AI_ENABLED
    },
    'Runtime settings loaded.'
  );

  if (!settings.OPENROUTER_API_KEY && !isDiscoveryMode()) {
    logger.warn('OPENROUTER_API_KEY is missing. Commands will work, but AI replies will be disabled.');
  }
}

function getFirebaseCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const json = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
    return cert(JSON.parse(json));
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  }

  return applicationDefault();
}

function initializeFirebaseSettings() {
  try {
    const app = initializeApp({
      credential: getFirebaseCredential(),
      databaseURL: FIREBASE_DATABASE_URL
    });

    firebaseSettingsRef = getDatabase(app).ref(FIREBASE_SETTINGS_PATH);
    logger.info({ path: FIREBASE_SETTINGS_PATH }, 'Firebase settings connected.');
    return true;
  } catch (error) {
    logger.error({ error: serializeError(error) }, 'Firebase settings connection failed. Falling back to .env settings.');
    return false;
  }
}

async function loadFirebaseSettingsOnce() {
  if (!firebaseSettingsRef) return false;

  try {
    const snapshot = await firebaseSettingsRef.once('value');
    const value = snapshot.val();

    if (value) {
      applySettings(value, 'firebase-initial');
    } else {
      applySettings(defaultSettings, 'env-fallback-empty-firebase');
      await firebaseSettingsRef.set({
        ...settings,
        initializedAt: new Date().toISOString()
      });
      logger.info('Created default /botSettings in Firebase.');
    }

    return true;
  } catch (error) {
    logger.error({ error: serializeError(error) }, 'Failed to load Firebase settings. Falling back to .env settings.');
    return false;
  }
}

function watchFirebaseSettings() {
  if (!firebaseSettingsRef) return;

  firebaseSettingsRef.on(
    'value',
    (snapshot) => {
      const value = snapshot.val();
      if (value) applySettings(value, 'firebase-live');
    },
    (error) => {
      logger.error({ error: serializeError(error) }, 'Firebase settings listener failed.');
    }
  );
}

function validateSettingsOrExit() {
  if (!settings.ALLOWED_GROUP_JID) {
    logger.error('Missing ALLOWED_GROUP_JID. Set it in Firebase /botSettings or in .env.');
    process.exit(1);
  }

  if (!settings.ALLOWED_GROUP_JID.endsWith('@g.us')) {
    logger.error({ allowedGroupJid: settings.ALLOWED_GROUP_JID }, 'ALLOWED_GROUP_JID must be a WhatsApp group JID ending with @g.us.');
    process.exit(1);
  }
}

function isDiscoveryMode() {
  return DISCOVERY_PLACEHOLDER_JIDS.has(settings.ALLOWED_GROUP_JID);
}

function getErrorStatusCode(error) {
  return error?.output?.statusCode || error?.statusCode;
}

function isExpectedBaileysDisconnect(error) {
  const statusCode = getErrorStatusCode(error);
  return statusCode === 428 || statusCode === 440 || error?.message === 'Connection Closed';
}

function serializeError(error) {
  if (!error) return {};

  return {
    name: error.name,
    message: error.message,
    status: error.status,
    code: error.code,
    cause: error.cause?.message || error.cause,
    stack: error.stack,
    details: error.details
  };
}

// Baileys stores text in different places depending on the message type.
function getMessageText(message) {
  if (!message) return '';

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ''
  );
}

// In groups, the sender is msg.key.participant. pushName gives a nicer display name when available.
function getSenderName(msg, senderJid) {
  return (
    msg.pushName ||
    msg.verifiedBizName ||
    senderJid?.split('@')[0] ||
    'there'
  );
}

// Admin status is read from fresh group metadata so role changes are respected.
async function isGroupAdmin(groupJid, senderJid) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const participant = metadata.participants.find((member) => member.id === senderJid);

    return participant?.admin === 'admin' || participant?.admin === 'superadmin';
  } catch (error) {
    logger.error({ error }, 'Failed to check group admin status.');
    return false;
  }
}

async function sendReply(groupJid, text, quotedMessage) {
  logger.debug({ groupJid, textLength: text.length }, 'Sending WhatsApp reply.');

  await sock.sendMessage(groupJid, { text }, { quoted: quotedMessage });

  logger.info({ groupJid }, 'WhatsApp reply sent.');
}

function getChatHistory(groupJid) {
  return chatHistory.get(groupJid) || [];
}

function rememberChat(groupJid, role, content) {
  const history = getChatHistory(groupJid);
  history.push({ role, content });
  chatHistory.set(groupJid, history.slice(-settings.AI_HISTORY_LIMIT));
}

function buildAiPrompt(groupJid, senderName, text) {
  const recentMessages = getChatHistory(groupJid);

  return [
    {
      role: 'system',
      content: [
        'You are a helpful knowledge and advice assistant inside a WhatsApp group.',
        'Answer like ChatGPT or Gemini: useful, clear, practical, and accurate.',
        'Still sound natural for a Sri Lankan WhatsApp chat, not robotic or overly formal.',
        'The user may write in Sinhala, Singlish, or English. Reply in the same language and typing style.',
        'For Sinhala, use natural everyday Sri Lankan Sinhala. For Singlish, use simple Singlish.',
        'Help with information, explanations, study questions, tech questions, ideas, and advice.',
        'If the question is vague, ask one short clarifying question. If you can infer the meaning, answer directly.',
        'If the message is rude, teasing, or nonsense, do not escalate. Reply calmly or ask what they really need.',
        'Do not start replies with the sender name. Do not repeat the sender name unless it is truly needed.',
        'Do not mention AI, OpenRouter, language model, assistant, or bot.',
        'Keep normal replies concise, but give steps or bullet points when the user asks for help or information.',
        'Do not invent facts. If you are unsure, say that you are not sure and suggest how to verify.',
        'Use emojis rarely, only when they feel natural.',
        settings.SYSTEM_PROMPT
      ].join(' ')
    },
    ...recentMessages,
    {
      role: 'user',
      content: `${senderName}: ${text}`
    }
  ];
}

function trimReply(text) {
  if (text.length <= settings.AI_MAX_REPLY_LENGTH) return text;
  return `${text.slice(0, settings.AI_MAX_REPLY_LENGTH).trim()}...`;
}

async function getOpenRouterReply(groupJid, senderName, text) {
  if (!settings.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.AI_REPLY_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    logger.info(
      {
        model: settings.OPENROUTER_MODEL,
        promptLength: text.length,
        timeoutMs: settings.AI_REPLY_TIMEOUT_MS
      },
      'Requesting OpenRouter reply.'
    );

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${settings.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://localhost',
        'X-OpenRouter-Title': 'WhatsApp Group Only Bot'
      },
      body: JSON.stringify({
        model: settings.OPENROUTER_MODEL,
        messages: buildAiPrompt(groupJid, senderName, text),
        temperature: settings.AI_TEMPERATURE,
        max_tokens: settings.AI_MAX_TOKENS
      })
    });

    const responseText = await response.text();
    let data = {};

    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      data = { raw: responseText };
    }

    logger.info(
      {
        status: response.status,
        durationMs: Date.now() - startedAt
      },
      'OpenRouter response received.'
    );

    if (!response.ok) {
      const message = data?.error?.message || response.statusText || 'OpenRouter request failed.';
      const error = new Error(`OpenRouter error ${response.status}: ${message}`);
      error.status = response.status;
      error.details = data;
      throw error;
    }

    const reply = data?.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      throw new Error('OpenRouter returned an empty reply.');
    }

    return trimReply(reply);
  } finally {
    clearTimeout(timeout);
  }
}

async function handleAiReply({ groupJid, senderName, text, msg }) {
  if (!settings.AI_ENABLED) {
    logger.info('Skipping AI reply because AI_ENABLED is false.');
    return;
  }

  if (!settings.OPENROUTER_API_KEY) {
    logger.warn('Skipping AI reply because OPENROUTER_API_KEY is not configured.');
    return;
  }

  try {
    logger.info({ groupJid, senderName }, 'Creating AI reply.');
    rememberChat(groupJid, 'user', `${senderName}: ${text}`);
    const reply = await getOpenRouterReply(groupJid, senderName, text);
    rememberChat(groupJid, 'assistant', reply);
    await sendReply(groupJid, reply, msg);
  } catch (error) {
    logger.error(
      {
        error: serializeError(error),
        model: settings.OPENROUTER_MODEL
      },
      'Failed to create OpenRouter reply.'
    );
    await sendReply(groupJid, 'මේ වෙලාවේ උත්තරයක් ගන්න බැරි වුණා. ටිකකින් ආයෙම try කරන්න.', msg);
  }
}

async function handleCommand({ groupJid, senderJid, senderName, text, msg }) {
  const command = normalizeText(text);

  // Known commands use fixed replies. Other messages are passed to AI.
  switch (command) {
    case 'hi':
      await sendReply(groupJid, `Hi ${senderName}! Welcome to the group.`, msg);
      return true;

    case 'menu':
      await sendReply(
        groupJid,
        [
          `Hello ${senderName}, here are my commands:`,
          '',
          'hi - Get a greeting',
          'menu - Show this command list',
          'help - Learn what this bot does',
          'ping - Check if the bot is online',
          'admin - Admin-only reply',
          '',
          'Send any other message and I will answer with AI.'
        ].join('\n'),
        msg
      );
      return true;

    case 'help':
      await sendReply(
        groupJid,
        `Hi ${senderName}. I only work in this approved WhatsApp group. I can answer Sinhala, Singlish, and English messages using AI.`,
        msg
      );
      return true;

    case 'ping':
      await sendReply(groupJid, `pong, ${senderName}`, msg);
      return true;

    case 'admin': {
      const senderIsAdmin = await isGroupAdmin(groupJid, senderJid);

      if (senderIsAdmin) {
        await sendReply(groupJid, `Hello admin ${senderName}.`, msg);
      }
      return true;
    }

    default:
      return false;
  }
}

async function handleIncomingMessages({ messages, type }) {
  logger.debug({ type, count: messages.length }, 'messages.upsert event received.');

  if (type !== 'notify') return;

  for (const msg of messages) {
    try {
      const groupJid = msg.key.remoteJid;
      const isFromMe = msg.key.fromMe;
      const isGroupMessage = groupJid?.endsWith('@g.us');

      if (isFromMe) {
        logger.debug({ groupJid }, 'Ignoring message from bot account.');
        continue;
      }

      if (!isGroupMessage) {
        logger.debug({ groupJid }, 'Ignoring private or non-group chat.');
        continue;
      }

      if (isDiscoveryMode()) {
        logger.info(
          {
            groupJid,
            senderName: getSenderName(msg, msg.key.participant),
            message: getMessageText(msg.message)
          },
          'Group JID discovery: copy this groupJid into ALLOWED_GROUP_JID in your .env file.'
        );
        continue;
      }

      // Safety gates: no private chats, no self replies, and no unapproved groups.
      if (!settings.BOT_ENABLED) {
        logger.info({ groupJid }, 'Ignoring message because BOT_ENABLED is false.');
        continue;
      }

      if (groupJid !== settings.ALLOWED_GROUP_JID) {
        logger.debug({ groupJid, allowedGroupJid: settings.ALLOWED_GROUP_JID }, 'Ignoring message from another group.');
        continue;
      }

      // In a group message, participant is the real sender JID.
      const senderJid = msg.key.participant;
      if (!senderJid) {
        logger.debug({ groupJid }, 'Ignoring group message without participant.');
        continue;
      }

      const text = getMessageText(msg.message);
      if (!text.trim()) {
        logger.debug({ groupJid, senderJid }, 'Ignoring empty or unsupported message type.');
        continue;
      }

      const senderName = getSenderName(msg, senderJid);

      logger.info(
        {
          groupJid,
          senderJid,
          senderName,
          message: text
        },
        'Allowed group message received.'
      );

      const commandWasHandled = await handleCommand({
        groupJid,
        senderJid,
        senderName,
        text,
        msg
      });

      if (!commandWasHandled) {
        await handleAiReply({
          groupJid,
          senderName,
          text,
          msg
        });
      }
    } catch (error) {
      logger.error({ error }, 'Failed to handle incoming message.');
    }
  }
}

function scheduleReconnect() {
  if (isShuttingDown || reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    startBot().catch((error) => {
      logger.error({ error }, 'Reconnect attempt failed.');
      scheduleReconnect();
    });
  }, 5000);
}

async function startBot() {
  if (isStarting) {
    logger.warn('Start skipped because the bot is already starting.');
    return;
  }

  isStarting = true;
  logger.info({ allowedGroupJid: settings.ALLOWED_GROUP_JID }, 'Starting WhatsApp group-only bot.');

  try {
    sock?.ev?.removeAllListeners?.();
    sock?.ws?.close?.();
  } catch (error) {
    logger.debug({ error }, 'Old socket cleanup skipped.');
  }

  try {
    // useMultiFileAuthState writes reusable login credentials into session_data.
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    logger.info({ version, isLatest }, 'Using Baileys version.');

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Group Only Bot', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', handleIncomingMessages);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info('Scan this QR code with WhatsApp to log in:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        logger.info({ allowedGroupJid: settings.ALLOWED_GROUP_JID }, 'Bot connected successfully.');
      }

      if (connection === 'close') {
        const error = lastDisconnect?.error;
        const statusCode = getErrorStatusCode(error);
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn(
          {
            statusCode,
            shouldReconnect
          },
          'WhatsApp connection closed.'
        );

        if (shouldReconnect) {
          logger.info('Reconnecting in 5 seconds...');
          scheduleReconnect();
        } else {
          logger.error('Bot logged out. Delete session_data and scan a new QR code if you want to log in again.');
        }
      }
    });
  } finally {
    isStarting = false;
  }
}

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down bot.');
  isShuttingDown = true;
  sock?.end?.();
  process.exit(0);
}

async function main() {
  applySettings(defaultSettings, 'env-bootstrap');

  const firebaseReady = initializeFirebaseSettings();
  if (firebaseReady) {
    await loadFirebaseSettingsOnce();
    watchFirebaseSettings();
  }

  validateSettingsOrExit();

  await startBot();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception.');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  if (isExpectedBaileysDisconnect(reason)) {
    logger.warn({ reason }, 'Ignored expected Baileys disconnect rejection.');
    scheduleReconnect();
    return;
  }

  logger.fatal({ reason }, 'Unhandled promise rejection.');
  process.exit(1);
});

main().catch((error) => {
  logger.fatal({ error }, 'Failed to start bot.');
  process.exit(1);
});
