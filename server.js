require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');

const app  = express();
const EVO_URL      = process.env.EVO_URL      || 'https://evolution-api-production-8e853.up.railway.app';
const EVO_APIKEY   = process.env.EVO_APIKEY   || '6f05426a2ab6e8508712211d4910251bde35070caa60cdce0e14a20157d460ce';
const EVO_INSTANCE = process.env.EVO_INSTANCE || 'tutu-venta';

// ── Persistencia en disco (antes vivía solo en memoria y se perdía en cada
// reinicio de Railway, haciendo que el bot volviera a preguntar todo de nuevo
// a clientes que ya habían terminado la charla) ──────────────────────────────
const db = new Database(path.join(__dirname, 'venta_bot.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS conversaciones_estado (
    telefono TEXT PRIMARY KEY,
    historial TEXT NOT NULL DEFAULT '[]',
    cerrada_at INTEGER,
    updated_at INTEGER NOT NULL
  );
`);

function cargarEstado(tel) {
  const row = db.prepare('SELECT historial, cerrada_at FROM conversaciones_estado WHERE telefono = ?').get(tel);
  if (!row) return { historial: [], cerradaAt: null };
  let historial = [];
  try { historial = JSON.parse(row.historial); } catch(e) {}
  return { historial, cerradaAt: row.cerrada_at || null };
}
function guardarHistorial(tel, historial) {
  db.prepare(`
    INSERT INTO conversaciones_estado (telefono, historial, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(telefono) DO UPDATE SET historial = excluded.historial, updated_at = excluded.updated_at
  `).run(tel, JSON.stringify(historial), Date.now());
}
function marcarCerrada(tel) {
  db.prepare(`
    INSERT INTO conversaciones_estado (telefono, historial, cerrada_at, updated_at)
    VALUES (?, '[]', ?, ?)
    ON CONFLICT(telefono) DO UPDATE SET cerrada_at = excluded.cerrada_at, updated_at = excluded.updated_at
  `).run(tel, Date.now(), Date.now());
}
function estaCerrada(tel) {
  const row = db.prepare('SELECT cerrada_at FROM conversaciones_estado WHERE telefono = ?').get(tel);
  return row && row.cerrada_at && (Date.now() - row.cerrada_at < CIERRE_TTL);
}

const conversaciones = {};
const mensajesProcesados = new Set(); // IDs de mensajes ya respondidos, para no duplicar
const cooldowns = {};
const COOLDOWN_MS = 10000;
const convCerradas = {}; // tel -> timestamp cierre
const CIERRE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 dias

const nodeFetch = require('node-fetch');
async function evoSendText(telefono, texto) {
  await nodeFetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVO_APIKEY },
    body: JSON.stringify({ number: '54' + telefono, text: texto })
  });
}

// ── Envío automático al stock de Ruthina cuando termina el flujo de venta ────
const RUTHINA_URL = process.env.RUTHINA_URL || 'https://compara-conejo-production.up.railway.app';
async function enviarAStock(ld, tel, nombreWA) {
  try {
    const modelo = (ld.modelo || ld.vehiculo || '').trim();
    if (!modelo) { console.log('[STOCK] No se envía: sin modelo/vehiculo identificado para', tel); return; }
    const marca = (ld.marca || '').trim();
    const body = {
      marca: marca || 'Sin especificar',
      modelo,
      version: ld.version || '',
      anio: ld.anio || '',
      km: (ld.km || '').toString().replace(/\D/g, '') || 0,
      precio: (ld.monto || '').toString().replace(/[^\d]/g, '') || '',
      moneda: 'ARS',
      estado: 'A revisar',
      notas: `Cargado automático desde bot de venta WhatsApp. Precio pedido por el vendedor (${ld.nombre || nombreWA}), sujeto a tasación e inspección de Tutu.`,
      ubicacion: 'Compra WhatsApp - A tasar',
      telefono: tel
    };
    const r = await nodeFetch(`${RUTHINA_URL}/api/stock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (data.ok) console.log(`[STOCK] Auto de ${tel} enviado a Ruthina (${data.accion}):`, marca, modelo);
    else console.error('[STOCK] Error de Ruthina al guardar:', data.error);
  } catch(e) { console.error('[STOCK] Error enviando a Ruthina:', e.message); }
}
const PORT = process.env.PORT || 3001;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'osmar1055';
const LEADS_FILE = path.join(__dirname, 'leads_venta.json');

app.use(cors({ origin: '*' }));
app.use(express.json());

// anthropic se instancia al momento de usar para tomar la variable de entorno correctamente
function getAnthropic() { return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); }

// ── Leads ─────────────────────────────────────────────────────────────────────
function readLeads() {
  try { if (fs.existsSync(LEADS_FILE)) return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); } catch(e) {}
  return [];
}
function writeLeads(leads) {
  try { fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2)); } catch(e) {}
}
function saveLead(data) {
  const leads = readLeads();
  const idx = data.sessionId ? leads.findIndex(l => l.sessionId === data.sessionId) : -1;
  if (idx >= 0) {
    leads[idx] = { ...leads[idx], ...data, updatedAt: new Date().toISOString() };
  } else {
    leads.unshift({ ...data, createdAt: new Date().toISOString() });
  }
  writeLeads(leads.slice(0, 500));
}

// ── System Prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Sos Tutusita, asistente virtual de Tutu Automotores, Córdoba Argentina.
Atendés a personas que quieren VENDER su auto a Tutu o dejarlo en consignación.
Hablás como una persona real, cercana, en argentino. Usás "vos". Sos breve y directa.

TU ÚNICO TRABAJO: hacer UNA pregunta por mensaje y esperar la respuesta antes de seguir.
NUNCA hagas dos preguntas en el mismo mensaje.

DETECCIÓN ESPECIAL:
Si en cualquier momento el cliente escribe "CONSIGNACION" (con o sin tilde, mayúsculas o minúsculas) respondé exactamente:
"Perfecto! Un asesor de Tutu te va a contactar a la brevedad para coordinar el ingreso de tu auto en *CONSIGNACIÓN*. Muchas gracias! 🚗"
Y no sigas con el flujo normal.

FLUJO OBLIGATORIO — seguilo SIEMPRE en este orden:

PASO 1 — SALUDO:
"¡Hola! ¿Cómo estás? 😊 Soy Tutusita de Tutu Automotores. Estoy acá para ayudarte a vender tu auto. Proceso texto e imágenes. ¿Cuál es la marca y modelo del auto que querés vender?"

PASO 2 — VERSIÓN:
"¿Cuál es la versión o equipamiento? (ej: Comfortline, Trendline, GNC, Full, etc.)"

PASO 3 — AÑO:
"¿De qué año es?"

PASO 4 — KILÓMETROS:
"¿Cuántos kilómetros tiene?"

PASO 5 — NOMBRE:
"¿Me decís tu nombre completo?"

PASO 7 — MONTO:
"¿Cuánto esperás recibir por el auto?"

PASO 8 — FOTOS:
"¡Perfecto! ¿Podés mandarme algunas fotos del auto? (exterior, interior, tablero)"

PASO 9 — CIERRE:
"¡Muchas gracias por la info! 🙏
Si tenemos un comprador para tu auto te contactamos.
Si querés dejar tu auto físicamente, escribí *CONSIGNACION* y te contactamos. 🚗"

REGLAS:
- UNA sola pregunta por mensaje, siempre
- Si el cliente pregunta algo o habla de otro tema, NO respondas su pregunta. Respondé amablemente: "¡Entiendo! Para poder ayudarte mejor necesito que me respondas: [repetí la última pregunta del flujo]" y volvé al paso donde estabas.
- NUNCA salgas del flujo de preguntas por ningún motivo
- Si el mensaje dice "[El cliente envió una foto]" respondé "¡Fotos recibidas, gracias! 📸" y continuá con el siguiente paso del flujo
- Si mandan fotos respondé: "¡Genial, fotos recibidas! 📸" y continuá con el siguiente paso
- Nunca des precios ni evaluaciones del auto

CLASIFICACIÓN (al final de CADA respuesta, invisible):
Este bloque tiene que reflejar TODO lo que sabés del cliente hasta este punto de la charla, acumulado — no solo lo del último mensaje. Volvé a poner los datos que ya tenías aunque el cliente no los haya repetido ahora.
Un dato que todavía no se preguntó o que el cliente no contestó va como "" (string vacío). NUNCA pongas "X" ni ningún otro texto de relleno — o mandás el dato real, o mandás "".
<!--LEAD:{"nombre":"","telefono":"","marca":"","modelo":"","version":"","vehiculo":"","anio":"","km":"","monto":"","score":""}-->
En "marca" y "modelo" separá lo que el cliente dijo en el Paso 1 (ej: marca:"Volkswagen", modelo:"Gol Trend"). Si no podés distinguir cuál es la marca, dejala vacía y poné todo en "modelo". "vehiculo" es marca+modelo+versión juntos en un solo texto, para mostrar. "version" es lo del Paso 2 (equipamiento/motorización). "score" va "CALIENTE", "TIBIO" o "FRIO" (nunca vacío).

RETOMA DE CONVERSACIÓN:
- Si el historial tiene mensajes anteriores y el cliente escribe algo como "Hola" o "Seguís ahí", continuá desde donde estabas. NO reinicies el flujo.
- Decí: "¡Acá estoy! 😊 Seguimos, te había preguntado [repetir la última pregunta pendiente]"
`;

// ── Webhook Evolution API ────────────────────────────────────────────────────
app.post('/webhook/evolution', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (!body || body.event !== 'messages.upsert') return;
    const msg = body.data;
    if (!msg || msg.key?.fromMe) return;
    if (msg.key?.remoteJid?.endsWith('@g.us')) return;

    // Evolution a veces manda el mismo mensaje más de una vez (al recibirlo y
    // al actualizarlo). Ignoramos duplicados usando el ID único del mensaje.
    const msgId = msg.key?.id;
    if (msgId) {
      if (mensajesProcesados.has(msgId)) {
        console.log(`[VENTA BOT] Mensaje duplicado ignorado: ${msgId}`);
        return;
      }
      mensajesProcesados.add(msgId);
      if (mensajesProcesados.size > 500) {
        const primero = mensajesProcesados.values().next().value;
        mensajesProcesados.delete(primero);
      }
    }

    const esImagen = !!msg.message?.imageMessage;
    const esAudio  = !!msg.message?.audioMessage;
    const contenido = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
    if (!esImagen && (!contenido || contenido.length > 2000)) return;

    const tel = msg.key.remoteJid.replace('@s.whatsapp.net','').replace('@c.us','').replace(/[^0-9]/g,'').replace(/^54/,'');
    if (!tel || tel.length < 8) return;

    // Si la conversacion fue cerrada, ignorar (ahora se verifica en disco, no en memoria)
    if (estaCerrada(tel)) {
      console.log(`[VENTA BOT] Ignorando mensaje de ${tel} - conversacion cerrada`);
      return;
    }

    // Cooldown solo para imagenes
    const ahora = Date.now();
    if (esImagen && cooldowns[tel] && ahora - cooldowns[tel] < COOLDOWN_MS) return;
    if (esImagen) cooldowns[tel] = ahora;

    const nombre = msg.pushName || tel;
    const mensajeParaBot = esImagen ? '[El cliente envió una foto]' : contenido;

    console.log(`[MSG] <- ${nombre} (${tel}): ${mensajeParaBot.slice(0,50)}`);

    // Recuperar historial: primero de memoria (rápido), si no está, de disco
    // (cubre el caso de que el proceso se haya reiniciado)
    if (!conversaciones[tel]) {
      conversaciones[tel] = cargarEstado(tel).historial;
    }
    conversaciones[tel].push({ role: 'user', content: mensajeParaBot });
    if (conversaciones[tel].length > 6) conversaciones[tel] = conversaciones[tel].slice(-6);
    guardarHistorial(tel, conversaciones[tel]);

    const mensajesRecortados = conversaciones[tel].map(m => ({ role: m.role, content: m.content.slice(0,500) }));
    // Llamar directamente a Anthropic, con 1 reintento si viene "overloaded" (picos pasajeros de la API)
    async function llamarConReintento() {
      try {
        return await getAnthropic().messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          system: SYSTEM_PROMPT,
          messages: mensajesRecortados,
        });
      } catch(err) {
        const esOverload = err?.status === 529 || err?.error?.error?.type === 'overloaded_error';
        if (esOverload) {
          console.log('[VENTA BOT] Anthropic saturado, reintentando en 2s...');
          await new Promise(r => setTimeout(r, 2000));
          return await getAnthropic().messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 500,
            system: SYSTEM_PROMPT,
            messages: mensajesRecortados,
          });
        }
        throw err;
      }
    }
    const anthropicResp = await llamarConReintento();
    const rawText = anthropicResp.content[0].text;
    const respuesta = rawText.replace(/<!--LEAD:[\s\S]*?-->/, '').trim();
    const leadMatch = rawText.match(/<!--LEAD:([\s\S]*?)-->/);
    let ld = null;
    if (leadMatch) {
      try {
        ld = JSON.parse(leadMatch[1]);
        if (ld && (ld.score === 'CALIENTE' || ld.score === 'TIBIO')) saveLead({...ld, sessionId: 'wa_'+tel, timestamp: new Date().toISOString()});
      } catch(e) {}
    }
    if (!respuesta) return;

    conversaciones[tel].push({ role: 'assistant', content: respuesta });
    guardarHistorial(tel, conversaciones[tel]);
    await evoSendText(tel, respuesta);
    console.log(`[BOT] -> ${nombre}: ${respuesta.slice(0,60)}`);

    // Detectar cierre para no volver a responder (se guarda en disco, sobrevive a reinicios)
    const FRASES_CIERRE_V = ['si tenemos un comprador', 'te contactamos', 'muchas gracias por la info', 'gracias por la info', 'consignacion', 'consignación'];
    const esCierre = FRASES_CIERRE_V.some(f => respuesta.toLowerCase().includes(f));
    if (esCierre) {
      marcarCerrada(tel);
      console.log(`[VENTA BOT] Conversacion cerrada para ${tel}`);
      if (ld) await enviarAStock(ld, tel, nombre);
    }

  } catch(e) { console.error('[WEBHOOK] Error:', e.message); }
});

// ── Endpoint chat ───────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, sessionId } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'Faltan mensajes' });

  try {
    const response = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages,
    });

    const rawText = response.content[0].text;
    const leadMatch = rawText.match(/<!--LEAD:([\s\S]*?)-->/);
    let leadData = null;
    if (leadMatch) { try { leadData = JSON.parse(leadMatch[1]); } catch(e) {} }
    const cleanText = rawText.replace(/<!--LEAD:[\s\S]*?-->/, '').trim();

    if (leadData && (leadData.score === 'CALIENTE' || leadData.score === 'TIBIO')) {
      saveLead({ ...leadData, sessionId, timestamp: new Date().toISOString() });
    }

    res.json({ message: cleanText, lead: leadData });

  } catch(error) {
    console.error('Error Anthropic:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Leads admin ───────────────────────────────────────────────────────────────
app.post('/api/leads/save', (req, res) => {
  try { saveLead({ ...req.body, source: 'frontend' }); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leads', (req, res) => {
  if (req.headers.authorization !== `Bearer ${ADMIN_SECRET}`)
    return res.status(401).json({ error: 'No autorizado' });
  const leads = readLeads();
  res.json({ total: leads.length, leads });
});

app.delete('/api/leads', (req, res) => {
  if (req.headers.authorization !== `Bearer ${ADMIN_SECRET}`)
    return res.status(401).json({ error: 'No autorizado' });
  writeLeads([]);
  res.json({ ok: true });
});

app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0-venta' }));
app.use(express.static(path.join(__dirname)));
app.listen(PORT, () => {
  console.log(`Tutu Venta Bot corriendo en :${PORT}`);
  console.log('ANTHROPIC_API_KEY presente:', !!process.env.ANTHROPIC_API_KEY);
  console.log('KEY inicio:', (process.env.ANTHROPIC_API_KEY || '').slice(0,10));
});
