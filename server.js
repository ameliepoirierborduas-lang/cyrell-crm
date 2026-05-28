const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const pdf = require('pdf-parse');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ─── Supabase helpers ────────────────────────────────────────────────────────
async function sbGet(table, query = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  return r.json();
}

async function sbPost(table, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  return r.json();
}

async function sbPatch(table, id, body) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(body)
  });
}

// ─── Soumissions routes ──────────────────────────────────────────────────────
app.get('/api/soumissions', async (req, res) => {
  try { res.json(await sbGet('soumissions', 'order=created_at.desc')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/soumissions', async (req, res) => {
  try { res.json(await sbPost('soumissions', req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/soumissions/:id', async (req, res) => {
  try { await sbPatch('soumissions', req.params.id, req.body); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Veille projets routes ───────────────────────────────────────────────────
app.get('/api/veille', async (req, res) => {
  try { res.json(await sbGet('veille_projets', 'order=created_at.desc')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/veille', async (req, res) => {
  try { res.json(await sbPost('veille_projets', req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/veille/:id', async (req, res) => {
  try { await sbPatch('veille_projets', req.params.id, req.body); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/veille/:id', async (req, res) => {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/veille_projets?id=eq.${req.params.id}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Extract PDF (soumission) ────────────────────────────────────────────────
app.post('/api/extract-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
    const pdfData = await pdf(req.file.buffer);
    const text = pdfData.text.substring(0, 3000);

    const prompt = `Tu analyses un PDF de soumission Cyrell AMP (fabricant panneaux aluminium architectural, Beloeil QC).

Formats possibles:
- FORMAT 1 — Panneaux alu: champ "PAR:" = vendeur, "Votre prix" = valeur, produits CYR-400/300/500/600, pliages, bacs, pare-soleil, plaques
- FORMAT 2 — Pannes acier: "PAR:" = vendeur, "Votre prix:" = valeur, acier G90, Roxul
- FORMAT 3 — Cassettes ancien: "PAR:" = vendeur, panneaux plat cassette, AAMA-2605
- FORMAT 4 — Quote anglais: "BY:" = vendeur, "Your Price" ou "Price" = valeur, peut être en USD

Retourne UNIQUEMENT ce JSON sans markdown:
{"vendeur":"","client":"","contact":"","numero":"","projet":"","valeur":0,"type":"","date":"YYYY-MM-DD","notes":"","priorite":"normale","devise":"CAD"}

Règles:
- vendeur: valeur après PAR: ou BY:
- client: nom compagnie cliente
- valeur: montant numérique "Votre prix" ou "Your Price" ou "Price" (sans taxes)
- devise: "USD" si "in USD" mentionné, sinon "CAD"
- type: Panneaux CYR-400 rectangulaires / Panneaux CYR-400 mixte / Panneaux CYR-300 / Panneaux CYR-500/600 / Panneaux anodisés / Pliages aluminium / Bacs de plantation / Pare-soleil / Plaques aluminium / Pannes d'acier / Autre
- priorite: "haute" si valeur > 200000
- date: YYYY-MM-DD (ex: "Feb 4th, 2026"="2026-02-04", "3/12/2025"="2025-03-12")
- notes: projet + produit + specs importantes

Texte: ${text}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await resp.json();
    if (d.error) throw new Error(d.error.message);
    const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const extracted = JSON.parse(txt.replace(/```json|```/g, '').trim());
    res.json({ success: true, data: extracted, rawText: text.substring(0, 400) });
  } catch (e) {
    console.error('PDF error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Extract screenshot (veille projets) ────────────────────────────────────
app.post('/api/extract-screenshot', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucune image reçue' });

    const base64 = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';

    const prompt = `Tu analyses un screenshot d'un projet de construction (LinkedIn, Agora, SEAO, site web, etc.) pour Cyrell AMP, fabricant de panneaux d'aluminium architectural au Québec.

Extrait les informations disponibles et retourne UNIQUEMENT ce JSON sans markdown:
{"nom_projet":"","promoteur":"","architecte":"","region":"","valeur_estimee":0,"type_produit":"","source":"","phase":"Concept","notes":"","lien":""}

Règles:
- nom_projet: nom du projet ou de l'immeuble
- promoteur: développeur ou maître d'ouvrage
- architecte: firme d'architecture si mentionnée (TRÈS important pour Cyrell!)
- region: ville ou région du projet
- valeur_estimee: valeur du projet en $ si mentionnée (juste le chiffre)
- type_produit: parmi Panneaux CYR-400, Panneaux CYR-300, Pliages aluminium, Bacs de plantation, Pare-soleil, Autre — devine selon le type de bâtiment (tour = CYR-400, bâtiment commercial = CYR-400 ou CYR-300)
- source: LinkedIn / Agora / SEAO / Site web / Autre
- phase: Concept / Design / Appel d'offres / Construction
- notes: résumé du projet, nombre d'étages, usage (résidentiel/commercial/institutionnel), tout détail pertinent pour Cyrell
- lien: URL si visible dans le screenshot

Si une info n'est pas disponible, laisse la valeur vide ou 0.`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 700,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    const d = await resp.json();
    if (d.error) throw new Error(d.error.message);
    const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const extracted = JSON.parse(txt.replace(/```json|```/g, '').trim());
    res.json({ success: true, data: extracted });
  } catch (e) {
    console.error('Screenshot error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── AI Chat ─────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 800,
        system: `Tu es l'assistant du CRM Cyrell AMP. Réponds en français canadien, de façon courte et directe — maximum 4-5 lignes. Pas de markdown, pas de gras, pas de titres. Texte naturel et conversationnel. Données: ${context || ''}`,
        messages: [{ role: 'user', content: message }]
      })
    });
    const d = await resp.json();
    if (d.error) throw new Error(d.error.message);
    const reply = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Cyrell CRM on port ${PORT}`));
