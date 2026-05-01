import 'dotenv/config';

import fs from 'node:fs/promises';
import process from 'node:process';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app';
import { getDatabase, ServerValue } from 'firebase-admin/database';

const SESSION_FOLDER = process.env.SESSION_FOLDER || 'session_data';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://wabt-f47e4-default-rtdb.firebaseio.com';
const FIREBASE_SETTINGS_PATH = process.env.FIREBASE_SETTINGS_PATH || 'botSettings';
const FIREBASE_RUNTIME_PATH = process.env.FIREBASE_RUNTIME_PATH || 'botRuntime';
const FIREBASE_CONVERSATIONS_PATH = process.env.FIREBASE_CONVERSATIONS_PATH || 'botConversations';
const FIREBASE_SCHEDULES_PATH = process.env.FIREBASE_SCHEDULES_PATH || 'botSchedules';
const TERMINAL_QR_ENABLED = process.env.TERMINAL_QR_ENABLED === 'true';
const CLEAR_SESSION_ON_LOGOUT = process.env.CLEAR_SESSION_ON_LOGOUT !== 'false';
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
  AI_ENABLED: process.env.AI_ENABLED !== 'false',
  CHAT_PERMISSION_MODE: process.env.CHAT_PERMISSION_MODE || 'specific_group',
  ALLOWED_PRIVATE_JID: process.env.ALLOWED_PRIVATE_JID || '',
  TARGET_PROMPTS: {},
  CONTACT_RELATIONS: {},
  HUMAN_REPLY_ENABLED: process.env.HUMAN_REPLY_ENABLED !== 'false',
  HUMAN_DELAY_MIN_MS: Number(process.env.HUMAN_DELAY_MIN_MS || 1500),
  HUMAN_DELAY_MAX_MS: Number(process.env.HUMAN_DELAY_MAX_MS || 6500),
  HUMAN_TYPING_MIN_MS: Number(process.env.HUMAN_TYPING_MIN_MS || 1200),
  HUMAN_TYPING_MAX_MS: Number(process.env.HUMAN_TYPING_MAX_MS || 9000),
  HUMAN_TYPING_CHARS_PER_SECOND: Number(process.env.HUMAN_TYPING_CHARS_PER_SECOND || 18)
};

let settings = { ...defaultSettings };
let firebaseSettingsRef;
let firebaseRuntimeRef;
let firebaseConversationsRef;
let firebaseSchedulesRef;
let schedules = {};
let scheduleTimer;

let sock;
let isShuttingDown = false;
let isStarting = false;
let reconnectTimer;
const chatHistory = new Map();
const processedMessages = new Set();
const PROCESS_CACHE_LIMIT = 500;

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
    AI_ENABLED: toBoolean(rawSettings.AI_ENABLED, defaultSettings.AI_ENABLED),
    CHAT_PERMISSION_MODE: String(rawSettings.CHAT_PERMISSION_MODE ?? defaultSettings.CHAT_PERMISSION_MODE).trim() || 'specific_group',
    ALLOWED_PRIVATE_JID: String(rawSettings.ALLOWED_PRIVATE_JID ?? defaultSettings.ALLOWED_PRIVATE_JID).trim(),
    TARGET_PROMPTS: rawSettings.TARGET_PROMPTS && typeof rawSettings.TARGET_PROMPTS === 'object' ? rawSettings.TARGET_PROMPTS : {},
    CONTACT_RELATIONS: rawSettings.CONTACT_RELATIONS && typeof rawSettings.CONTACT_RELATIONS === 'object' ? rawSettings.CONTACT_RELATIONS : {},
    HUMAN_REPLY_ENABLED: toBoolean(rawSettings.HUMAN_REPLY_ENABLED, defaultSettings.HUMAN_REPLY_ENABLED),
    HUMAN_DELAY_MIN_MS: toNumber(rawSettings.HUMAN_DELAY_MIN_MS, defaultSettings.HUMAN_DELAY_MIN_MS),
    HUMAN_DELAY_MAX_MS: toNumber(rawSettings.HUMAN_DELAY_MAX_MS, defaultSettings.HUMAN_DELAY_MAX_MS),
    HUMAN_TYPING_MIN_MS: toNumber(rawSettings.HUMAN_TYPING_MIN_MS, defaultSettings.HUMAN_TYPING_MIN_MS),
    HUMAN_TYPING_MAX_MS: toNumber(rawSettings.HUMAN_TYPING_MAX_MS, defaultSettings.HUMAN_TYPING_MAX_MS),
    HUMAN_TYPING_CHARS_PER_SECOND: toNumber(rawSettings.HUMAN_TYPING_CHARS_PER_SECOND, defaultSettings.HUMAN_TYPING_CHARS_PER_SECOND)
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
      aiEnabled: settings.AI_ENABLED,
      chatPermissionMode: settings.CHAT_PERMISSION_MODE
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
    return cert(parseServiceAccountJson(json));
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return cert(parseServiceAccountJson(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  }

  return applicationDefault();
}

function parseServiceAccountJson(rawValue) {
  const trimmedValue = rawValue.trim();

  try {
    const parsedValue = JSON.parse(trimmedValue);
    return typeof parsedValue === 'string' ? JSON.parse(parsedValue) : parsedValue;
  } catch (firstError) {
    const firstBrace = trimmedValue.indexOf('{');
    const lastBrace = trimmedValue.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const extractedJson = trimmedValue.slice(firstBrace, lastBrace + 1);
      return JSON.parse(extractedJson);
    }

    throw firstError;
  }
}

function initializeFirebaseSettings() {
  try {
    const app = initializeApp({
      credential: getFirebaseCredential(),
      databaseURL: FIREBASE_DATABASE_URL
    });

    firebaseSettingsRef = getDatabase(app).ref(FIREBASE_SETTINGS_PATH);
    firebaseRuntimeRef = getDatabase(app).ref(FIREBASE_RUNTIME_PATH);
    firebaseConversationsRef = getDatabase(app).ref(FIREBASE_CONVERSATIONS_PATH);
    firebaseSchedulesRef = getDatabase(app).ref(FIREBASE_SCHEDULES_PATH);
    logger.info(
      {
        settingsPath: FIREBASE_SETTINGS_PATH,
        runtimePath: FIREBASE_RUNTIME_PATH,
        conversationsPath: FIREBASE_CONVERSATIONS_PATH,
        schedulesPath: FIREBASE_SCHEDULES_PATH
      },
      'Firebase settings connected.'
    );
    return true;
  } catch (error) {
    logger.error({ error: serializeError(error) }, 'Firebase settings connection failed. Falling back to .env settings.');
    return false;
  }
}

async function updateBotRuntime(payload) {
  if (!firebaseRuntimeRef) return;

  try {
    await firebaseRuntimeRef.update({
      ...payload,
      updatedAt: ServerValue.TIMESTAMP
    });
  } catch (error) {
    logger.error({ error: serializeError(error) }, 'Failed to update Firebase runtime state.');
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

function watchSchedules() {
  if (!firebaseSchedulesRef) return;

  firebaseSchedulesRef.on(
    'value',
    (snapshot) => {
      schedules = snapshot.val() || {};
      logger.debug({ count: Object.keys(schedules).length }, 'Schedules refreshed.');
    },
    (error) => {
      logger.error({ error: serializeError(error) }, 'Firebase schedules listener failed.');
    }
  );
}

async function processDueSchedules() {
  if (!firebaseSchedulesRef || !sock) return;

  const now = Date.now();
  const dueEntries = Object.entries(schedules).filter(([, schedule]) => {
    const hasMessageSource = schedule?.messageMode === 'ai'
      ? Boolean(schedule?.aiPrompt || schedule?.text)
      : Boolean(schedule?.text);

    return schedule?.enabled !== false
      && !['sending', 'sent', 'completed'].includes(schedule?.status)
      && schedule?.targetJid
      && hasMessageSource
      && Number(schedule?.sendAt) <= now;
  });

  for (const [scheduleId, schedule] of dueEntries) {
    try {
      await firebaseSchedulesRef.child(scheduleId).update({
        status: 'sending',
        lastAttemptAt: ServerValue.TIMESTAMP
      });

      const targetJid = normalizeTargetJid(schedule.targetJid);
      const messageText = await getScheduleMessageText(schedule, targetJid);
      const result = await sock.sendMessage(targetJid, { text: messageText });

      await logConversationMessage({
        chatJid: targetJid,
        chatType: isGroupJid(targetJid) ? 'group' : 'private',
        senderJid: 'bot',
        senderName: 'Bot',
        direction: 'scheduled',
        text: messageText,
        messageId: result?.key?.id
      });

      const recurrence = schedule.recurrence || 'once';
      const updatePayload = {
        sentAt: ServerValue.TIMESTAMP,
        messageId: result?.key?.id || null
      };

      if (recurrence === 'daily') {
        updatePayload.status = 'pending';
        updatePayload.sendAt = Number(schedule.sendAt) + 24 * 60 * 60 * 1000;
      } else if (recurrence === 'weekly') {
        updatePayload.status = 'pending';
        updatePayload.sendAt = Number(schedule.sendAt) + 7 * 24 * 60 * 60 * 1000;
      } else {
        updatePayload.status = 'completed';
        updatePayload.enabled = false;
        updatePayload.completedAt = ServerValue.TIMESTAMP;
      }

      await firebaseSchedulesRef.child(scheduleId).update(updatePayload);
    } catch (error) {
      logger.error({ error: serializeError(error), scheduleId }, 'Scheduled message failed.');
      await firebaseSchedulesRef.child(scheduleId).update({
        status: 'failed',
        error: error.message,
        failedAt: ServerValue.TIMESTAMP
      });
    }
  }
}

async function getScheduleMessageText(schedule, targetJid) {
  if (schedule.messageMode !== 'ai') {
    return schedule.text;
  }

  const prompt = schedule.aiPrompt || schedule.text;

  if (!prompt) {
    throw new Error('AI schedule prompt is empty.');
  }

  logger.info({ targetJid }, 'Generating scheduled message with AI.');

  return getOpenRouterReply(
    targetJid,
    'scheduled-message',
    'Admin schedule',
    [
      'Generate a WhatsApp message for a scheduled send.',
      'Return only the final message text.',
      `Instruction: ${prompt}`
    ].join('\n')
  );
}

function startScheduleWorker() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = setInterval(() => {
    processDueSchedules().catch((error) => {
      logger.error({ error: serializeError(error) }, 'Schedule worker failed.');
    });
  }, 30000);
}

function validateSettingsOrExit() {
  const needsGroup = ['group_only', 'specific_group'].includes(settings.CHAT_PERMISSION_MODE);
  const needsPrivate = settings.CHAT_PERMISSION_MODE === 'specific_private';

  if (needsGroup && !settings.ALLOWED_GROUP_JID) {
    logger.error('Missing ALLOWED_GROUP_JID. Set it in Firebase /botSettings or in .env.');
    process.exit(1);
  }

  if (needsGroup && !settings.ALLOWED_GROUP_JID.endsWith('@g.us')) {
    logger.error({ allowedGroupJid: settings.ALLOWED_GROUP_JID }, 'ALLOWED_GROUP_JID must be a WhatsApp group JID ending with @g.us.');
    process.exit(1);
  }

  if (needsPrivate && !settings.ALLOWED_PRIVATE_JID) {
    logger.error('Missing ALLOWED_PRIVATE_JID for specific_private mode.');
    process.exit(1);
  }
}

function isDiscoveryMode() {
  return DISCOVERY_PLACEHOLDER_JIDS.has(settings.ALLOWED_GROUP_JID);
}

function isGroupJid(jid = '') {
  return jid.endsWith('@g.us');
}

function getPrivateSenderJid(msg) {
  return msg.key.participant || msg.key.remoteJid;
}

function isChatAllowed(chatJid) {
  const mode = settings.CHAT_PERMISSION_MODE;
  const isGroup = isGroupJid(chatJid);

  if (mode === 'all') return true;
  if (mode === 'group_only') return isGroup;
  if (mode === 'private_only') return !isGroup;
  if (mode === 'specific_private') return !isGroup && chatJid === settings.ALLOWED_PRIVATE_JID;

  return isGroup && chatJid === settings.ALLOWED_GROUP_JID;
}

function safeFirebaseKey(value = '') {
  return value.replace(/[.#$/[\]]/g, '_');
}

function normalizeTargetJid(value = '') {
  const target = String(value).trim();

  if (!target) return '';
  if (target.includes('@')) return target;

  const digits = target.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : target;
}

function getTargetPrompt(chatJid) {
  const prompts = settings.TARGET_PROMPTS || {};
  const directPrompt = prompts[chatJid];

  if (typeof directPrompt === 'string') return directPrompt.trim();

  const encodedPrompt = prompts[safeFirebaseKey(chatJid)];
  if (typeof encodedPrompt === 'string') return encodedPrompt.trim();
  if (encodedPrompt?.prompt) return String(encodedPrompt.prompt).trim();

  return '';
}

function getContactRelation(senderJid) {
  const relations = settings.CONTACT_RELATIONS || {};
  const directRelation = relations[senderJid];

  if (typeof directRelation === 'string') {
    return { relation: directRelation, note: '' };
  }

  const encodedRelation = relations[safeFirebaseKey(senderJid)];
  if (typeof encodedRelation === 'string') {
    return { relation: encodedRelation, note: '' };
  }

  if (encodedRelation?.relation) {
    return {
      relation: String(encodedRelation.relation).trim(),
      note: String(encodedRelation.note || '').trim()
    };
  }

  return {
    relation: 'unknown',
    note: ''
  };
}

async function logConversationMessage({ chatJid, chatType, senderJid, senderName, direction, text, messageId }) {
  if (!firebaseConversationsRef || !chatJid || !text) return;

  const chatKey = safeFirebaseKey(chatJid);
  const chatRef = firebaseConversationsRef.child(chatKey);

  try {
    await chatRef.child('meta').update({
      chatJid,
      chatType,
      lastMessage: text.slice(0, 300),
      lastSenderName: senderName || 'Bot',
      lastDirection: direction,
      updatedAt: ServerValue.TIMESTAMP
    });

    await chatRef.child('messages').push({
      chatJid,
      chatType,
      senderJid,
      senderName: senderName || 'Bot',
      direction,
      text,
      messageId: messageId || null,
      createdAt: ServerValue.TIMESTAMP
    });
  } catch (error) {
    logger.error({ error: serializeError(error), chatJid }, 'Failed to log conversation message.');
  }
}

function rememberProcessedMessage(messageKey) {
  const messageId = [
    messageKey.remoteJid,
    messageKey.participant || 'direct',
    messageKey.id
  ].join(':');

  if (processedMessages.has(messageId)) return false;

  processedMessages.add(messageId);

  if (processedMessages.size > PROCESS_CACHE_LIMIT) {
    const oldestMessageId = processedMessages.values().next().value;
    processedMessages.delete(oldestMessageId);
  }

  return true;
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

async function sendReply(groupJid, text, options = {}) {
  const mentions = options.mentions || [];
  const quoted = options.quoted;
  const chatType = isGroupJid(groupJid) ? 'group' : 'private';
  logger.info({ groupJid, textLength: text.length }, 'Sending WhatsApp reply.');

  try {
    await simulateHumanReply(groupJid, text, quoted);

    const result = await sock.sendMessage(
      groupJid,
      { text, mentions },
      quoted ? { quoted } : undefined
    );

    logger.info(
      {
        groupJid,
        messageId: result?.key?.id,
        remoteJid: result?.key?.remoteJid,
        fromMe: result?.key?.fromMe
      },
      'WhatsApp reply sent.'
    );

    await logConversationMessage({
      chatJid: groupJid,
      chatType,
      senderJid: 'bot',
      senderName: 'Bot',
      direction: 'outgoing',
      text,
      messageId: result?.key?.id
    });

    return result;
  } catch (error) {
    logger.error({ error: serializeError(error), groupJid }, 'WhatsApp reply failed.');

    if (!quoted) throw error;

    const result = await sock.sendMessage(groupJid, { text, mentions });
    logger.info({ groupJid, messageId: result?.key?.id }, 'WhatsApp reply sent after retry.');
    await logConversationMessage({
      chatJid: groupJid,
      chatType,
      senderJid: 'bot',
      senderName: 'Bot',
      direction: 'outgoing',
      text,
      messageId: result?.key?.id
    });
    return result;
  }
}

async function sendQuotedReply(groupJid, text, quotedMessage, mentions = []) {
  await sendReply(groupJid, text, {
    quoted: quotedMessage,
    mentions
  });
}

function randomBetween(min, max) {
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function simulateHumanReply(chatJid, text, quotedMessage) {
  if (!settings.HUMAN_REPLY_ENABLED) return;

  try {
    if (quotedMessage?.key) {
      await sock.readMessages([quotedMessage.key]);
    }

    const delayMs = randomBetween(settings.HUMAN_DELAY_MIN_MS, settings.HUMAN_DELAY_MAX_MS);
    await wait(delayMs);

    const calculatedTypingMs = Math.ceil((text.length / settings.HUMAN_TYPING_CHARS_PER_SECOND) * 1000);
    const typingMs = Math.min(
      settings.HUMAN_TYPING_MAX_MS,
      Math.max(settings.HUMAN_TYPING_MIN_MS, calculatedTypingMs)
    );

    await sock.sendPresenceUpdate('composing', chatJid);
    await wait(typingMs);
    await sock.sendPresenceUpdate('paused', chatJid);
  } catch (error) {
    logger.debug({ error: serializeError(error), chatJid }, 'Human reply simulation skipped.');
  }
}

function getChatHistory(groupJid) {
  return chatHistory.get(groupJid) || [];
}

function rememberChat(groupJid, role, content) {
  const history = getChatHistory(groupJid);
  history.push({ role, content });
  chatHistory.set(groupJid, history.slice(-settings.AI_HISTORY_LIMIT));
}

function buildAiPrompt(groupJid, senderJid, senderName, text) {
  const recentMessages = getChatHistory(groupJid);
  const targetPrompt = getTargetPrompt(groupJid);
  const contactRelation = getContactRelation(senderJid);

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
        `The sender relationship to the bot is: ${contactRelation.relation}. Adjust warmth, respect, formality, and boundaries to suit that relationship.`,
        contactRelation.note ? `Extra relationship note: ${contactRelation.note}` : '',
        'Use emojis rarely, only when they feel natural.',
        settings.SYSTEM_PROMPT,
        targetPrompt ? `Target-specific instruction: ${targetPrompt}` : ''
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

async function getOpenRouterReply(groupJid, senderJid, senderName, text) {
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
        messages: buildAiPrompt(groupJid, senderJid, senderName, text),
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

async function handleAiReply({ groupJid, senderJid, senderName, text, msg }) {
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
    const reply = await getOpenRouterReply(groupJid, senderJid, senderName, text);
    rememberChat(groupJid, 'assistant', reply);
    await sendQuotedReply(groupJid, reply, msg);
  } catch (error) {
    logger.error(
      {
        error: serializeError(error),
        model: settings.OPENROUTER_MODEL
      },
      'Failed to create OpenRouter reply.'
    );
    await sendQuotedReply(groupJid, 'මේ වෙලාවේ උත්තරයක් ගන්න බැරි වුණා. ටිකකින් ආයෙම try කරන්න.', msg);
  }
}

async function handleCommand({ groupJid, senderJid, senderName, text, msg }) {
  const command = normalizeText(text);

  // Known commands use fixed replies. Other messages are passed to AI.
  switch (command) {
    case 'hi':
      await sendQuotedReply(groupJid, `Hi ${senderName}! Welcome to the group.`, msg);
      return true;

    case 'menu':
      await sendQuotedReply(
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
      await sendQuotedReply(
        groupJid,
        `Hi ${senderName}. I only work in this approved WhatsApp group. I can answer Sinhala, Singlish, and English messages using AI.`,
        msg
      );
      return true;

    case 'ping':
      await sendQuotedReply(groupJid, `pong, ${senderName}`, msg);
      return true;

    case 'admin': {
      const senderIsAdmin = await isGroupAdmin(groupJid, senderJid);

      if (senderIsAdmin) {
        await sendQuotedReply(groupJid, `Hello admin ${senderName}.`, msg);
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
      const isGroupMessage = isGroupJid(groupJid);
      const chatType = isGroupMessage ? 'group' : 'private';

      if (!rememberProcessedMessage(msg.key)) {
        logger.debug({ messageId: msg.key.id, groupJid }, 'Ignoring already processed message.');
        continue;
      }

      if (isFromMe) {
        logger.debug({ groupJid }, 'Ignoring message from bot account.');
        continue;
      }

      if (isDiscoveryMode() && isGroupMessage) {
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

      if (!settings.BOT_ENABLED) {
        logger.info({ groupJid }, 'Ignoring message because BOT_ENABLED is false.');
        continue;
      }

      if (!isChatAllowed(groupJid)) {
        logger.debug(
          {
            groupJid,
            mode: settings.CHAT_PERMISSION_MODE,
            allowedGroupJid: settings.ALLOWED_GROUP_JID,
            allowedPrivateJid: settings.ALLOWED_PRIVATE_JID
          },
          'Ignoring message because chat is not allowed.'
        );
        continue;
      }

      // In a group message, participant is the real sender JID. In private chat, remoteJid is the sender.
      const senderJid = getPrivateSenderJid(msg);
      if (!senderJid) {
        logger.debug({ groupJid }, 'Ignoring message without sender JID.');
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

      await logConversationMessage({
        chatJid: groupJid,
        chatType,
        senderJid,
        senderName,
        direction: 'incoming',
        text,
        messageId: msg.key.id
      });

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
          senderJid,
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

async function clearSessionData() {
  logger.warn({ sessionFolder: SESSION_FOLDER }, 'Clearing WhatsApp session data.');

  try {
    sock?.ev?.removeAllListeners?.();
    sock?.ws?.close?.();
    sock?.end?.();
  } catch (error) {
    logger.debug({ error: serializeError(error) }, 'Socket close before session clear skipped.');
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));

  await clearDirectoryContents(SESSION_FOLDER);

  await fs.mkdir(SESSION_FOLDER, {
    recursive: true
  });
}

async function clearDirectoryContents(directory) {
  await fs.mkdir(directory, { recursive: true });

  const entries = await fs.readdir(directory, {
    withFileTypes: true
  });

  for (const entry of entries) {
    const entryPath = `${directory}/${entry.name}`;
    await removeWithRetry(entryPath);
  }
}

async function removeWithRetry(path, attempt = 1) {
  try {
    await fs.rm(path, {
      recursive: true,
      force: true
    });
  } catch (error) {
    if ((error.code === 'EBUSY' || error.code === 'ENOTEMPTY') && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      await removeWithRetry(path, attempt + 1);
      return;
    }

    throw error;
  }
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
      logger: pino({ level: 'fatal' }),
      browser: ['Group Only Bot', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', handleIncomingMessages);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info('New WhatsApp QR generated. Open the admin panel to scan it.');

        if (TERMINAL_QR_ENABLED) {
          qrcode.generate(qr, { small: true });
        }

        void updateBotRuntime({
          connection: 'qr',
          qr,
          qrUpdatedAt: ServerValue.TIMESTAMP
        });
      }

      if (connection === 'open') {
        logger.info({ allowedGroupJid: settings.ALLOWED_GROUP_JID }, 'Bot connected successfully.');
        void updateBotRuntime({
          connection: 'open',
          qr: null,
          connectedAt: ServerValue.TIMESTAMP
        });
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

        void updateBotRuntime({
          connection: 'closed',
          lastDisconnectStatusCode: statusCode,
          shouldReconnect
        });

        if (shouldReconnect) {
          logger.info('Reconnecting in 5 seconds...');
          scheduleReconnect();
        } else {
          logger.error('Bot logged out. Session must be cleared before a new QR can be generated.');
          void updateBotRuntime({
            connection: 'logged_out',
            qr: null,
            lastDisconnectStatusCode: statusCode
          });

          if (CLEAR_SESSION_ON_LOGOUT) {
            clearSessionData()
              .then(() => {
                logger.info('Session cleared. Restarting in 5 seconds so a new QR can be generated.');
                scheduleReconnect();
              })
              .catch((sessionError) => {
                logger.error({ error: serializeError(sessionError) }, 'Failed to clear session data.');
                logger.info('Retrying logout recovery in 5 seconds.');
                scheduleReconnect();
              });
          }
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
    watchSchedules();
    startScheduleWorker();
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
