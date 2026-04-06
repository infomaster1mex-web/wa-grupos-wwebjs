const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.SOS_API_KEY || 'cambia_esto';
const SESSION_ID = process.env.SESSION_ID || 'grupos';
const GROUP_SEND_TIMEOUT_MS = Number(process.env.GROUP_SEND_TIMEOUT_MS || 90000);
const CHROME_BIN = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN || '/usr/bin/chromium';
const AUTH_ROOT = process.env.AUTH_ROOT || '/app/auth_info';
const AUTH_PATH = path.join(AUTH_ROOT, 'wwebjs_auth');

const state = {
  connected: false,
  ready: false,
  qr: null,
  number: null,
  lastState: 'starting',
  lastDisconnect: null,
  initializing: false,
  client: null,
};

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

function getSessionPath() {
  return path.join(AUTH_PATH, `session-${SESSION_ID}`);
}

async function destroyClient({ deleteSession = false } = {}) {
  const client = state.client;
  state.client = null;
  state.connected = false;
  state.ready = false;
  state.number = null;
  state.qr = null;
  state.lastState = deleteSession ? 'reauth' : 'disconnected';

  if (client) {
    try {
      await client.destroy();
    } catch (_) {}
  }

  if (deleteSession) {
    try {
      fs.rmSync(getSessionPath(), { recursive: true, force: true });
    } catch (_) {}
  }
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

    if (String(reason).toLowerCase().includes('logout')) {
      await destroyClient({ deleteSession: true });
      setTimeout(() => startClient().catch((e) => console.error('[WA] Reinit error:', e.message)), 3000);
    }
  });
}

async function startClient() {
  if (state.initializing) {
    console.log('[WA] Inicializacion ya en progreso, ignorando');
    return;
  }

  if (state.client) {
    return;
  }

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

async function getGroupsDetailed() {
  if (!state.client || !state.ready) {
    throw new Error('WhatsApp no conectado');
  }

  const chats = await state.client.getChats();
  const groups = chats
    .filter((chat) => chat.isGroup)
    .map((chat) => ({
      id: chat.id._serialized,
      nombre: chat.name,
      participantes: chat.participants?.length || 0,
      descripcion: chat.groupMetadata?.desc || '',
      isReadOnly: !!chat.isReadOnly,
    }));

  return groups;
}

app.get('/', (_req, res) => {
  const statusColor = state.ready ? '#4ade80' : '#f87171';
  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp Groups Publisher (wwebjs)</title>
  <style>
    body { font-family: Arial, sans-serif; background:#07111f; color:#fff; margin:0; padding:40px; }
    .card { max-width:860px; margin:0 auto; background:#0f1b33; border-radius:22px; padding:34px; }
    h1 { margin-top:0; font-size:52px; }
    .row { margin:16px 0; font-size:22px; }
    .label { color:#9db3d9; }
    .status { color:${statusColor}; font-weight:700; }
    .qr { margin-top:20px; }
    img { background:#fff; padding:18px; border-radius:18px; max-width:320px; }
    .buttons { display:flex; gap:12px; flex-wrap:wrap; margin-top:22px; }
    a.btn { display:inline-block; background:#243b6b; color:#fff; padding:14px 22px; border-radius:14px; text-decoration:none; }
    pre { white-space:pre-wrap; word-break:break-word; background:#081225; padding:16px; border-radius:14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>WhatsApp Groups Publisher</h1>
    <div class="row"><span class="label">Estado:</span> <span class="status">${state.ready ? 'Conectado' : 'No conectado'}</span></div>
    <div class="row"><span class="label">Numero:</span> ${state.number || '—'}</div>
    <div class="row"><span class="label">Sesion:</span> ${SESSION_ID}</div>
    <div class="row">Si no hay QR y no conecta, usa reauth.</div>
    ${state.qr ? `<div class="qr"><div>Escanea este QR:</div><img src="${state.qr}" alt="QR" /></div>` : ''}
    <div class="buttons">
      <a class="btn" href="/status">Status JSON</a>
      <a class="btn" href="/qr">QR JSON</a>
      <a class="btn" href="/grupos/lista?api_key=${encodeURIComponent(API_KEY)}">Listar grupos</a>
      <a class="btn" href="/crypto/limpiar?api_key=${encodeURIComponent(API_KEY)}">Limpiar crypto</a>
      <a class="btn" href="/reauth?api_key=${encodeURIComponent(API_KEY)}">Reauth</a>
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
    sessionId: SESSION_ID,
    lastState: state.lastState,
    lastDisconnect: state.lastDisconnect,
    hasQr: !!state.qr,
  });
});

app.get('/qr', (_req, res) => {
  res.json({ ok: true, hasQr: !!state.qr, qr: state.qr });
});

app.get('/grupos/lista', auth, async (_req, res) => {
  try {
    const groups = await getGroupsDetailed();
    const valid = groups.filter((g) => !g.id.endsWith('@broadcast'));
    res.json({ ok: true, total: valid.length, grupos: valid });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/grupos/enviar', auth, async (req, res) => {
  const { grupo_ids, mensaje, imagen_base64, caption } = req.body;
  if (!Array.isArray(grupo_ids) || !grupo_ids.length) {
    return res.status(400).json({ ok: false, error: 'grupo_ids debe ser un arreglo con al menos 1 id' });
  }
  if (!mensaje && !imagen_base64) {
    return res.status(400).json({ ok: false, error: 'Debes enviar mensaje o imagen_base64' });
  }
  if (!state.client || !state.ready) {
    return res.status(503).json({ ok: false, error: 'WhatsApp no conectado' });
  }

  const resultados = [];
  let exitosos = 0;

  for (const groupId of grupo_ids) {
    try {
      const chat = await withTimeout(state.client.getChatById(groupId), 20000, 'Chat lookup timeout');

      if (imagen_base64) {
        const media = new MessageMedia('image/jpeg', imagen_base64);
        await withTimeout(chat.sendMessage(media, { caption: caption || mensaje || '' }), GROUP_SEND_TIMEOUT_MS, 'Timed Out');
      } else {
        await withTimeout(chat.sendMessage(String(mensaje)), GROUP_SEND_TIMEOUT_MS, 'Timed Out');
      }

      resultados.push({ grupo: groupId, ok: true });
      exitosos += 1;
    } catch (err) {
      resultados.push({ grupo: groupId, ok: false, error: err.message || String(err) });
    }
  }

  res.json({
    ok: true,
    total: grupo_ids.length,
    exitosos,
    fallidos: grupo_ids.length - exitosos,
    resultados,
  });
});

app.post('/test/grupos', auth, async (_req, res) => {
  try {
    const groups = await getGroupsDetailed();
    const toTest = groups.slice(0, 3);
    const resultados = [];

    for (const group of toTest) {
      try {
        const chat = await withTimeout(state.client.getChatById(group.id), 20000, 'Chat lookup timeout');
        await withTimeout(chat.sendMessage('🧪 Prueba desde whatsapp-web.js'), GROUP_SEND_TIMEOUT_MS, 'Timed Out');
        resultados.push({ grupo: group.id, nombre: group.nombre, ok: true });
      } catch (err) {
        resultados.push({ grupo: group.id, nombre: group.nombre, ok: false, error: err.message || String(err) });
      }
    }

    res.json({ ok: true, total: toTest.length, resultados });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/crypto/limpiar', auth, async (_req, res) => {
  try {
    await destroyClient({ deleteSession: true });
    await startClient();
    res.json({ ok: true, message: 'Sesion limpiada. Escanea QR nuevo.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/reauth', auth, async (_req, res) => {
  try {
    await destroyClient({ deleteSession: true });
    await startClient();
    res.json({ ok: true, message: 'Reauth iniciado. Escanea QR nuevo.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, async () => {
  ensureDir(AUTH_ROOT);
  ensureDir(AUTH_PATH);
  console.log(`[SERVER] Puerto ${PORT}`);
  console.log(`[SERVER] Session ID: ${SESSION_ID}`);
  console.log(`[SERVER] Auth path: ${AUTH_PATH}`);
  await startClient().catch((err) => console.error('[SERVER] Error iniciando cliente:', err.message));
});
