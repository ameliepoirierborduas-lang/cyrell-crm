const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const pdf = require('pdf-parse');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ─── Health check ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Extract PDF ─────────────────────────────────────────────────────────────
app.post('/api/extract-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

    // Extract text from PDF
    const pdfData = await pdf(req.file.buffer);
    const text = pdfData.text.substring(0, 3000);

    // Call Anthropic API (server-side — no CORS issues!)
    const prompt = `Tu analyses un PDF de soumission de l'entreprise Cyrell AMP (fabricant de panneaux d'aluminium architectural et de pannes d'acier, Beloeil QC).

Il existe PLUSIEURS formats de soumissions Cyrell — tu dois reconnaître chacun:

FORMAT 1 — Panneaux aluminium (le plus courant):
- Champ "PAR:" = vendeur (ex: Amélie, Gabriel, José, Pierre Boulanger, David Théroux, J-F Urbain, Cassie, etc.)
- Champ "No. de soumission:" ou "Numéro:" = numéro
- Champ "Date:" = date  
- Champ "Votre prix" = valeur avant taxes
- Produits: CYR-400, CYR-300, CYR-500, CYR-600, pliages, bacs plantation, pare-soleil, plaques

FORMAT 2 — Pannes d'acier:
- Champ "PAR:" = vendeur
- Champ "Votre prix:" = valeur
- Produit: pannes acier G90, isolant Roxul, acier 20g

FORMAT 3 — Panneaux cassette (ancien format):
- "PAR:" = vendeur
- Produits: panneaux plat cassette aluminium, peinture en poudre AAMA-2605

TYPES disponibles:
Panneaux CYR-400 rectangulaires, Panneaux CYR-400 formes irrégulières, Panneaux CYR-400 mixte, Panneaux CYR-300, Panneaux CYR-500/600, Panneaux anodisés, Pliages aluminium, Bacs de plantation, Pare-soleil, Plaques aluminium, Pannes d'acier, Autre

Retourne UNIQUEMENT ce JSON (sans markdown, sans explication):
{"vendeur":"","client":"","contact":"","numero":"","projet":"","valeur":0,"type":"","date":"YYYY-MM-DD","notes":"","priorite":"normale"}

Règles:
- vendeur: valeur exacte après "PAR:" 
- client: nom complet de la compagnie cliente
- valeur: montant numérique de "Votre prix" (sans $ ni taxes)
- type: le plus approprié dans la liste
- priorite: "haute" si valeur > 200000, sinon "normale"
- notes: résumé: projet + type produit + specs (épaisseur, fini, couleur, pi², quantité, prix/pi²)
- date: convertir en YYYY-MM-DD (ex: "11/Mar/26"="2026-03-11", "12-10-2023"="2023-10-12", "4-May-2026"="2026-05-04")

Texte du PDF:
${text}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const aiData = await response.json();
    if (aiData.error) throw new Error(aiData.error.message);

    const txt = (aiData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const extracted = JSON.parse(txt.replace(/```json|```/g, '').trim());

    res.json({ success: true, data: extracted, rawText: text.substring(0, 500) });

  } catch (err) {
    console.error('PDF extraction error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── AI Chat ──────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    if (!message) return res.status(400).json({ error: 'Message requis' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 800,
        system: `Tu es l'assistant IA expert du CRM de Cyrell AMP, fabricant québécois de panneaux d'aluminium architectural (CYR-300, CYR-400, CYR-500/600, pliages, bacs, pare-soleil, pannes d'acier). Tu réponds en français canadien, de façon concise, professionnelle et orientée action. Tu fournis des analyses précises et des recommandations stratégiques basées sur les données réelles. Données pipeline en temps réel: ${context || 'Aucune donnée disponible'}`,
        messages: [{ role: 'user', content: message }]
      })
    });

    const aiData = await response.json();
    if (aiData.error) throw new Error(aiData.error.message);

    const reply = (aiData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    res.json({ reply });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Supabase proxy (pour éviter d'exposer la clé côté client) ───────────────
app.get('/api/soumissions', async (req, res) => {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/soumissions?order=created_at.desc`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/soumissions', async (req, res) => {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/soumissions`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/soumissions/:id', async (req, res) => {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/soumissions?id=eq.${req.params.id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(req.body)
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Cyrell CRM running on port ${PORT}`));
