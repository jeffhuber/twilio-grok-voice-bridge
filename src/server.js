/**
 * Twilio Media Streams ↔ xAI Grok Voice realtime bridge
 *
 * Places outbound Twilio calls, bridges μ-law 8 kHz audio both ways,
 * supports operator steer / transcript / hangup-gated end.
 */
'use strict';

require('dotenv').config({ override: true });

const crypto = require('crypto');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_HOST = (process.env.PUBLIC_HOST || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const XAI_API_KEY = process.env.XAI_API_KEY;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const REQUIRE_BRIDGE_AUTH = process.env.REQUIRE_BRIDGE_AUTH === '1';
const ENABLE_RECORDING = process.env.ENABLE_RECORDING === '1';
const SKIP_AI_DISCLOSURE = process.env.SKIP_AI_DISCLOSURE === '1';

/** Optional JSON map of alias → voice id, e.g. {"my-voice":"abc123","clone":"xyz"} */
function loadVoiceAliases() {
  const builtIn = {
    ara: 'ara',
    eve: 'Eve',
    rex: 'Rex',
    sal: 'Sal',
  };
  const raw = process.env.VOICE_ALIASES;
  if (!raw) return builtIn;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return { ...builtIn, ...parsed };
    }
  } catch (err) {
    console.warn('[warn] VOICE_ALIASES is not valid JSON — ignoring:', err.message);
  }
  return builtIn;
}

const VOICE_ALIASES = loadVoiceAliases();

function resolveVoiceId(requested) {
  const raw = String(requested || process.env.XAI_VOICE || process.env.GROK_VOICE || 'ara').trim();
  if (!raw) return 'ara';
  const key = raw.toLowerCase().replace(/\s+/g, '-');
  if (VOICE_ALIASES[key]) return VOICE_ALIASES[key];
  // Case-insensitive lookup
  for (const [alias, id] of Object.entries(VOICE_ALIASES)) {
    if (alias.toLowerCase() === key) return id;
  }
  return raw;
}

function voiceDisplayName(voiceId) {
  const id = resolveVoiceId(voiceId);
  for (const [alias, mapped] of Object.entries(VOICE_ALIASES)) {
    if (mapped === id || String(mapped).toLowerCase() === String(id).toLowerCase()) {
      // Prefer a human-looking alias (single word) when available
      if (/^[a-z][a-z0-9_-]*$/i.test(alias) && alias.length <= 24) {
        return alias.charAt(0).toUpperCase() + alias.slice(1);
      }
    }
  }
  const s = String(id);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Detect on-call requests to swap TTS voice using configured aliases + common names. */
function detectVoiceSwitchRequest(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;

  const aliasKeys = Object.keys(VOICE_ALIASES).map((k) => k.toLowerCase());
  const candidates = [...new Set([...aliasKeys, 'ara', 'eve', 'rex', 'sal'])];

  for (const name of candidates) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wants =
      new RegExp(
        `\\b(switch to|change to|use|speak (?:as|like)|talk (?:as|like)|become|let me (?:hear|talk to)|i want)\\b[^.!?]{0,32}\\b${escaped}\\b`
      ).test(t) ||
      new RegExp(`\\b${escaped}['']?s voice\\b`).test(t) ||
      new RegExp(`\\b(hey )?${escaped}[, ]+(please|now)\\b`).test(t) ||
      new RegExp(`\\bcan (?:i|we) (?:hear|use|talk to) ${escaped}\\b`).test(t) ||
      new RegExp(`\\bswitch to ${escaped}\\b`).test(t);
    if (wants) return name;
  }
  return null;
}

function switchSessionVoice(session, requested, { announce = true, reason = 'api' } = {}) {
  if (!session) return { ok: false, error: 'no session' };
  const next = resolveVoiceId(requested);
  const prev = session.voice;
  if (!next) return { ok: false, error: 'voice required' };
  if (next === prev) {
    return { ok: true, unchanged: true, voice: next, label: voiceDisplayName(next) };
  }

  clearSoftContinue(session);
  clearBargeInTimer(session);
  cancelGrokResponse(session, `voice-switch:${reason}`);

  session.voice = next;
  session.bargeInSuppressedUntil = Date.now() + 1000;
  sendGrok(session, {
    type: 'session.update',
    session: { voice: next },
  });

  console.log(
    `[voice] switch ${prev} -> ${next} (${voiceDisplayName(next)}) callSid=${session.callSid} reason=${reason}`
  );

  if (announce) {
    const label = voiceDisplayName(next);
    const contactHint = contactCoachHint();
    sendGrok(session, {
      type: 'response.create',
      response: {
        instructions: `The phone voice just switched to ${label}. Continue the SAME call naturally in this voice. Do NOT say you will grab/get/switch to someone, do not say "one sec," do not explain technology. At most a tiny "sure." If they just asked for name, time, seating, or phone, answer with REAL details only from the goal/context/contact rules — never invent names or phone numbers.${contactHint}`,
      },
    });
  }

  return { ok: true, voice: next, previous: prev, label: voiceDisplayName(next) };
}

const XAI_VOICE = resolveVoiceId(process.env.XAI_VOICE || process.env.GROK_VOICE || 'ara');
const XAI_MODEL = process.env.XAI_VOICE_MODEL || 'grok-voice-latest';
const XAI_REALTIME_URL = `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(XAI_MODEL)}`;

// Hold-music / IVR hardening: higher VAD threshold + longer silence
const VAD_THRESHOLD = Number(process.env.VAD_THRESHOLD || 0.7);
const VAD_SILENCE_MS = Number(process.env.VAD_SILENCE_MS || 800);
const VAD_PREFIX_MS = Number(process.env.VAD_PREFIX_MS || 300);
// Slightly snappier VAD when soft-continue is enabled
const VAD_SOFT_THRESHOLD = Number(process.env.VAD_SOFT_THRESHOLD || 0.72);
const VAD_SOFT_SILENCE_MS = Number(process.env.VAD_SOFT_SILENCE_MS || 350);
const BARGE_IN_COOLDOWN_MS = Number(process.env.BARGE_IN_COOLDOWN_MS || 450);
// Confirm barge-in only if user speech lasts this long — filters phone echo / blips that caused cut-outs.
const BARGE_IN_CONFIRM_MS = Number(process.env.BARGE_IN_CONFIRM_MS || 280);
// Don't allow barge-in clear in the first moments of an agent utterance (avoids chop on first syllable).
const BARGE_IN_MIN_AGENT_MS = Number(process.env.BARGE_IN_MIN_AGENT_MS || 300);
// Soft auto-continue: after agent finishes a turn, wait this long for a reaction, then keep going.
const SOFT_CONTINUE_MS = Number(process.env.SOFT_CONTINUE_MS || 400);
const SOFT_CONTINUE_MAX = Number(process.env.SOFT_CONTINUE_MAX || 8);

/** Call behavior profiles (independent of which TTS voice_id is used). */
const STYLE_PROFILES = {
  support: 'Professional errand/CS pacing; wait for IVR/humans; no soft-continue.',
  'restaurant-book':
    'Booking dinner/reservations; natural opener; CONTACT_* env rules; no soft-continue.',
  custom: 'Goal + context only; no built-in personal coaching; soft-continue optional via request.',
};

/** Optional contact pack for outbound booking / support calls (from env). */
function getContact() {
  const fullName = (process.env.CONTACT_FULL_NAME || '').trim();
  const mobile = (process.env.CONTACT_MOBILE || '').trim();
  return {
    fullName: fullName || null,
    mobile: mobile || null,
    spell: fullName
      ? fullName
          .split(/\s+/)
          .map((part) => part.split('').join('-').toUpperCase())
          .join(' ')
      : null,
  };
}

function formatMobileSpoken(mobile) {
  if (!mobile) return null;
  // Strip +1 / non-digits for US-style spoken readout when 10+ digits
  const digits = String(mobile).replace(/\D/g, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (local.length === 10) {
    const a = local.slice(0, 3).split('').join(' ');
    const b = local.slice(3, 6).split('').join(' ');
    const c = local.slice(6).split('').join(' ');
    return `${a}, ${b}, ${c}`;
  }
  return digits.split('').join(' ');
}

function contactCoachHint() {
  const c = getContact();
  if (c.fullName || c.mobile) {
    const bits = [];
    if (c.fullName) bits.push(`name ${c.fullName}`);
    if (c.mobile) bits.push(`mobile ${c.mobile}`);
    return ` Known contact: ${bits.join('; ')}.`;
  }
  return ' If contact details are missing from env/goal/context, ask the operator via [[HANGUP_REQUESTED]] or refuse inventing numbers — do not invent.';
}

/** English address terms banned on all calls. */
const UNIVERSAL_SPEECH_RULES = [
  '## Speech manners (UNIVERSAL)',
  'Never address anyone as "man" in English (no "hey man", "thanks man", "you know man").',
  'Also avoid English dude / bro / buddy as address terms — sound warm, clear, not bro-y.',
  'Farsi "man" (من = I) is fine; this ban is English vocative "man" only.',
].join('\n');

function buildRestaurantBookCoaching() {
  const c = getContact();
  const nameLine = c.fullName
    ? `Name on the reservation is ONLY ${c.fullName}${c.spell ? ` (spell ${c.spell} if asked)` : ''}.`
    : 'CONTACT_FULL_NAME is not set. Do NOT invent a name. If asked whose name: say you need to confirm with the person who asked you to book, or ask the operator — never invent a cover name.';
  const mobileLine = c.mobile
    ? [
        `Mobile ONLY if they explicitly ask for a phone/mobile/callback: ${c.mobile}.`,
        `Speak it clearly (US-domestic if 10-digit): "${formatMobileSpoken(c.mobile)}". No plus-one / +1 / country code unless this is clearly international.`,
        `FORBIDDEN phones: 555 numbers, Jenny/867-5309, example.com emails, any number that is not ${c.mobile}.`,
        'Do NOT volunteer the mobile unprompted. Do NOT invent or guess email.',
        `If they ask you to look it up: do NOT stall or fabricate. Use only ${c.fullName || 'the configured contact'} / ${c.mobile} as allowed above.`,
      ].join('\n')
    : [
        'CONTACT_MOBILE is not set. Do NOT invent a phone number.',
        'If they ask for a callback number: explain you do not have one to give, and ask them to proceed without it or that the booker will call back — never invent digits.',
      ].join('\n');

  const who = c.fullName || 'the contact named in the goal/context';

  return [
    '## Role & opener (CRITICAL)',
    `You are calling to make a restaurant reservation${c.fullName ? ` on behalf of ${c.fullName}` : ' (see goal/context for whose name)'}.`,
    'Open naturally — e.g. "Hi, I\'d like to make a reservation for tonight" — like a person booking dinner.',
    'NEVER say you are customer support, an AI, or "an assistant calling from customer support."',
    c.fullName
      ? `You may say you are calling for ${c.fullName} / booking for ${c.fullName}'s party once name is needed.`
      : 'Once name is needed, use ONLY a name present in the goal/context or CONTACT_FULL_NAME — never invent.',
    '',
    '## Contact details (CRITICAL — never invent)',
    nameLine,
    'FORBIDDEN: fake aliases, "using another name," inventing last names, or placeholder names (Alex Rivera, John Doe, etc.).',
    c.fullName
      ? `If asked whose name / who it is for: ${c.fullName}.`
      : 'If asked whose name and none is configured: do not invent — ask to hold while you confirm, or refuse politely.',
    mobileLine,
    'If they ask for email: you do not have an email to give; offer the mobile only if configured and they want a phone instead.',
    'Never fabricate confirmation codes or contact info you were not given.',
    '',
    '## Booking behavior',
    'State party size, preferred time, and seating clearly. Honor stated flexibility in the goal.',
    'If preferred seating/time is unavailable, ask for the next-best option from the goal.',
    'Confirm the final reservation details back once before closing.',
    '## Delivery energy',
    'Sound clear and lightly energetic — bright and engaged, not slow, sleepy, or flat.',
    'Normal conversational pace with a slight smile in the voice. Not manic, not salesy, not rushed.',
    'Be concise, warm-professional, and patient with holds/IVR.',
    'If they say the preferred room is booked, accept that and move on — do not re-ask the same seating as if available.',
    'If you use [pause], it is silent only — never say the word pause.',
    'After goodbye, always include [[HANGUP_REQUESTED]] so the operator can end the call.',
    '',
    '## Combo-call voice switching',
    'Voices may swap mid-call via operator or callee request.',
    'If the callee asks to switch, the AUDIO voice changes automatically. Continue as the same reservation — do not claim you cannot change voices.',
    'Do NOT narrate the swap (no "I\'ll grab someone", "one sec", "switching now"). Just keep talking in the new voice.',
    `After a switch, if they ask again for name/time/phone, restate the REAL confirmed details only (${who}, real time/seating, configured mobile only if they asked for a number).`,
  ].join('\n');
}

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
  console.warn('[warn] Twilio credentials incomplete — /call will fail until set');
}
if (!XAI_API_KEY) {
  console.warn('[warn] XAI_API_KEY missing — media-stream bridge will fail until set');
}
if (REQUIRE_BRIDGE_AUTH && !BRIDGE_API_KEY) {
  console.error('[error] REQUIRE_BRIDGE_AUTH=1 but BRIDGE_API_KEY is not set — server will refuse operator routes');
  process.exit(1);
}
if (!BRIDGE_API_KEY) {
  console.warn('');
  console.warn('[SECURITY WARNING] BRIDGE_API_KEY is not set!');
  console.warn('[SECURITY WARNING] Operator control-plane routes (/call, /steer, /hangup, /voice, /transcript) are UNPROTECTED.');
  console.warn('[SECURITY WARNING] Anyone who can reach this host can spend your Twilio account.');
  console.warn('[SECURITY WARNING] Set BRIDGE_API_KEY or put this server behind Cloudflare Access / localhost-only.');
  console.warn('');
}

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

/** @type {Map<string, CallSession>} callSid -> session */
const sessionsByCallSid = new Map();
/** Pending metadata keyed before stream start (callSid known after create) */
const pendingByCallSid = new Map();
/** @type {Map<string, {session: CallSession, createdAt: number}>} bridgeToken -> {session, timestamp} */
const pendingByToken = new Map();
/** @type {Map<string, {session: CallSession, createdAt: number}>} bridgeToken -> {session, timestamp} - claimed on upgrade */
const claimedTokens = new Map();

const BRIDGE_TOKEN_TTL_MS = Number(process.env.BRIDGE_TOKEN_TTL_MS || 120000); // 2 minutes

function generateBridgeToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function cleanupExpiredTokens() {
  const now = Date.now();
  for (const [token, entry] of pendingByToken.entries()) {
    if (now - entry.createdAt > BRIDGE_TOKEN_TTL_MS) {
      pendingByToken.delete(token);
      console.log(`[token] expired pending token=${token.slice(0, 12)}...`);
    }
  }
  for (const [token, entry] of claimedTokens.entries()) {
    if (now - entry.createdAt > BRIDGE_TOKEN_TTL_MS) {
      claimedTokens.delete(token);
      console.log(`[token] expired claimed token=${token.slice(0, 12)}...`);
    }
  }
}

setInterval(cleanupExpiredTokens, 60000);

const SESSION_MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_MS || 7200000); // 2 hours

function cleanupOrphanSessions() {
  const now = Date.now();
  let cleaned = 0;
  for (const [callSid, session] of sessionsByCallSid.entries()) {
    const age = now - (session.startedAt || now);
    const wsGone = !session.twilioWs || session.twilioWs.readyState !== WebSocket.OPEN;
    const grokGone = !session.grokWs || session.grokWs.readyState !== WebSocket.OPEN;
    const isOrphan = wsGone && grokGone;
    const isTooOld = age > SESSION_MAX_AGE_MS;

    if (isOrphan || isTooOld) {
      const reason = isTooOld ? 'max-age' : 'orphan';
      console.log(`[gc] cleanup session callSid=${callSid} reason=${reason} age=${Math.round(age / 1000)}s`);
      cleanupSession(session, { hangupTwilio: false });
      sessionsByCallSid.delete(callSid);
      pendingByCallSid.delete(callSid);
      cleaned += 1;
    }
  }
  if (cleaned > 0) {
    console.log(`[gc] cleaned ${cleaned} session(s)`);
  }
}

setInterval(cleanupOrphanSessions, 120000); // every 2 minutes

/**
 * @typedef {object} TranscriptLine
 * @property {'them'|'agent'} role
 * @property {string} text
 * @property {number} ts
 */

/**
 * @typedef {object} CallSession
 * @property {string} callSid
 * @property {string} [streamSid]
 * @property {string} goal
 * @property {string} [context]
 * @property {string} voice
 * @property {import('ws')|null} twilioWs
 * @property {import('ws')|null} grokWs
 * @property {TranscriptLine[]} transcript
 * @property {boolean} hangupRequested
 * @property {boolean} hangupApproved
 * @property {boolean} holdMode
 * @property {number} consecutiveNonSpeech
 * @property {string} instructions
 * @property {string} [agentPartial]
 */

function normalizeStyle(style) {
  const s = String(style || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!s) return 'support';
  if (['restaurant-book', 'restaurant', 'reservation', 'booking'].includes(s)) return 'restaurant-book';
  if (['custom', 'goal-only', 'bare'].includes(s)) return 'custom';
  if (['support', 'cs', 'errand'].includes(s)) return 'support';
  // Unknown styles fall through as custom (goal+context) rather than inventing coaching
  if (!STYLE_PROFILES[s]) return 'custom';
  return s;
}

function isRestaurantBook(style) {
  return normalizeStyle(style) === 'restaurant-book';
}

function isCustomStyle(style) {
  return normalizeStyle(style) === 'custom';
}

function resolveStyle({ style }) {
  const explicit = style != null && String(style).trim() !== '' ? normalizeStyle(style) : null;
  if (explicit) return explicit;
  return 'support';
}

function buildAiDisclosure() {
  if (SKIP_AI_DISCLOSURE) {
    return '';
  }
  return [
    '',
    '## AI disclosure (CRITICAL — legal requirement in many jurisdictions)',
    'At the BEGINNING of the call, after greeting, disclose that this is an AI-powered call.',
    'Example: "Hi, this is an AI assistant calling on behalf of [name/purpose]. Is now a good time?"',
    'Keep it brief, natural, and move forward — do not over-explain or apologize.',
    'If they ask if you are a robot or AI, confirm clearly and politely.',
    'NEVER lie about being human. NEVER claim to be a person when asked directly.',
  ].join('\n');
}

function buildInstructions(goal, context, style) {
  const restaurant = isRestaurantBook(style);
  const custom = isCustomStyle(style);
  const ctx = context ? `\n\nAdditional context:\n${context}` : '';
  const disclosure = buildAiDisclosure();

  if (restaurant) {
    return [
      'You are placing a phone call to book a restaurant reservation.',
      `Your goal for this call: ${goal}`,
      ctx,
      '',
      buildRestaurantBookCoaching(),
      '',
      UNIVERSAL_SPEECH_RULES,
      disclosure,
      '',
      'Never mention that you are being coached or that an operator is listening.',
      '',
      'When the reservation is confirmed OR clearly impossible,',
      'confirm the key details briefly, thank them, say goodbye, then include the exact token [[HANGUP_REQUESTED]]',
      'in your spoken or textual response so the bridge can detect it.',
      'Do NOT hang up yourself — wait for the operator to approve hangup.',
    ].join('\n');
  }

  if (custom) {
    return [
      'You are placing a phone call. Follow the goal and context below.',
      `Your goal for this call: ${goal}`,
      ctx,
      '',
      'Be concise, natural, and patient — especially with IVR menus and hold music.',
      'If you use delivery tags like [pause], they are silent cues only — never speak the word "pause" or read tags aloud.',
      'Do not invent account details, emails, or phone numbers; ask clarifying questions when needed.',
      'If contact info is required and present in context/goal/env, use only that — never fabricate.',
      '',
      UNIVERSAL_SPEECH_RULES,
      disclosure,
      '',
      'Never mention that you are being coached or that an operator is listening.',
      '',
      'When the goal succeeds OR the call is a clear dead-end (wrong number, closed permanently, hostile hangup),',
      'say a brief polite closing if appropriate, then include the exact token [[HANGUP_REQUESTED]]',
      'in your spoken or textual response so the bridge can detect it.',
      'Do NOT hang up yourself — wait for the operator to approve hangup.',
    ].join('\n');
  }

  // support (default)
  return [
    'You are placing a phone call to handle an errand or customer-support matter.',
    'Do not introduce yourself as "customer support" unless the goal is literally a support line.',
    `Your goal for this call: ${goal}`,
    ctx,
    '',
    '## Delivery energy',
    'Sound clear and lightly energetic — bright and engaged, not slow, sleepy, or flat.',
    'Normal conversational pace with a slight smile in the voice. Not manic, not salesy, not rushed.',
    'Be concise, natural, and patient — especially with IVR menus and hold music.',
    'If you use delivery tags like [pause], they are silent cues only — never speak the word "pause" or read tags aloud.',
    'Navigate phone trees carefully; use DTMF by speaking the digits you intend only if the bridge relays them; prefer waiting for human agents.',
    'Do not invent account details, emails, or phone numbers; ask clarifying questions when needed.',
    'If contact info is required and present in context/goal/env, use only that — never fabricate.',
    '',
    UNIVERSAL_SPEECH_RULES,
    disclosure,
    '',
    'Never mention that you are being coached or that an operator is listening.',
    '',
    'When the errand succeeds OR the call is a clear dead-end (wrong number, closed permanently, hostile hangup),',
    'say a brief polite closing if appropriate, then include the exact token [[HANGUP_REQUESTED]]',
    'in your spoken or textual response so the bridge can detect it.',
    'Do NOT hang up yourself — wait for the operator to approve hangup.',
  ].join('\n');
}

function createSession({ callSid, goal, context, voice, style, to, softContinue }) {
  const resolvedStyle = resolveStyle({ style });
  const soft = Boolean(softContinue);
  /** @type {CallSession} */
  const session = {
    callSid,
    goal,
    context: context || '',
    voice: resolveVoiceId(voice || XAI_VOICE),
    style: resolvedStyle,
    to: to || '',
    softContinue: soft,
    twilioWs: null,
    grokWs: null,
    transcript: [],
    hangupRequested: false,
    hangupApproved: false,
    holdMode: false,
    consecutiveNonSpeech: 0,
    startedAt: Date.now(),
    instructions: buildInstructions(goal, context, resolvedStyle),
    agentPartial: '',
    agentSpeaking: false,
    agentSpeakStartedAt: 0,
    lastAgentAudioAt: 0,
    userSpeaking: false,
    bargeInTimer: null,
    lastBargeInAt: 0,
    softContinueTimer: null,
    softContinueCount: 0,
    pendingPlaybackMark: null,
    bargeInSuppressedUntil: 0,
    vadThreshold: soft ? VAD_SOFT_THRESHOLD : VAD_THRESHOLD,
    vadSilenceMs: soft ? VAD_SOFT_SILENCE_MS : VAD_SILENCE_MS,
  };
  sessionsByCallSid.set(callSid, session);
  return session;
}

function appendTranscript(session, role, text) {
  const line = { role, text: String(text).trim(), ts: Date.now() };
  if (!line.text) return;
  const prev = session.transcript[session.transcript.length - 1];
  // Collapse streaming STT duplicates / prefix extensions
  if (prev && prev.role === role) {
    if (prev.text === line.text) return;
    if (line.text.startsWith(prev.text) || prev.text.startsWith(line.text)) {
      prev.text = line.text.length >= prev.text.length ? line.text : prev.text;
      prev.ts = line.ts;
      console.log(`[transcript] ${role}: ${prev.text.slice(0, 120)}`);
      return;
    }
  }
  session.transcript.push(line);
  console.log(`[transcript] ${role}: ${line.text.slice(0, 120)}`);
}

function detectHangupSignal(text) {
  if (!text) return false;
  return /\[\[HANGUP_REQUESTED\]\]/i.test(text) || /\bHANGUP_REQUESTED\b/.test(text);
}

function stripHangupToken(text) {
  return String(text || '')
    .replace(/\[\[HANGUP_REQUESTED\]\]/gi, '')
    .replace(/\bHANGUP_REQUESTED\b/g, '')
    .trim();
}

/** Heuristic: μ-law silence / low-energy loops look like hold music or IVR beds */
function analyzeMulawEnergy(b64) {
  try {
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return { energy: 0, variance: 0 };
    let sum = 0;
    let sumSq = 0;
    // Decode μ-law approx to linear magnitude (simple table-free approx)
    for (let i = 0; i < buf.length; i++) {
      const u = buf[i] ^ 0xff;
      const sign = u & 0x80;
      const exponent = (u >> 4) & 0x07;
      const mantissa = u & 0x0f;
      let sample = ((mantissa << 3) + 0x84) << exponent;
      sample -= 0x84;
      if (sign) sample = -sample;
      const a = Math.abs(sample);
      sum += a;
      sumSq += a * a;
    }
    const n = buf.length;
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    return { energy: mean, variance };
  } catch {
    return { energy: 0, variance: 0 };
  }
}

function maybeEnterHoldMode(session, mediaB64) {
  // Grace period: do not run hold heuristics for the first several seconds.
  // Inbound near-silence while the callee listens to our greeting is normal;
  // treating it as hold + Twilio "clear" was cutting out the first sentence.
  const HOLD_GRACE_MS = Number(process.env.HOLD_GRACE_MS || 8000);
  const HOLD_FRAMES = Number(process.env.HOLD_FRAMES || 120); // ~2.4s at 20ms/frame
  if (!session.startedAt) session.startedAt = Date.now();
  if (Date.now() - session.startedAt < HOLD_GRACE_MS) return;

  const { energy, variance } = analyzeMulawEnergy(mediaB64);
  // Hold MUSIC only: moderate energy + low variance. Do NOT treat silence as hold
  // (silence while they listen would cancel our outbound audio).
  const looksLikeHoldMusic = variance < 5e5 && energy > 400 && energy < 6000;

  if (looksLikeHoldMusic) {
    session.consecutiveNonSpeech += 1;
  } else {
    session.consecutiveNonSpeech = 0;
    if (session.holdMode) {
      session.holdMode = false;
      console.log(`[hold] exit hold mode callSid=${session.callSid}`);
      raiseVad(session, false);
    }
  }

  if (!session.holdMode && session.consecutiveNonSpeech >= HOLD_FRAMES) {
    session.holdMode = true;
    console.log(
      `[hold] enter hold mode callSid=${session.callSid} — raise VAD only (no Twilio clear)`
    );
    // Raise VAD so we don't babble over hold music, but do NOT clear/cancel
    // outbound audio (that caused the "cuts out after a few seconds" bug).
    raiseVad(session, true);
  }
}

function sendGrok(session, obj) {
  if (session.grokWs && session.grokWs.readyState === WebSocket.OPEN) {
    session.grokWs.send(JSON.stringify(obj));
  }
}

function cancelGrokResponse(session, reason) {
  clearBargeInTimer(session);
  clearSoftContinue(session);
  sendGrok(session, { type: 'response.cancel' });
  // Clear Twilio playback buffer so cancelled audio doesn't play
  if (session.twilioWs && session.twilioWs.readyState === WebSocket.OPEN && session.streamSid) {
    session.twilioWs.send(
      JSON.stringify({ event: 'clear', streamSid: session.streamSid })
    );
  }
  session.agentSpeaking = false;
  session.agentSpeakStartedAt = 0;
  session.agentPartial = '';
  if (reason) {
    console.log(`[barge-in] ${reason} callSid=${session.callSid}`);
  }
}

function clearBargeInTimer(session) {
  if (session.bargeInTimer) {
    clearTimeout(session.bargeInTimer);
    session.bargeInTimer = null;
  }
}

function maybeBargeIn(session, reason) {
  if (session.holdMode) return;
  if (!session.agentSpeaking) return;
  if (!session.userSpeaking) return;
  const now = Date.now();
  if (session.bargeInSuppressedUntil && now < session.bargeInSuppressedUntil) {
    console.log(`[barge-in] suppressed callSid=${session.callSid}`);
    return;
  }
  if (now - (session.lastBargeInAt || 0) < BARGE_IN_COOLDOWN_MS) return;
  if (
    session.agentSpeakStartedAt &&
    now - session.agentSpeakStartedAt < BARGE_IN_MIN_AGENT_MS
  ) {
    console.log(`[barge-in] skipped min-agent callSid=${session.callSid}`);
    return;
  }
  // Already waiting to confirm
  if (session.bargeInTimer) return;

  const started = now;
  session.bargeInTimer = setTimeout(() => {
    session.bargeInTimer = null;
    if (!session.userSpeaking || !session.agentSpeaking || session.holdMode) {
      console.log(`[barge-in] aborted (echo/blip) callSid=${session.callSid}`);
      return;
    }
    if (Date.now() - (session.lastBargeInAt || 0) < BARGE_IN_COOLDOWN_MS) return;
    session.lastBargeInAt = Date.now();
    cancelGrokResponse(session, `${reason || 'speech_started'} confirmed ${Date.now() - started}ms`);
  }, BARGE_IN_CONFIRM_MS);
  console.log(`[barge-in] pending confirm ${BARGE_IN_CONFIRM_MS}ms callSid=${session.callSid}`);
}

function clearSoftContinue(session) {
  if (session.softContinueTimer) {
    clearTimeout(session.softContinueTimer);
    session.softContinueTimer = null;
  }
}

function scheduleSoftContinue(session, reason) {
  if (!session.softContinue) return;
  if (session.hangupRequested || session.hangupApproved) return;
  if (session.holdMode || session.userSpeaking) return;
  if ((session.softContinueCount || 0) >= SOFT_CONTINUE_MAX) return;
  clearSoftContinue(session);
  const why = reason || 'timer';
  session.softContinueTimer = setTimeout(() => {
    session.softContinueTimer = null;
    if (!session.softContinue) return;
    if (session.hangupRequested || session.hangupApproved) return;
    if (session.holdMode || session.userSpeaking || session.agentSpeaking) {
      console.log(
        `[soft-continue] skipped busy callSid=${session.callSid} user=${session.userSpeaking} agent=${session.agentSpeaking}`
      );
      return;
    }
    if (!session.grokWs || session.grokWs.readyState !== WebSocket.OPEN) return;
    session.softContinueCount = (session.softContinueCount || 0) + 1;
    // Suppress echo barge-in briefly while the continue utterance starts
    session.bargeInSuppressedUntil = Date.now() + 900;
    console.log(
      `[soft-continue] nudge #${session.softContinueCount} (${why}) callSid=${session.callSid}`
    );
    sendGrok(session, {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              '[bridge-continue] The other party is still on the line and quiet. Speak now: next 1–2 new sentences (or finish). Do not wait. Do not repeat yourself. If the call is done, say goodbye and include [[HANGUP_REQUESTED]].',
          },
        ],
      },
    });
    sendGrok(session, { type: 'response.create' });
  }, SOFT_CONTINUE_MS);
}

function raiseVad(session, hold) {
  const baseThresh = session.vadThreshold ?? VAD_THRESHOLD;
  const baseSilence = session.vadSilenceMs ?? VAD_SILENCE_MS;
  const threshold = hold ? Math.min(0.95, baseThresh + 0.15) : baseThresh;
  const silence = hold ? Math.max(baseSilence, 1200) : baseSilence;
  sendGrok(session, {
    type: 'session.update',
    session: {
      turn_detection: {
        type: 'server_vad',
        threshold,
        silence_duration_ms: silence,
        prefix_padding_ms: VAD_PREFIX_MS,
        // OpenAI-compatible hint; ignored if unsupported
        interrupt_response: true,
      },
    },
  });
}

function buildSessionUpdate(session) {
  return {
    type: 'session.update',
    session: {
      voice: session.voice,
      instructions: session.instructions,
      turn_detection: {
        type: 'server_vad',
        threshold: session.vadThreshold ?? VAD_THRESHOLD,
        silence_duration_ms: session.vadSilenceMs ?? VAD_SILENCE_MS,
        prefix_padding_ms: VAD_PREFIX_MS,
        interrupt_response: true,
      },
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          // Enable input transcription when supported
          transcription: {},
        },
        output: {
          format: { type: 'audio/pcmu' },
        },
      },
    },
  };
}

function openGrokSession(session) {
  if (!XAI_API_KEY) {
    console.error('[grok] XAI_API_KEY not set');
    return;
  }
  if (session.grokWs) {
    try {
      session.grokWs.close();
    } catch {
      /* ignore */
    }
  }

  console.log(`[grok] connecting model=${XAI_MODEL} voice=${session.voice}`);
  const grokWs = new WebSocket(XAI_REALTIME_URL, {
    headers: { Authorization: `Bearer ${XAI_API_KEY}` },
  });
  session.grokWs = grokWs;

  grokWs.on('open', () => {
    console.log(`[grok] open callSid=${session.callSid}`);
    sendGrok(session, buildSessionUpdate(session));
  });

  grokWs.on('message', (data, isBinary) => {
    if (isBinary) {
      // Binary output transport not used; ignore
      return;
    }
    if (!data || (typeof data !== 'string' && !Buffer.isBuffer(data))) {
      console.warn(`[grok] invalid data type callSid=${session.callSid}`);
      return;
    }
    let event;
    try {
      const text = data.toString();
      if (!text || text.trim() === '') {
        console.warn(`[grok] empty message callSid=${session.callSid}`);
        return;
      }
      event = JSON.parse(text);
    } catch (err) {
      console.error(`[grok] JSON parse error callSid=${session.callSid}:`, err.message);
      return;
    }
    if (!event || typeof event !== 'object') {
      console.warn(`[grok] non-object event callSid=${session.callSid}`);
      return;
    }
    handleGrokEvent(session, event);
  });

  grokWs.on('error', (err) => {
    console.error(`[grok] error callSid=${session.callSid}:`, err.message);
  });

  grokWs.on('close', (code, reason) => {
    console.log(`[grok] close callSid=${session.callSid} code=${code} reason=${reason}`);
    if (session.grokWs === grokWs) session.grokWs = null;
  });
}

function handleGrokEvent(session, event) {
  const type = event.type || '';

  switch (type) {
    case 'session.created':
    case 'session.updated':
      console.log(`[grok] ${type}`);
      break;

    case 'response.output_audio.delta':
    case 'response.audio.delta': {
      const delta = event.delta || event.audio;
      if (delta && session.twilioWs && session.streamSid) {
        const now = Date.now();
        if (!session.agentSpeaking) session.agentSpeakStartedAt = now;
        session.agentSpeaking = true;
        session.lastAgentAudioAt = now;
        session.twilioWs.send(
          JSON.stringify({
            event: 'media',
            streamSid: session.streamSid,
            media: { payload: delta },
          })
        );
      }
      break;
    }

    case 'input_audio_buffer.speech_started': {
      session.userSpeaking = true;
      clearSoftContinue(session);
      // Confirm after BARGE_IN_CONFIRM_MS so brief echo doesn't chop agent audio
      maybeBargeIn(session, 'speech_started');
      break;
    }

    case 'input_audio_buffer.speech_stopped': {
      session.userSpeaking = false;
      clearBargeInTimer(session);
      break;
    }

    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta': {
      const d = event.delta || '';
      session.agentPartial = (session.agentPartial || '') + d;
      if (detectHangupSignal(session.agentPartial)) {
        session.hangupRequested = true;
        console.log(`[hangup] model requested hangup callSid=${session.callSid} (awaiting /hangup)`);
      }
      break;
    }

    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done': {
      const text = stripHangupToken(event.transcript || session.agentPartial || '');
      if (detectHangupSignal(event.transcript || session.agentPartial || '')) {
        session.hangupRequested = true;
      }
      if (text) appendTranscript(session, 'agent', text);
      session.agentPartial = '';
      break;
    }

    case 'response.output_text.delta':
    case 'response.text.delta': {
      const d = event.delta || '';
      session.agentPartial = (session.agentPartial || '') + d;
      if (detectHangupSignal(session.agentPartial)) {
        session.hangupRequested = true;
      }
      break;
    }

    case 'response.output_text.done':
    case 'response.text.done': {
      const text = stripHangupToken(event.text || session.agentPartial || '');
      if (detectHangupSignal(event.text || session.agentPartial || '')) {
        session.hangupRequested = true;
      }
      if (text) appendTranscript(session, 'agent', text);
      session.agentPartial = '';
      break;
    }

    case 'conversation.item.input_audio_transcription.completed':
    case 'conversation.item.input_audio_transcription.updated': {
      const text = event.transcript || event.text || '';
      if (text) {
        appendTranscript(session, 'them', text);
        const want = detectVoiceSwitchRequest(text);
        if (want) {
          const result = switchSessionVoice(session, want, {
            announce: true,
            reason: 'callee-request',
          });
          if (result.ok && !result.unchanged) {
            appendTranscript(session, 'agent', `[voice -> ${result.label}]`);
          }
        }
      }
      break;
    }

    case 'response.done': {
      session.agentSpeaking = false;
      session.agentSpeakStartedAt = 0;
      // Mark when Twilio finishes playing THIS response — soft-continue waits for that
      // (scheduling on response.done was too early: generation ends before playback).
      if (session.twilioWs && session.streamSid) {
        const markName = `resp_${Date.now()}`;
        session.pendingPlaybackMark = markName;
        session.twilioWs.send(
          JSON.stringify({
            event: 'mark',
            streamSid: session.streamSid,
            mark: { name: markName },
          })
        );
      } else if (session.softContinue) {
        scheduleSoftContinue(session, 'no-twilio-mark');
      }
      break;
    }

    case 'error':
      console.error('[grok] server error:', JSON.stringify(event.error || event));
      break;

    default:
      // Keep noise low; uncomment for deep debug:
      // if (!type.includes('delta')) console.log('[grok] event', type);
      break;
  }
}

function handleTwilioMessage(session, raw) {
  if (!raw || (typeof raw !== 'string' && !Buffer.isBuffer(raw))) {
    console.warn(`[twilio] invalid data type callSid=${session.callSid}`);
    return;
  }
  let msg;
  try {
    const text = raw.toString();
    if (!text || text.trim() === '') {
      console.warn(`[twilio] empty message callSid=${session.callSid}`);
      return;
    }
    msg = JSON.parse(text);
  } catch (err) {
    console.error(`[twilio] JSON parse error callSid=${session.callSid}:`, err.message);
    return;
  }
  if (!msg || typeof msg !== 'object') {
    console.warn(`[twilio] non-object message callSid=${session.callSid}`);
    return;
  }
  const event = msg.event;

  switch (event) {
    case 'connected':
      console.log(`[twilio] connected callSid=${session.callSid}`);
      break;

    case 'start': {
      session.streamSid = msg.start?.streamSid || msg.streamSid;
      const custom = msg.start?.customParameters || {};
      if (custom.goal && !session.goal) session.goal = custom.goal;
      if (custom.context && (!session.context || custom.context.length > session.context.length)) {
        session.context = custom.context;
      }
      if (custom.voice) session.voice = resolveVoiceId(custom.voice);
      if (custom.style) session.style = normalizeStyle(custom.style);
      if (custom.softContinue === 'true' || custom.softContinue === '1') {
        session.softContinue = true;
      }
      session.vadThreshold = session.softContinue ? VAD_SOFT_THRESHOLD : VAD_THRESHOLD;
      session.vadSilenceMs = session.softContinue ? VAD_SOFT_SILENCE_MS : VAD_SILENCE_MS;
      session.instructions = buildInstructions(session.goal, session.context, session.style);
      console.log(
        `[twilio] start streamSid=${session.streamSid} callSid=${session.callSid} style=${session.style || 'support'} goal=${(session.goal || '').slice(0, 60)}`
      );
      break;
    }

    case 'media': {
      const payload = msg.media?.payload;
      if (!payload) break;
      maybeEnterHoldMode(session, payload);
      // Forward μ-law base64 unchanged to Grok
      sendGrok(session, { type: 'input_audio_buffer.append', audio: payload });
      break;
    }

    case 'dtmf': {
      const digit = msg.dtmf?.digit;
      console.log(`[twilio] dtmf digit=${digit} callSid=${session.callSid}`);
      appendTranscript(session, 'them', `[DTMF ${digit}]`);
      // Inject as text cue so the model knows a key was pressed on the far end
      sendGrok(session, {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `IVR/DTMF digit received: ${digit}` }],
        },
      });
      break;
    }

    case 'mark': {
      const markName = msg.mark?.name || '';
      // Playback reached our end-of-response mark → now the user hears silence
      if (
        markName &&
        session.pendingPlaybackMark &&
        markName === session.pendingPlaybackMark
      ) {
        session.pendingPlaybackMark = null;
        console.log(`[playback] drained callSid=${session.callSid} mark=${markName}`);
        scheduleSoftContinue(session, 'after-playback');
      }
      break;
    }

    case 'stop':
      console.log(`[twilio] stop callSid=${session.callSid}`);
      cleanupSession(session, { hangupTwilio: false });
      break;

    default:
      break;
  }
}

async function hangupTwilioCall(callSid) {
  if (!twilioClient || !callSid) return;
  try {
    await twilioClient.calls(callSid).update({ status: 'completed' });
    console.log(`[hangup] Twilio call completed callSid=${callSid}`);
  } catch (err) {
    console.error(`[hangup] Twilio update failed:`, err.message);
  }
}

function cleanupSession(session, { hangupTwilio } = { hangupTwilio: false }) {
  clearBargeInTimer(session);
  clearSoftContinue(session);
  try {
    if (session.grokWs) {
      session.grokWs.close();
      session.grokWs = null;
    }
  } catch {
    /* ignore */
  }
  try {
    if (session.twilioWs && session.twilioWs.readyState === WebSocket.OPEN) {
      session.twilioWs.close();
    }
  } catch {
    /* ignore */
  }
  session.twilioWs = null;
  if (hangupTwilio) {
    hangupTwilioCall(session.callSid).catch(() => {});
  }
}

function buildConnectTwiml({ goal, context, voice, style, softContinue, bridgeToken }) {
  if (!PUBLIC_HOST) {
    throw new Error('PUBLIC_HOST is not set (hostname only, no scheme)');
  }
  if (!bridgeToken) {
    throw new Error('bridgeToken is required');
  }
  const streamUrl = `wss://${PUBLIC_HOST}/media-stream?bridgeToken=${encodeURIComponent(bridgeToken)}`;
  const vr = new twilio.twiml.VoiceResponse();
  const connect = vr.connect();
  const stream = connect.stream({ url: streamUrl });
  // Custom parameters appear on Twilio start.customParameters (length-capped)
  stream.parameter({ name: 'goal', value: String(goal || '').slice(0, 500) });
  if (context) stream.parameter({ name: 'context', value: String(context).slice(0, 500) });
  if (voice) stream.parameter({ name: 'voice', value: String(voice).slice(0, 100) });
  if (style) stream.parameter({ name: 'style', value: String(style).slice(0, 40) });
  if (softContinue) stream.parameter({ name: 'softContinue', value: 'true' });
  stream.parameter({ name: 'bridgeToken', value: bridgeToken });
  return vr.toString();
}

// ─── HTTP + WS server ───────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

function requireBridgeAuth(req, res, next) {
  if (!BRIDGE_API_KEY) {
    if (REQUIRE_BRIDGE_AUTH) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const xBridgeKey = req.headers['x-bridge-key'] || '';

  let providedKey = null;
  if (authHeader.startsWith('Bearer ')) {
    providedKey = authHeader.slice(7);
  } else if (xBridgeKey) {
    providedKey = xBridgeKey;
  }

  if (!providedKey) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const keyBuf = Buffer.from(BRIDGE_API_KEY, 'utf8');
  const providedBuf = Buffer.from(providedKey, 'utf8');

  if (keyBuf.length !== providedBuf.length) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!crypto.timingSafeEqual(keyBuf, providedBuf)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  next();
}

app.get('/health', (_req, res) => {
  let active = 0;
  for (const s of sessionsByCallSid.values()) {
    if (s.twilioWs || s.grokWs) active += 1;
  }
  res.json({
    ok: true,
    publicHostSet: Boolean(PUBLIC_HOST),
    publicHost: PUBLIC_HOST || null,
    activeCallCount: active,
    pendingCount: pendingByCallSid.size,
    voiceDefault: XAI_VOICE,
    model: XAI_MODEL,
    bargeIn: true,
    softContinueMs: SOFT_CONTINUE_MS,
    voiceSwitch: true,
    styles: Object.keys(STYLE_PROFILES),
    contactConfigured: Boolean(getContact().fullName || getContact().mobile),
    authRequired: Boolean(BRIDGE_API_KEY),
  });
});

app.post('/call', requireBridgeAuth, async (req, res) => {
  try {
    const { to, goal, context, voice, style, softContinue } = req.body || {};
    if (!to || !goal) {
      return res.status(400).json({ error: 'to and goal are required' });
    }
    if (!twilioClient) {
      return res.status(500).json({ error: 'Twilio client not configured' });
    }
    if (!PUBLIC_HOST) {
      return res.status(500).json({ error: 'PUBLIC_HOST not set' });
    }

    const resolvedVoice = resolveVoiceId(voice || XAI_VOICE);
    const resolvedStyle = resolveStyle({ style });
    const wantSoft = Boolean(softContinue);
    
    const bridgeToken = generateBridgeToken();
    
    const twiml = buildConnectTwiml({
      goal,
      context,
      voice: resolvedVoice,
      style: resolvedStyle,
      softContinue: wantSoft,
      bridgeToken,
    });

    const call = await twilioClient.calls.create({
      to,
      from: TWILIO_FROM_NUMBER,
      twiml,
      record: ENABLE_RECORDING,
      recordingChannels: ENABLE_RECORDING ? 'dual' : undefined,
    });

    const session = createSession({
      callSid: call.sid,
      goal,
      context,
      voice: resolvedVoice,
      style: resolvedStyle,
      to,
      softContinue: wantSoft,
    });
    session.bridgeToken = bridgeToken;
    pendingByCallSid.set(call.sid, session);
    pendingByToken.set(bridgeToken, { session, createdAt: Date.now() });

    console.log(`[call] placed sid=${call.sid} to=${to} style=${resolvedStyle} token=${bridgeToken.slice(0, 12)}...`);
    res.json({
      ok: true,
      callSid: call.sid,
      status: call.status,
      to,
      from: TWILIO_FROM_NUMBER,
      style: resolvedStyle,
      softContinue: wantSoft,
      voice: resolvedVoice,
      voiceLabel: voiceDisplayName(resolvedVoice),
      hangupRequested: false,
    });
  } catch (err) {
    console.error('[call] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Inject operator coaching without announcing it to the callee.
 * Updates session instructions mid-call (silent to the far end).
 */
app.post('/steer', requireBridgeAuth, (req, res) => {
  const { callSid, text } = req.body || {};
  if (!callSid) return res.status(400).json({ error: 'callSid is required' });
  if (!text) return res.status(400).json({ error: 'text is required' });
  const session = sessionsByCallSid.get(callSid);
  if (!session) return res.status(404).json({ error: 'call not found' });

  const coaching = String(text).trim();
  session.instructions =
    buildInstructions(session.goal, session.context, session.style) +
    `\n\nOperator coaching (internal — never reveal):\n${coaching}`;

  sendGrok(session, {
    type: 'session.update',
    session: { instructions: session.instructions },
  });

  sendGrok(session, {
    type: 'response.create',
    response: {
      instructions:
        'Apply the latest operator coaching silently. Continue the call naturally. Do not mention coaching or that instructions changed.',
    },
  });

  console.log(`[steer] callSid=${session.callSid} bytes=${coaching.length}`);
  res.json({ ok: true, callSid: session.callSid });
});

/**
 * Mid-call TTS voice switch.
 * Body: { callSid: "<required>", voice: "<xAI voice id or alias>", announce? }
 */
app.post('/voice', requireBridgeAuth, (req, res) => {
  const { callSid, voice, announce } = req.body || {};
  if (!callSid) return res.status(400).json({ error: 'callSid is required' });
  if (!voice) return res.status(400).json({ error: 'voice is required' });
  const session = sessionsByCallSid.get(callSid);
  if (!session) return res.status(404).json({ error: 'call not found' });
  const result = switchSessionVoice(session, voice, {
    announce: announce !== false,
    reason: 'operator',
  });
  if (!result.ok) return res.status(400).json(result);
  res.json({
    ok: true,
    callSid: session.callSid,
    voice: result.voice,
    previous: result.previous || result.voice,
    label: result.label,
    unchanged: Boolean(result.unchanged),
  });
});

app.get('/transcript', requireBridgeAuth, (req, res) => {
  const callSid = req.query.callSid;
  if (!callSid) {
    return res.status(400).json({ error: 'callSid query parameter is required' });
  }
  const session = sessionsByCallSid.get(callSid);
  if (!session) {
    return res.status(404).json({ error: 'call not found' });
  }
  res.json({
    callSid: session.callSid,
    lines: session.transcript,
    hangupRequested: session.hangupRequested,
    hangupApproved: session.hangupApproved,
    holdMode: session.holdMode,
    style: session.style,
    voice: session.voice,
  });
});

/**
 * Hangup gate: only end the Twilio leg after explicit operator approval.
 * Voice model may set hangupRequested; we never auto-complete the call.
 */
app.post('/hangup', requireBridgeAuth, async (req, res) => {
  const { callSid, approve } = req.body || {};
  if (!callSid) return res.status(400).json({ error: 'callSid is required' });
  const session = sessionsByCallSid.get(callSid);
  if (!session) return res.status(404).json({ error: 'call not found' });

  // Default: approve hangup when /hangup is called (operator action)
  const approved = approve !== false;
  if (!approved) {
    return res.json({
      ok: false,
      message: 'approve must be true (or omitted) to hang up',
      hangupRequested: session.hangupRequested,
    });
  }

  session.hangupApproved = true;
  console.log(
    `[hangup] operator approved callSid=${session.callSid} (modelRequested=${session.hangupRequested})`
  );
  cleanupSession(session, { hangupTwilio: true });
  sessionsByCallSid.delete(session.callSid);
  pendingByCallSid.delete(session.callSid);
  res.json({ ok: true, callSid: session.callSid });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const path = (req.url || '').split('?')[0];
  if (path === '/media-stream') {
    const url = new URL(req.url || '', `wss://${PUBLIC_HOST || req.headers.host}`);
    const bridgeToken = url.searchParams.get('bridgeToken');

    if (!bridgeToken) {
      console.error('[media-stream] No bridgeToken in request');
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // 409 path: check claimed first, then pending, else 403
    if (claimedTokens.has(bridgeToken)) {
      console.error(`[media-stream] Token already claimed bridgeToken=${bridgeToken.slice(0, 12)}...`);
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
      socket.destroy();
      return;
    }

    const entry = pendingByToken.get(bridgeToken);
    if (!entry) {
      console.error(`[media-stream] Unknown or expired bridgeToken=${bridgeToken.slice(0, 12)}...`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const now = Date.now();
    if (now - entry.createdAt > BRIDGE_TOKEN_TTL_MS) {
      pendingByToken.delete(bridgeToken);
      console.error(`[media-stream] Expired bridgeToken=${bridgeToken.slice(0, 12)}...`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    console.log(`[media-stream] Claiming bridgeToken=${bridgeToken.slice(0, 12)}...`);
    claimedTokens.set(bridgeToken, entry);
    pendingByToken.delete(bridgeToken);

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  console.log('[twilio] media-stream websocket connected');

  const url = new URL(req.url || '', `wss://${PUBLIC_HOST || req.headers.host}`);
  const bridgeToken = url.searchParams.get('bridgeToken');

  if (!bridgeToken) {
    console.error('[twilio] No bridgeToken on connection');
    ws.close(1008, 'Missing bridgeToken');
    return;
  }

  const entry = claimedTokens.get(bridgeToken);
  if (!entry) {
    console.error(`[twilio] Token not claimed bridgeToken=${bridgeToken.slice(0, 12)}...`);
    ws.close(1008, 'Invalid bridgeToken');
    return;
  }

  /** @type {CallSession|null} */
  let session = entry.session;
  let boundToCallSid = false;

  ws.on('message', (data) => {
    if (!data || (typeof data !== 'string' && !Buffer.isBuffer(data))) {
      console.warn('[twilio] invalid data type on media-stream ws');
      return;
    }
    let msg;
    try {
      const text = data.toString();
      if (!text || text.trim() === '') {
        console.warn('[twilio] empty message on media-stream ws');
        return;
      }
      msg = JSON.parse(text);
    } catch (err) {
      console.error('[twilio] JSON parse error on media-stream ws:', err.message);
      return;
    }
    if (!msg || typeof msg !== 'object') {
      console.warn('[twilio] non-object message on media-stream ws');
      return;
    }

    if (msg.event === 'start') {
      const resolvedSid = msg.start?.callSid;
      const custom = msg.start?.customParameters || {};
      const tokenFromCustom = custom.bridgeToken;

      if (!resolvedSid) {
        console.error('[twilio] start event missing callSid');
        ws.close(1008, 'Missing CallSid');
        return;
      }

      if (tokenFromCustom && tokenFromCustom !== bridgeToken) {
        console.error(`[twilio] bridgeToken mismatch: URL=${bridgeToken.slice(0, 12)}... custom=${tokenFromCustom.slice(0, 12)}...`);
        ws.close(1008, 'Token mismatch');
        return;
      }

      if (session.callSid !== resolvedSid) {
        console.error(`[twilio] CallSid mismatch: expected=${session.callSid} actual=${resolvedSid} token=${bridgeToken.slice(0, 12)}...`);
        ws.close(1008, 'CallSid mismatch');
        return;
      }

      // Reject duplicate start events after CallSid bind (prevents re-applying custom params)
      if (boundToCallSid) {
        console.warn(`[twilio] duplicate start event ignored callSid=${resolvedSid}`);
        return;
      }

      // Prevent duplicate active streams for the same CallSid
      if (session.twilioWs && session.twilioWs !== ws && session.twilioWs.readyState === WebSocket.OPEN) {
        console.error(`[twilio] duplicate stream rejected for callSid=${resolvedSid} — one active stream per CallSid`);
        ws.close(1008, 'Duplicate stream');
        return;
      }

      pendingByCallSid.delete(resolvedSid);
      claimedTokens.delete(bridgeToken);

      session.twilioWs = ws;
      session.streamSid = msg.start?.streamSid || msg.streamSid;

      // After CallSid bind, ignore forged custom params (operator set these at /call).
      // Do NOT overwrite goal/context/voice from potentially forged Twilio stream data.

      boundToCallSid = true;
      console.log(
        `[twilio] bound token=${bridgeToken.slice(0, 12)}... to callSid=${resolvedSid} streamSid=${session.streamSid} style=${session.style || 'support'}`
      );

      openGrokSession(session);
      return;
    }

    if (!boundToCallSid) {
      console.warn(`[twilio] Received ${msg.event} before callSid binding — buffering not supported`);
      return;
    }

    handleTwilioMessage(session, data);
  });

  ws.on('close', () => {
    console.log('[twilio] media-stream closed');
    if (session) {
      session.twilioWs = null;
      if (session.grokWs) {
        try {
          session.grokWs.close();
        } catch {
          /* ignore */
        }
        session.grokWs = null;
      }
    }
    if (bridgeToken) {
      const originalEntry = claimedTokens.get(bridgeToken);
      claimedTokens.delete(bridgeToken);
      // Token DoS mitigation: restore token to pending if never bound to CallSid.
      // This prevents leaked token connect/disconnect loops from burning the real stream.
      // Preserve original createdAt so TTL countdown is not reset on burn attempts.
      if (!boundToCallSid && session) {
        const originalCreatedAt = originalEntry?.createdAt || Date.now();
        const entry = { session, createdAt: originalCreatedAt };
        pendingByToken.set(bridgeToken, entry);
        console.log(`[token] restored to pending (not bound) token=${bridgeToken.slice(0, 12)}... preserving original TTL`);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[twilio] ws error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] PUBLIC_HOST=${PUBLIC_HOST || '(not set)'}`);
  console.log(`[server] media stream wss://${PUBLIC_HOST || 'PUBLIC_HOST'}/media-stream`);
  console.log(`[server] voice=${XAI_VOICE} model=${XAI_MODEL}`);
});
