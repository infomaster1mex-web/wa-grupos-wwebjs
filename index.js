const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.SOS_API_KEY || 'cambia_esto';
const SESSION_ID = process.env.SESSION_ID || 'grupos';
const CHROME_BIN = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN || '/usr/bin/chromium';
const AUTH_ROOT = process.env.AUTH_ROOT || '/app/auth_info';
const AUTH_PATH = path.join(AUTH_ROOT, 'wwebjs_auth');
const ADMIN_PHONE = normalizePhone(process.env.ADMIN_PHONE || '');
const GROUP_SEND_TIMEOUT_MS = Number(process.env.GROUP_SEND_TIMEOUT_MS || 90000);
const SEND_PAUSE_MS = Number(process.env.SEND_PAUSE_MS || 1500);
const GROUP_SKIP_COMMUNITIES = String(process.env.GROUP_SKIP_COMMUNITIES || 'true').toLowerCase() !== 'false';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

// URLs de workers para broadcast de estados (separadas por coma)
// Ej: "https://wa-worker1.up.railway.app,https://wa-worker2.up.railway.app"
const WORKER_URLS = (process.env.WORKER_URLS || '')
  .split(',')
  .map(u => u.trim().replace(/\/+$/, ''))
  .filter(Boolean);

// ============ PROGRAMADOR DE ENVÍOS ============
const SCHEDULE_FILE = path.join(AUTH_ROOT, 'scheduled_jobs.json');
const TZ = 'America/Mexico_City';

function loadScheduledJobs() {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    console.log('[SCHEDULER] Error leyendo jobs:', e.message);
  }
  return [];
}

function saveScheduledJobs(jobs) {
  try {
    fs.mkdirSync(path.dirname(SCHEDULE_FILE), { recursive: true });
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(jobs, null, 2), 'utf8');
  } catch (e) {
    console.log('[SCHEDULER] Error guardando jobs:', e.message);
  }
}

function parseMexicoTime(timeStr) {
  // Parsea expresiones como: "8pm", "20:00", "hoy 8pm", "mañana 10am", "mañana 15:30"
  const now = new Date();
  const mexicoNow = new Date(now.toLocaleString('en-US', { timeZone: TZ }));

  let targetDate = new Date(mexicoNow);
  let text = String(timeStr || '').toLowerCase().trim();

  // Detectar "mañana"
  if (text.includes('mañana') || text.includes('manana')) {
    targetDate.setDate(targetDate.getDate() + 1);
    text = text.replace(/mañana|manana/g, '').trim();
  }
  // Detectar "hoy" (no cambia fecha, solo limpiar)
  text = text.replace(/hoy/g, '').trim();

  // Parsear hora: "8pm", "8:30pm", "20:00", "8 pm", "10am"
  let hours = -1, minutes = 0;

  // Formato 12h: 8pm, 8:30pm, 8 pm, 10:00 am
  const match12 = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (match12) {
    hours = parseInt(match12[1]);
    minutes = parseInt(match12[2] || '0');
    const period = match12[3].toLowerCase();
    if (period === 'pm' && hours < 12) hours += 12;
    if (period === 'am' && hours === 12) hours = 0;
  }

  // Formato 24h: 20:00, 15:30, 08:00
  if (hours === -1) {
    const match24 = text.match(/(\d{1,2}):(\d{2})/);
    if (match24) {
      hours = parseInt(match24[1]);
      minutes = parseInt(match24[2]);
    }
  }

  // Solo hora sin formato: "8", "20"
  if (hours === -1) {
    const matchHour = text.match(/^(\d{1,2})$/);
    if (matchHour) {
      hours = parseInt(matchHour[1]);
      // Si ponen solo "8" y es menor a 7, asumir PM
      if (hours >= 1 && hours <= 7) hours += 12;
    }
  }

  if (hours === -1 || hours > 23 || minutes > 59) return null;

  targetDate.setHours(hours, minutes, 0, 0);

  // Convertir de Mexico a UTC para el timestamp real
  const mexicoOffset = mexicoNow.getTime() - now.getTime();
  const utcTarget = new Date(targetDate.getTime() - mexicoOffset);

  // Si ya pasó esa hora hoy y no dijo "mañana", programar para mañana
  if (utcTarget.getTime() <= Date.now()) {
    utcTarget.setDate(utcTarget.getDate() + 1);
    targetDate.setDate(targetDate.getDate() + 1);
  }

  return { utc: utcTarget.getTime(), display: targetDate };
}

function formatScheduleTime(utcMs) {
  return new Date(utcMs).toLocaleString('es-MX', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

let scheduledJobs = [];
let schedulerInterval = null;

function scheduleJob({ target, caption, mediaData, mediaMimetype, mediaFilename, sendAt }) {
  const job = {
    id: Date.now(),
    target, // 'groups', 'status', 'both'
    caption: caption || '',
    mediaData: mediaData || null,
    mediaMimetype: mediaMimetype || null,
    mediaFilename: mediaFilename || null,
    sendAt,
    createdAt: Date.now(),
    status: 'pending',
  };
  scheduledJobs.push(job);
  saveScheduledJobs(scheduledJobs);
  console.log(`[SCHEDULER] Job #${job.id} programado para ${formatScheduleTime(sendAt)} → ${target}`);
  return job;
}

function cancelJob(index) {
  if (index < 0 || index >= scheduledJobs.length) return null;
  const job = scheduledJobs.splice(index, 1)[0];
  saveScheduledJobs(scheduledJobs);
  console.log(`[SCHEDULER] Job #${job.id} cancelado`);
  return job;
}

async function executeScheduledJob(job) {
  console.log(`[SCHEDULER] Ejecutando job #${job.id} → ${job.target}`);
  try {
    let replyParts = [];

    if (job.mediaData) {
      // Envío con media
      const media = new MessageMedia(job.mediaMimetype || 'image/jpeg', job.mediaData, job.mediaFilename || 'archivo');
      const item = { media, kind: inferMediaKind(job.mediaMimetype) };

      if (job.target === 'groups' || job.target === 'both') {
        const result = await sendMediaToGroups({ item, caption: job.caption });
        replyParts.push(`👥 Grupos: ✅ ${result.exitosos} ok, ❌ ${result.fallidos} fallidos`);
      }
      if (job.target === 'status' || job.target === 'both') {
        const statusResults = await broadcastStatus({ item, caption: job.caption });
        const okCount = statusResults.filter(r => r.ok).length;
        const failCount = statusResults.filter(r => !r.ok).length;
        replyParts.push(`📱 Estados: ✅ ${okCount} ok, ❌ ${failCount} fallidos`);
      }
    } else if (job.caption) {
      // Envío solo texto
      if (job.target === 'groups' || job.target === 'both') {
        const result = await sendTextToGroups({ message: job.caption });
        replyParts.push(`👥 Grupos: ✅ ${result.exitosos} ok, ❌ ${result.fallidos} fallidos`);
      }
    }

    // Notificar al admin
    const jid = adminJid();
    if (jid && state.client && state.ready) {
      await state.client.sendMessage(jid,
        `⏰ *Envío programado ejecutado*\n\n${replyParts.join('\n')}\n📝 ${job.caption ? job.caption.slice(0, 50) + '...' : 'sin caption'}`
      );
    }
    console.log(`[SCHEDULER] Job #${job.id} completado`);
  } catch (err) {
    console.error(`[SCHEDULER] Job #${job.id} falló:`, err.message);
    const jid = adminJid();
    if (jid && state.client && state.ready) {
      try {
        await state.client.sendMessage(jid, `❌ Envío programado falló: ${err.message}`);
      } catch (_) {}
    }
  }
}

function startScheduler() {
  if (schedulerInterval) return;
  schedulerInterval = setInterval(async () => {
    const now = Date.now();
    const due = scheduledJobs.filter(j => j.status === 'pending' && j.sendAt <= now);
    for (const job of due) {
      job.status = 'executing';
      saveScheduledJobs(scheduledJobs);
      await executeScheduledJob(job);
      job.status = 'done';
    }
    // Limpiar jobs ejecutados
    if (due.length > 0) {
      scheduledJobs = scheduledJobs.filter(j => j.status === 'pending');
      saveScheduledJobs(scheduledJobs);
    }
  }, 30000); // Revisar cada 30 segundos
  console.log('[SCHEDULER] Iniciado, revisando cada 30s');
}
// ============ FIN PROGRAMADOR ============

const state = {
  connected: false,
  ready: false,
  qr: null,
  number: null,
  lastState: 'starting',
  lastDisconnect: null,
  initializing: false,
  client: null,
  reconnectTimer: null,
  pending: {
    items: [],
    caption: '',
    createdAt: 0,
  },
};

function normalizePhone(v) {
  return String(v || '').replace(/\D/g, '');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function auth(req, res, next) {
  const key = req.body?.api_key || req.query?.api_key || req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

function withTimeout(promise, ms, label = 'Timed Out') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSessionBaseDir() {
  return AUTH_PATH;
}

function adminJid() {
  return ADMIN_PHONE ? `${ADMIN_PHONE}@c.us` : null;
}

function isAdminMessage(msg) {
  if (!ADMIN_PHONE) return false;
  const from = normalizePhone(msg.from || '');
  const author = normalizePhone(msg.author || '');
  return from === ADMIN_PHONE || author === ADMIN_PHONE;
}

function clearPending() {
  state.pending = { items: [], caption: '', createdAt: 0 };
}

function pendingExists() {
  return state.pending.items.length > 0;
}

function inferMediaKind(mimetype = '') {
  if (String(mimetype).startsWith('video/')) return 'video';
  if (String(mimetype).startsWith('image/')) return 'image';
  return 'document';
}

function isCommunityLike(chat) {
  const desc = String(chat?.groupMetadata?.desc || chat?.groupMetadata?.description || chat?.description || '');
  const name = String(chat?.name || chat?.formattedTitle || '');
  if (/esta comunidad es para que los miembros chateen/i.test(desc)) return true;
  if (/community/i.test(name) && chat?.participants?.length <= 2) return true;
  return false;
}

async function getGroupsDetailed() {
  if (!state.client || !state.ready) throw new Error('WhatsApp no conectado');

  const chats = await state.client.getChats();
  const groups = chats
    .filter((chat) => chat.isGroup)
    .map((chat) => ({
      id: chat.id._serialized,
      nombre: chat.name,
      participantes: chat.participants?.length || 0,
      descripcion: chat.groupMetadata?.desc || '',
      isReadOnly: !!chat.isReadOnly,
      isCommunityLike: isCommunityLike(chat),
    }));

  return groups;
}

async function getSendableGroups() {
  const groups = await getGroupsDetailed();
  return groups.filter((g) => !GROUP_SKIP_COMMUNITIES || !g.isCommunityLike);
}

async function sendTextToGroups({ message, groupIds }) {
  const client = state.client;
  if (!client || !state.ready) throw new Error('WhatsApp no conectado');

  const ids = Array.isArray(groupIds) && groupIds.length
    ? groupIds
    : (await getSendableGroups()).map((g) => g.id);

  const resultados = [];
  let exitosos = 0;
  for (const gid of ids) {
    try {
      const chat = await withTimeout(client.getChatById(gid), 20000, 'Chat lookup timeout');
      await withTimeout(chat.sendMessage(message), GROUP_SEND_TIMEOUT_MS, 'Timed Out');
      resultados.push({ grupo: gid, ok: true });
      exitosos++;
      await delay(SEND_PAUSE_MS);
    } catch (err) {
      resultados.push({ grupo: gid, ok: false, error: String(err?.message || err) });
    }
  }

  return {
    ok: true,
    total: ids.length,
    exitosos,
    fallidos: ids.length - exitosos,
    resultados,
  };
}

async function sendMediaToGroups({ item, caption, groupIds }) {
  const client = state.client;
  if (!client || !state.ready) throw new Error('WhatsApp no conectado');
  if (!item?.media) throw new Error('No hay media pendiente');

  const ids = Array.isArray(groupIds) && groupIds.length
    ? groupIds
    : (await getSendableGroups()).map((g) => g.id);

  const resultados = [];
  let exitosos = 0;
  for (const gid of ids) {
    try {
      const chat = await withTimeout(client.getChatById(gid), 20000, 'Chat lookup timeout');
      const options = {};
      if (caption) options.caption = caption;
      await withTimeout(chat.sendMessage(item.media, options), GROUP_SEND_TIMEOUT_MS, 'Timed Out');
      resultados.push({ grupo: gid, ok: true });
      exitosos++;
      await delay(SEND_PAUSE_MS);
    } catch (err) {
      resultados.push({ grupo: gid, ok: false, error: String(err?.message || err) });
    }
  }

  return {
    ok: true,
    total: ids.length,
    exitosos,
    fallidos: ids.length - exitosos,
    resultados,
  };
}

async function sendMediaToStatus({ item, caption }) {
  const client = state.client;
  if (!client || !state.ready) throw new Error('WhatsApp no conectado');
  if (!item?.media) throw new Error('No hay media pendiente');

  const statusChatId = 'status@broadcast';
  const options = {};
  if (caption) options.caption = caption;

  // wwebjs requiere sendSeen antes de publicar estado en algunas versiones
  try {
    const statusChat = await client.getChatById(statusChatId);
    await statusChat.sendSeen();
  } catch (e) {
    console.log('[WA] sendSeen status fallido (no crítico):', e.message);
  }

  try {
    await withTimeout(
      client.sendMessage(statusChatId, item.media, options),
      GROUP_SEND_TIMEOUT_MS,
      'Status publish timeout'
    );
    console.log('[WA] Estado publicado OK');
  } catch (err) {
    console.error('[WA] Error publicando estado:', err.message);
    throw err;
  }
}

// Broadcast status a este servicio + todos los workers
async function broadcastStatus({ item, caption }) {
  const results = [];

  // Publicar en este mismo servicio
  try {
    await sendMediaToStatus({ item, caption });
    results.push({ url: 'local', ok: true });
    console.log('[BROADCAST] Local: OK');
  } catch (err) {
    results.push({ url: 'local', ok: false, error: err.message });
    console.error('[BROADCAST] Local falló:', err.message);
  }

  // Publicar en cada worker
  for (const workerUrl of WORKER_URLS) {
    try {
      const base64 = item.media.data;
      const mimetype = item.media.mimetype;
      const filename = item.media.filename || 'archivo';
      console.log(`[BROADCAST] Llamando worker: ${workerUrl}`);
      const resp = await fetch(`${workerUrl}/status/publicar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ media_base64: base64, mimetype, filename, caption }),
      });
      const text = await resp.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Worker respondió HTML/no-JSON (status ${resp.status}): ${text.slice(0, 120)}`);
      }
      results.push({ url: workerUrl, ok: data.ok, error: data.error });
      console.log(`[BROADCAST] Worker ${workerUrl}: ${data.ok ? 'OK' : 'FALLÓ - ' + data.error}`);
    } catch (err) {
      results.push({ url: workerUrl, ok: false, error: err.message });
      console.error(`[BROADCAST] Worker ${workerUrl} error:`, err.message);
    }
  }

  return results;
}

// Throttle: máximo 1 auto-respuesta por contacto cada AUTO_REPLY_COOLDOWN_MS
const AUTO_REPLY_COOLDOWN_MS = Number(process.env.AUTO_REPLY_COOLDOWN_MS || 3600000);
const autoReplySent = new Map();
function autoReplyThrottle(from) {
  const now = Date.now();
  const last = autoReplySent.get(from) || 0;
  if (now - last < AUTO_REPLY_COOLDOWN_MS) return false;
  autoReplySent.set(from, now);
  if (autoReplySent.size > 100) {
    for (const [k, v] of autoReplySent) {
      if (now - v > AUTO_REPLY_COOLDOWN_MS) autoReplySent.delete(k);
    }
  }
  return true;
}

function extractDirectTextIntent(text) {
  const t = String(text || '').trim();
  const low = t.toLowerCase();

  if (!t) return null;
  if (['!status', 'status'].includes(low)) return { action: 'status' };
  if (['!grupos', '!listar', 'lista grupos'].includes(low)) return { action: 'list_groups' };
  if (['!test', '!test-grupos'].includes(low)) return { action: 'test_groups' };
  if (['!clear', '!limpiar', '!cancelar'].includes(low)) return { action: 'clear_pending' };
  if (['!reauth', '!reautenticar'].includes(low)) return { action: 'reauth' };
  if (['!programados', '!pendientes', '!agenda'].includes(low)) return { action: 'list_scheduled' };

  // !cancelar N → cancelar un programado
  const cancelMatch = low.match(/^!cancelar\s+(\d+)$/);
  if (cancelMatch) return { action: 'cancel_scheduled', index: parseInt(cancelMatch[1]) - 1 };

  // Envío programado: "grupos 8pm", "estados mañana 10am", "ambos hoy 20:00"
  const schedMatch = t.match(/^(grupos|estados|estado|ambos|todo)\s+(.+)$/i);
  if (schedMatch) {
    const targetWord = schedMatch[1].toLowerCase();
    const timeStr = schedMatch[2].trim();
    const parsed = parseMexicoTime(timeStr);
    if (parsed) {
      let target = 'groups';
      if (/^(estados|estado)$/.test(targetWord)) target = 'status';
      if (/^(ambos|todo)$/.test(targetWord)) target = 'both';
      return { action: 'schedule_pending', target, sendAt: parsed.utc, displayTime: formatScheduleTime(parsed.utc) };
    }
  }

  // "estados" o "ambos" para publicar en estados de WA (inmediato)
  if (/^(estados|estado)$/i.test(t)) return { action: 'send_pending', target: 'status' };
  if (/^(ambos|todo|grupos\s*y\s*estados|estados\s*y\s*grupos)$/i.test(t)) return { action: 'send_pending', target: 'both' };

  // "grupos" sin ! = enviar pendiente (no listar)
  if (/^(grupos|envia a grupos|manda a grupos|mandar a grupos|publica en grupos|mandalo a grupos|mándalo a grupos|mandalos a grupos|mándalos a grupos)$/i.test(t)) {
    return { action: 'send_pending', target: 'groups' };
  }

  const directMatch = t.match(/^(manda|envia|envía|publica)\s+(esto\s+)?a\s+grupos\s*:?\s*([\s\S]+)$/i);
  if (directMatch && directMatch[3]) {
    return { action: 'send_text', caption: directMatch[3].trim() };
  }

  if (/^(hazme|creame|créame|ayudame|ayúdame|escribeme|escríbeme)/i.test(t)) {
    return { action: 'draft_with_ai', raw: t };
  }

  return null;
}

async function callOpenAIForIntent({ text, hasPendingMedia }) {
  if (!OPENAI_API_KEY) {
    return { action: 'ask_clarify', reply: '⚙️ Falta OPENAI_API_KEY. Puedes decirme algo directo como: “manda esto a grupos: ...” o enviar una imagen y luego escribir “grupos”.' };
  }

  const system = `Eres un asistente de marketing por WhatsApp para publicar en grupos.
Devuelve SOLO JSON válido.
Acciones válidas:
- {"action":"send_text","caption":"...","reply":"..."}
- {"action":"send_pending","caption":"opcional","reply":"..."}
- {"action":"draft","reply":"texto sugerido"}
- {"action":"list_groups","reply":"..."}
- {"action":"status","reply":"..."}
- {"action":"ask_clarify","reply":"..."}
Reglas:
- Si el usuario pide publicar texto directo a grupos, usa send_text.
- Si hay media pendiente y el usuario dice grupos/publicar/mandar, usa send_pending.
- Si el usuario solo pide ayuda con una promo sin pedir enviarla aún, usa draft.
- Responde en español mexicano.`;

  const user = JSON.stringify({ text, hasPendingMedia });
  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'OpenAI error');
  const content = data?.choices?.[0]?.message?.content || '{}';
  return JSON.parse(content);
}

async function sendReplyToAdmin(text) {
  const jid = adminJid();
  if (!jid || !state.client) return;
  await state.client.sendMessage(jid, text);
}

async function handleAdminTextMessage(msg) {
  const text = String(msg.body || '').trim();
  if (!text) return;

  const direct = extractDirectTextIntent(text);
  if (direct?.action === 'status') {
    const groups = state.ready ? await getSendableGroups().catch(() => []) : [];
    await msg.reply(`📊 Estado: ${state.ready ? 'conectado' : 'no conectado'}\n📱 Número: ${state.number || '—'}\n👥 Grupos válidos: ${groups.length}`);
    return;
  }

  if (direct?.action === 'clear_pending') {
    clearPending();
    await msg.reply('🗑️ Borré la imagen/video pendiente.');
    return;
  }

  if (direct?.action === 'reauth') {
    await msg.reply('♻️ Reiniciando sesión. Espera a que salga QR en el panel.');
    await destroyClient({ deleteSession: true });
    setTimeout(() => startClient().catch((e) => console.error('[WA] Reinit error:', e.message)), 3000);
    return;
  }

  if (direct?.action === 'list_scheduled') {
    const pending = scheduledJobs.filter(j => j.status === 'pending');
    if (!pending.length) {
      await msg.reply('📋 No hay envíos programados.');
      return;
    }
    const list = pending.map((j, i) =>
      `${i + 1}. ⏰ ${formatScheduleTime(j.sendAt)} → *${j.target}*\n   📝 ${j.caption ? j.caption.slice(0, 40) : 'sin caption'}${j.mediaData ? ' 📎' : ''}`
    ).join('\n\n');
    await msg.reply(`📋 *Envíos programados (${pending.length}):*\n\n${list}\n\nPara cancelar: *!cancelar 1*`);
    return;
  }

  if (direct?.action === 'cancel_scheduled') {
    const job = cancelJob(direct.index);
    if (job) {
      await msg.reply(`🗑️ Envío cancelado: ${formatScheduleTime(job.sendAt)} → ${job.target}`);
    } else {
      await msg.reply('❌ No existe ese número. Escribe *!programados* para ver la lista.');
    }
    return;
  }

  // --- Si hay media pendiente ---
  if (pendingExists()) {
    if (direct?.action === 'send_pending') {
      const caption = direct.caption || state.pending.caption || '';
      const item = state.pending.items[state.pending.items.length - 1];
      const target = direct.target || 'groups';
      let replyParts = [];

      if (target === 'groups' || target === 'both') {
        const result = await sendMediaToGroups({ item, caption });
        replyParts.push(`👥 Grupos: ✅ ${result.exitosos} ok, ❌ ${result.fallidos} fallidos`);
      }
      if (target === 'status' || target === 'both') {
        try {
          const statusResults = await broadcastStatus({ item, caption });
          const okCount = statusResults.filter(r => r.ok).length;
          const failCount = statusResults.filter(r => !r.ok).length;
          replyParts.push(`📱 Estados: ✅ ${okCount} ok, ❌ ${failCount} fallidos`);
        } catch (err) {
          replyParts.push(`📱 Estados: ❌ ${err.message}`);
        }
      }

      await msg.reply(`📤 Envío completado.\n${replyParts.join('\n')}`);
      clearPending();
      return;
    }

    // Programar envío con media
    if (direct?.action === 'schedule_pending') {
      const caption = state.pending.caption || '';
      const item = state.pending.items[state.pending.items.length - 1];
      const job = scheduleJob({
        target: direct.target,
        caption,
        mediaData: item.media.data,
        mediaMimetype: item.media.mimetype,
        mediaFilename: item.media.filename,
        sendAt: direct.sendAt,
      });
      await msg.reply(`⏰ *Programado*\n\n📅 ${direct.displayTime}\n🎯 ${direct.target}\n📝 ${caption ? caption.slice(0, 50) : 'sin caption'}${item ? ' 📎' : ''}\n\nVer todos: *!programados*\nCancelar: *!cancelar 1*`);
      clearPending();
      return;
    }

    // !grupos con media pendiente = listar, NO enviar
    if (direct?.action === 'list_groups') {
      const groups = await getSendableGroups().catch(() => []);
      const preview = groups.slice(0, 10).map((g, i) => `${i + 1}. ${g.nombre}`).join('\n');
      await msg.reply(`👥 Grupos válidos: ${groups.length}\n\n${preview || 'Sin grupos detectados.'}`);
      return;
    }

    // Cualquier otro texto = caption
    state.pending.caption = text;
    await msg.reply('📝 Caption guardado. Ahora escribe:\n• *grupos* → enviar ahora a grupos\n• *estados* → publicar en estado de WA\n• *ambos* → grupos + estado\n• *grupos 8pm* → programar a las 8pm\n• *ambos mañana 10am* → programar');
    return;
  }

  if (direct?.action === 'list_groups') {
    const groups = await getSendableGroups().catch(() => []);
    const preview = groups.slice(0, 10).map((g, i) => `${i + 1}. ${g.nombre}`).join('\n');
    await msg.reply(`👥 Grupos válidos: ${groups.length}\n\n${preview || 'Sin grupos detectados.'}`);
    return;
  }

  if (direct?.action === 'test_groups') {
    const groups = (await getSendableGroups()).slice(0, 3);
    if (!groups.length) {
      await msg.reply('❌ No encontré grupos válidos para probar.');
      return;
    }
    for (const g of groups) {
      try {
        const chat = await withTimeout(state.client.getChatById(g.id), 20000, 'Chat lookup timeout');
        await withTimeout(chat.sendMessage('🧪 Test desde bot wwebjs'), GROUP_SEND_TIMEOUT_MS, 'Timed Out');
        await msg.reply(`✅ Test OK en: ${g.nombre}`);
      } catch (err) {
        await msg.reply(`❌ Test falló en ${g.nombre}: ${String(err?.message || err)}`);
      }
    }
    return;
  }

  if (direct?.action === 'send_text' && direct.caption) {
    const result = await sendTextToGroups({ message: direct.caption });
    await msg.reply(`📤 Envío completado.\n✅ ${result.exitosos} ok\n❌ ${result.fallidos} fallidos`);
    return;
  }

  // Intentar IA
  try {
    const intent = await callOpenAIForIntent({ text, hasPendingMedia: pendingExists() });
    if (intent.action === 'send_text' && intent.caption) {
      const result = await sendTextToGroups({ message: intent.caption });
      await msg.reply(`${intent.reply || '📤 Enviando a grupos...'}\n✅ ${result.exitosos} ok\n❌ ${result.fallidos} fallidos`);
      return;
    }
    if (intent.action === 'send_pending' && pendingExists()) {
      const item = state.pending.items[state.pending.items.length - 1];
      const result = await sendMediaToGroups({ item, caption: intent.caption || state.pending.caption || '' });
      await msg.reply(`${intent.reply || '📤 Enviando media a grupos...'}\n✅ ${result.exitosos} ok\n❌ ${result.fallidos} fallidos`);
      clearPending();
      return;
    }
    if (intent.action === 'list_groups') {
      const groups = await getSendableGroups().catch(() => []);
      const preview = groups.slice(0, 10).map((g, i) => `${i + 1}. ${g.nombre}`).join('\n');
      await msg.reply(`${intent.reply || '👥 Grupos disponibles:'}\n\n${preview || 'Sin grupos detectados.'}`);
      return;
    }
    if (intent.action === 'status') {
      const groups = state.ready ? await getSendableGroups().catch(() => []) : [];
      await msg.reply(`${intent.reply || '📊 Estado actual:'}\n📱 Número: ${state.number || '—'}\n👥 Grupos válidos: ${groups.length}`);
      return;
    }
    if (intent.action === 'draft' || intent.action === 'ask_clarify') {
      await msg.reply(intent.reply || 'No entendí bien. Dime algo como: “manda esto a grupos: ...”');
      return;
    }
  } catch (err) {
    console.error('[AI] Error:', err.message);
  }

  // Fallback simple
  await msg.reply('🤖 Puedo ayudarte así:\n• Manda imagen/video y luego: *grupos*, *estados* o *ambos*\n• Programar: *grupos 8pm*, *ambos mañana 10am*\n• Texto directo: *manda esto a grupos: tu promo*\n• Comandos: !status, !grupos, !test, !clear, !programados, !reauth');
}

async function handleAdminMediaMessage(msg) {
  const media = await msg.downloadMedia();
  if (!media) {
    await msg.reply('❌ No pude descargar el archivo. Intenta de nuevo.');
    return;
  }

  const kind = inferMediaKind(media.mimetype);
  state.pending.items.push({ media, kind, createdAt: Date.now() });
  state.pending.createdAt = Date.now();
  state.pending.caption = String(msg.body || '').trim() || state.pending.caption || '';

  const label = kind === 'video' ? 'video' : kind === 'image' ? 'imagen' : 'archivo';
  const opciones = '• *grupos* → enviar a grupos\n• *estados* → publicar en estado de WA\n• *ambos* → grupos + estado\n\n⏰ Programar: *grupos 8pm*, *ambos mañana 10am*';
  if (state.pending.caption) {
    await msg.reply(`📎 Recibí 1 ${label}. Caption guardado.\n\n${opciones}`);
  } else {
    await msg.reply(`📎 Recibí 1 ${label}.\nMándame el texto y luego elige destino:\n\n${opciones}`);
  }
}

async function destroyClient({ deleteSession = false } = {}) {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  const client = state.client;
  state.client = null;
  state.connected = false;
  state.ready = false;
  state.number = null;
  state.qr = null;
  state.lastState = deleteSession ? 'reauth' : 'disconnected';

  if (client) {
    try { await client.destroy(); } catch (_) {}
  }

  if (deleteSession) {
    try { fs.rmSync(getSessionBaseDir(), { recursive: true, force: true }); } catch (_) {}
  }
}

function scheduleReconnect(delayMs = 5000) {
  if (state.reconnectTimer || state.initializing || state.client) return;
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    try {
      await startClient();
    } catch (err) {
      console.error('[WA] Error reintentando conexión:', err.message);
    }
  }, delayMs);
}

function attachClientEvents(client) {
  client.on('qr', async (qr) => {
    try {
      state.qr = await QRCode.toDataURL(qr);
      state.connected = false;
      state.ready = false;
      state.lastState = 'qr';
      console.log('[WA] QR generado');
    } catch (err) {
      console.error('[WA] Error generando QR:', err.message);
    }
  });

  client.on('authenticated', () => {
    state.lastState = 'authenticated';
    console.log('[WA] Autenticado');
  });

  client.on('ready', async () => {
    state.ready = true;
    state.connected = true;
    state.qr = null;
    state.lastState = 'ready';
    try {
      const info = client.info;
      const wid = info?.wid?._serialized || '';
      state.number = wid.split('@')[0] || null;
    } catch (_) {
      state.number = null;
    }
    console.log(`[WA] Conectado: ${state.number || 'sin numero'}`);

    // Notificar al admin que el bot arrancó
    try {
      // Cargar jobs pendientes e iniciar scheduler
      scheduledJobs = loadScheduledJobs();
      startScheduler();
      const pendingJobs = scheduledJobs.filter(j => j.status === 'pending').length;

      const jid = adminJid();
      if (jid) {
        const groups = await getSendableGroups().catch(() => []);
        await client.sendMessage(jid,
          `🤖 *Bot reiniciado*\n\n` +
          `📱 Número: ${state.number || '—'}\n` +
          `🏷️ Sesión: ${SESSION_ID}\n` +
          `👥 Grupos: ${groups.length}\n` +
          `🔗 Workers: ${WORKER_URLS.length}\n` +
          `⏰ Programados: ${pendingJobs}\n` +
          `🕐 ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}`
        );
      }
    } catch (e) {
      console.log('[WA] No se pudo notificar al admin:', e.message);
    }
  });

  client.on('change_state', (waState) => {
    state.lastState = String(waState || 'unknown');
    console.log('[WA] change_state:', waState);
  });

  client.on('auth_failure', (msg) => {
    state.connected = false;
    state.ready = false;
    state.lastDisconnect = String(msg || 'auth_failure');
    console.error('[WA] auth_failure:', msg);
  });

  client.on('disconnected', async (reason) => {
    state.connected = false;
    state.ready = false;
    state.lastDisconnect = String(reason || 'disconnected');
    state.lastState = 'disconnected';
    console.log('[WA] Desconectado:', reason);

    const low = String(reason || '').toLowerCase();
    const deleteSession = low.includes('logout') || low.includes('multidevice mismatch');
    await destroyClient({ deleteSession });
    scheduleReconnect(deleteSession ? 3000 : 7000);
  });

  client.on('message', async (msg) => {
    try {
      if (msg.fromMe) return;
      if (msg.from.endsWith('@g.us')) return;
      // Ignorar estados, broadcasts y mensajes del sistema
      if (msg.from === 'status@broadcast') return;
      if (msg.from.endsWith('@broadcast')) return;
      if (msg.type === 'e2e_notification' || msg.type === 'notification_template') return;
      if (msg.isStatus) return;

      // Auto-respuesta a no-admins
      if (!isAdminMessage(msg)) {
        if (!autoReplyThrottle(msg.from)) return; // evitar spam
        await msg.reply('📢 Este número es solo de *avisos y promociones*.\n\n📲 Para atención escribe al *496 147 43 57*\n¡Gracias!');
        return;
      }

      if (msg.hasMedia) {
        await handleAdminMediaMessage(msg);
        return;
      }
      await handleAdminTextMessage(msg);
    } catch (err) {
      console.error('[WA] Error manejando mensaje:', err.message);
      try {
        await msg.reply(`❌ Error: ${err.message}`);
      } catch (_) {}
    }
  });
}

async function startClient() {
  if (state.initializing) {
    console.log('[WA] Inicialización ya en progreso, ignorando');
    return;
  }
  if (state.client) return;

  state.initializing = true;
  ensureDir(AUTH_PATH);

  try {
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: SESSION_ID,
        dataPath: AUTH_PATH,
        rmMaxRetries: 10,
      }),
      qrMaxRetries: 0,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 15000,
      authTimeoutMs: 120000,
      puppeteer: {
        headless: true,
        executablePath: CHROME_BIN,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--disable-accelerated-2d-canvas',
          '--single-process',
          '--no-first-run',
          '--disable-features=LockProfileCookieDatabase',
        ],
      },
    });

    state.client = client;
    attachClientEvents(client);
    await client.initialize();
  } finally {
    state.initializing = false;
  }
}

app.get('/', (_req, res) => {
  const statusColor = state.ready ? '#4ade80' : '#f87171';
  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp Groups Publisher + IA</title>
  <style>
    body { font-family: Arial, sans-serif; background:#07111f; color:#fff; margin:0; padding:40px; }
    .card { max-width:980px; margin:0 auto; background:#0f1b33; border-radius:22px; padding:34px; }
    h1 { margin-top:0; font-size:44px; }
    .row { margin:12px 0; font-size:21px; }
    .label { color:#9db3d9; }
    .status { color:${statusColor}; font-weight:700; }
    .qr { margin-top:20px; }
    img { background:#fff; padding:18px; border-radius:18px; max-width:320px; }
    .buttons { display:flex; gap:12px; flex-wrap:wrap; margin-top:22px; }
    a.btn { display:inline-block; background:#243b6b; color:#fff; padding:14px 22px; border-radius:14px; text-decoration:none; }
    .help { margin-top:24px; background:#081225; border-radius:14px; padding:18px; color:#dbe7ff; }
    code { color:#ffd166; }
  </style>
</head>
<body>
  <div class="card">
    <h1>WhatsApp Groups Publisher + IA</h1>
    <div class="row"><span class="label">Estado:</span> <span class="status">${state.ready ? 'Conectado' : 'No conectado'}</span></div>
    <div class="row"><span class="label">Numero:</span> ${state.number || '—'}</div>
    <div class="row"><span class="label">Sesion:</span> ${SESSION_ID}</div>
    <div class="row"><span class="label">Admin:</span> ${ADMIN_PHONE || 'no configurado'}</div>
    <div class="row"><span class="label">Media pendiente:</span> ${state.pending.items.length}</div>
    ${state.qr ? `<div class="qr"><div>Escanea este QR:</div><img src="${state.qr}" alt="QR" /></div>` : ''}
    <div class="buttons">
      <a class="btn" href="/status">Status JSON</a>
      <a class="btn" href="/qr">QR JSON</a>
      <a class="btn" href="/grupos/lista?api_key=${encodeURIComponent(API_KEY)}">Listar grupos</a>
      <a class="btn" href="/test/grupos?api_key=${encodeURIComponent(API_KEY)}">Test grupos</a>
      <a class="btn" href="/reauth?api_key=${encodeURIComponent(API_KEY)}">Reauth</a>
      <a class="btn" href="/sesion/limpiar?api_key=${encodeURIComponent(API_KEY)}">Limpiar sesión</a>
    </div>
    <div class="help">
      <strong>Uso por WhatsApp con el admin:</strong><br>
      • Manda texto: <code>manda esto a grupos: ...</code><br>
      • Manda una imagen/video y luego escribe: <code>grupos</code><br>
      • Si quieres, manda primero el caption y luego <code>grupos</code><br>
      • Comandos: <code>!status</code>, <code>!grupos</code>, <code>!test</code>, <code>!clear</code>, <code>!reauth</code>
    </div>
  </div>
</body>
</html>`;
  res.type('html').send(html);
});

app.get('/status', (_req, res) => {
  res.json({
    ok: true,
    connected: state.connected,
    ready: state.ready,
    number: state.number,
    session: SESSION_ID,
    admin_phone: ADMIN_PHONE || null,
    pending_media: state.pending.items.length,
    lastState: state.lastState,
    lastDisconnect: state.lastDisconnect,
  });
});

app.get('/qr', (_req, res) => {
  res.json({ ok: true, ready: state.ready, qr: state.qr });
});

app.get('/grupos/lista', auth, async (_req, res) => {
  try {
    const groups = await getGroupsDetailed();
    const valid = GROUP_SKIP_COMMUNITIES ? groups.filter((g) => !g.isCommunityLike) : groups;
    res.json({
      ok: true,
      total: valid.length,
      detectados: groups.length,
      omitidos: groups.length - valid.length,
      grupos: valid,
      omitidos_detalle: groups.filter((g) => !valid.find((v) => v.id === g.id)).map((g) => ({ id: g.id, nombre: g.nombre, razon: 'community-like' })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/grupos/enviar', auth, async (req, res) => {
  try {
    const { grupo_ids = [], mensaje = '', media_base64, mimetype, filename } = req.body;
    if (!state.ready) return res.status(400).json({ ok: false, error: 'WhatsApp no conectado' });

    if (!mensaje && !media_base64) {
      return res.status(400).json({ ok: false, error: 'Falta mensaje o media_base64' });
    }

    if (media_base64) {
      const media = new MessageMedia(mimetype || 'application/octet-stream', media_base64, filename || 'archivo');
      const result = await sendMediaToGroups({ item: { media, kind: inferMediaKind(mimetype) }, caption: mensaje, groupIds: grupo_ids });
      return res.json(result);
    }

    const result = await sendTextToGroups({ message: mensaje, groupIds: grupo_ids });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/test/grupos', auth, async (_req, res) => {
  try {
    const groups = (await getSendableGroups()).slice(0, 3);
    const result = await sendTextToGroups({ message: '🧪 Test desde bot wwebjs+IA', groupIds: groups.map((g) => g.id) });
    res.json({ ...result, groups });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/reauth', auth, async (_req, res) => {
  await destroyClient({ deleteSession: true });
  clearPending();
  setTimeout(() => startClient().catch((e) => console.error('[WA] Reinit error:', e.message)), 3000);
  res.json({ ok: true, message: 'Reauth iniciado. Espera QR nuevo.' });
});

app.get('/sesion/limpiar', auth, async (_req, res) => {
  await destroyClient({ deleteSession: true });
  clearPending();
  res.json({ ok: true, message: 'Sesión borrada. Usa /reauth o recarga para generar QR.' });
});

// Endpoint para que el hub publique estado en este worker
app.post('/status/publicar', auth, async (req, res) => {
  try {
    const { media_base64, mimetype, filename, caption } = req.body;
    if (!state.ready) return res.status(400).json({ ok: false, error: 'WhatsApp no conectado' });
    if (!media_base64) return res.status(400).json({ ok: false, error: 'Falta media_base64' });

    const media = new MessageMedia(mimetype || 'image/jpeg', media_base64, filename || 'archivo');
    const item = { media, kind: inferMediaKind(mimetype) };
    await sendMediaToStatus({ item, caption: caption || '' });
    res.json({ ok: true, message: 'Estado publicado' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/programados', auth, (_req, res) => {
  const pending = scheduledJobs.filter(j => j.status === 'pending');
  res.json({
    ok: true,
    total: pending.length,
    jobs: pending.map((j, i) => ({
      num: i + 1,
      target: j.target,
      caption: j.caption ? j.caption.slice(0, 80) : '',
      hasMedia: !!j.mediaData,
      sendAt: formatScheduleTime(j.sendAt),
      sendAtUtc: j.sendAt,
    })),
  });
});

app.listen(PORT, () => {
  console.log(`[SERVER] Puerto ${PORT}`);
  console.log(`[SERVER] Session ID: ${SESSION_ID}`);
  console.log(`[SERVER] Admin: ${ADMIN_PHONE || 'no-configurado'}`);
  console.log(`[SERVER] Auth path: ${AUTH_PATH}`);
  console.log(`[SERVER] Workers: ${WORKER_URLS.length ? WORKER_URLS.join(', ') : 'ninguno (hub solo)'}`);

  // Cargar jobs al arrancar (el scheduler se inicia cuando WA conecte)
  scheduledJobs = loadScheduledJobs();
  const pendingCount = scheduledJobs.filter(j => j.status === 'pending').length;
  if (pendingCount > 0) console.log(`[SCHEDULER] ${pendingCount} jobs pendientes cargados`);
});

// Limpiar lock files de Chromium que sobreviven reinicios en Railway
try {
  const { execSync } = require('child_process');
  const out = execSync(`find ${AUTH_ROOT} /tmp -name 'SingletonLock' -o -name 'SingletonCookie' -o -name 'SingletonSocket' -o -name 'lockfile' 2>/dev/null || true`).toString().trim();
  if (out) {
    for (const f of out.split('\n').filter(Boolean)) {
      try { fs.unlinkSync(f); console.log(`[CLEANUP] Borrado: ${f}`); } catch (_) {}
    }
  } else {
    console.log('[CLEANUP] No se encontraron lock files');
  }
} catch (e) {
  console.log('[CLEANUP] Error:', e.message);
}

startClient().catch((err) => {
  console.error('[SERVER] Error iniciando cliente:', err.message);
  scheduleReconnect(5000);
});
