require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');

const app  = express();
const PORT = process.env.PORT || 3001;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'osmar1055';
const LEADS_FILE = path.join(__dirname, 'leads_venta.json');

app.use(cors({ origin: '*' }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
"Perfecto! Un asesor de Tutu te va a contactar a la brevedad para coordinar el ingreso de tu auto. Muchas gracias! 🚗"
Y no sigas con el flujo normal.

FLUJO OBLIGATORIO — seguilo SIEMPRE en este orden:

PASO 1 — SALUDO:
"¡Hola! ¿Cómo estás? 😊 Soy Tutusita de Tutu Automotores.
Estoy acá para ayudarte a vender tu auto. Proceso texto e imágenes.
¿Cuál es la marca y modelo del auto que querés vender?"

PASO 2 — VERSIÓN:
"¿Cuál es la versión o equipamiento? (ej: Comfortline, Trendline, GNC, Full, etc.)"

PASO 3 — AÑO:
"¿De qué año es?"

PASO 4 — KILÓMETROS:
"¿Cuántos kilómetros tiene?"

PASO 5 — NOMBRE:
"¿Me decís tu nombre completo?"

PASO 6 — TELÉFONO:
"¿Y tu número de teléfono o WhatsApp para contactarte?"

PASO 7 — MONTO:
"¿Cuánto esperás recibir por el auto?"

PASO 8 — FOTOS:
"¡Perfecto! ¿Podés mandarme algunas fotos del auto? (exterior, interior, tablero)"

PASO 9 — CIERRE:
"¡Muchas gracias por la info! 🙏
Si tenemos un comprador para tu auto te contactamos.
Si querés dejar tu auto físicamente, escribí CONSIGNACION y te contactamos. 🚗"

REGLAS:
- UNA sola pregunta por mensaje, siempre
- Si el cliente pregunta algo o habla de otro tema, NO respondas su pregunta. Respondé amablemente: "¡Entiendo! Para poder ayudarte mejor necesito que me respondas: [repetí la última pregunta del flujo]" y volvé al paso donde estabas.
- NUNCA salgas del flujo de preguntas por ningún motivo
- Si el mensaje dice "[El cliente envió una foto]" respondé "¡Fotos recibidas, gracias! 📸" y continuá con el siguiente paso del flujo
- Si mandan fotos respondé: "¡Genial, fotos recibidas! 📸" y continuá con el siguiente paso
- Nunca des precios ni evaluaciones del auto

CLASIFICACIÓN (al final de CADA respuesta, invisible):
<!--LEAD:{"nombre":"X","telefono":"X","vehiculo":"X","anio":"X","km":"X","monto":"X","score":"CALIENTE/TIBIO/FRIO"}-->`;

// ── Endpoint chat ─────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, sessionId } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'Faltan mensajes' });

  try {
    const response = await anthropic.messages.create({
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
app.listen(PORT, () => console.log(`Tutu Venta Bot corriendo en :${PORT}`));
