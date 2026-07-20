const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config();

let pdfParse;
try { pdfParse = require('pdf-parse'); } catch(e) { console.log('pdf-parse not available'); }

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

async function sbGet(table, query) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?' + (query||''), {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function sbPost(table, body) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function sbPatch(table, id, body) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?id=eq.' + id, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(await r.text());
}

async function sbDelete(table, id) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?id=eq.' + id, {
    method: 'DELETE',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) throw new Error(await r.text());
}

function cleanJson(txt) {
  return txt
    .replace(/^[\s\S]*?(\{)/, '$1')
    .replace(/(\})[\s\S]*$/, '$1')
    .trim();
}

// Soumissions
app.get('/api/soumissions', async (req, res) => {
  try { res.json(await sbGet('soumissions', 'order=created_at.desc')); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/soumissions', async (req, res) => {
  try { res.json(await sbPost('soumissions', req.body)); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.patch('/api/soumissions/:id', async (req, res) => {
  try { await sbPatch('soumissions', req.params.id, req.body); res.json({ success: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/soumissions/:id', async (req, res) => {
  try { await sbDelete('soumissions', req.params.id); res.json({ success: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Veille
app.get('/api/veille', async (req, res) => {
  try { res.json(await sbGet('veille_projets', 'order=created_at.desc')); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/veille', async (req, res) => {
  try { res.json(await sbPost('veille_projets', req.body)); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.patch('/api/veille/:id', async (req, res) => {
  try { await sbPatch('veille_projets', req.params.id, req.body); res.json({ success: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/veille/:id', async (req, res) => {
  try { await sbDelete('veille_projets', req.params.id); res.json({ success: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Extract PDF
app.post('/api/extract-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier recu' });
    if (!pdfParse) return res.status(500).json({ error: 'pdf-parse non disponible' });

    const pdfData = await pdfParse(req.file.buffer);
    const text = pdfData.text.substring(0, 3000);

    const prompt = 'Tu analyses un PDF de soumission Cyrell AMP (fabricant panneaux aluminium, Beloeil QC). Retourne UNIQUEMENT ce JSON sans markdown ni texte avant/apres:\n{"vendeur":"","client":"","contact":"","numero":"","projet":"","valeur":0,"type":"","date":"YYYY-MM-DD","notes":"","priorite":"normale","devise":"CAD"}\n\nREGLES:\nvendeur: nom apres "PAR:" ou "BY:" - seulement le nom Cyrell (Amelie, Pierre Boulanger, Jose, Gabriel, David Theroux, J-F Urbain). Si "PAR: Amelie / Jean Tremblay", prendre "Amelie" seulement. NE JAMAIS mettre le contact client dans vendeur.\ncontact: personne chez le CLIENT. Chercher "A l attention de", "Attn:", nom sous la compagnie cliente.\nclient: nom de la compagnie cliente.\nnumero: numero de soumission ex "2026-15".\nprojet: nom du projet de construction ex "Ecole Sainte-Marie". JAMAIS une superficie (pi2, m2) ni un chiffre. Si "3 049,00 pi2" ou "B2026" => laisser vide "".\nvaleur: montant de "Votre prix" ou "Your Price" avant taxes, chiffre seul.\ndevise: "USD" si mentionne, sinon "CAD".\ntype: trouver le modele CYR dans le texte (CYR-100 a CYR-900). Traitement: "peint" si AAMA/RAL/couleur/peinture mentionne, "anodise" si anodise mentionne. Exemples: "CYR-300 peint", "CYR-400 anodise", "Pannes d acier", "Bacs de plantation".\ndate: date soumission YYYY-MM-DD.\npriorite: "haute" si valeur > 200000.\nnotes: specs importantes (dimensions, epaisseur, couleur, AAMA, superficie).\n\nTexte: ' + text;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await resp.json();
    if (d.error) throw new Error(d.error.message);
    const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const extracted = JSON.parse(cleanJson(txt));
    res.json({ success: true, data: extracted, rawText: text.substring(0, 400) });
  } catch (e) {
    console.error('PDF error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Extract screenshot
app.post('/api/extract-screenshot', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucune image recue' });
    const base64 = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';

    const prompt = 'Tu analyses un screenshot de projet de construction (LinkedIn, Agora, SEAO) pour Cyrell AMP. Retourne UNIQUEMENT ce JSON sans markdown:\n{"nom_projet":"","promoteur":"","architecte":"","region":"","valeur_estimee":0,"type_produit":"","source":"","phase":"Concept","notes":"","lien":""}\n- nom_projet: nom du projet ou immeuble\n- promoteur: developpeur ou maitre d ouvrage\n- architecte: firme d architecture (tres important!)\n- region: ville ou region\n- valeur_estimee: valeur en $ si mentionnee\n- type_produit: CYR-400 peint / CYR-300 peint / Pliages aluminium / Bacs de plantation / Pare-soleil / Autre\n- source: LinkedIn / Agora / SEAO / Autre\n- phase: Concept / Design / Appel d offres / Construction\n- notes: resume utile pour Cyrell\n- lien: URL si visible';

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 700,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: prompt }
        ]}]
      })
    });
    const d = await resp.json();
    if (d.error) throw new Error(d.error.message);
    const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const extracted = JSON.parse(cleanJson(txt));
    res.json({ success: true, data: extracted });
  } catch (e) {
    console.error('Screenshot error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Chat
app.post('/api/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 600,
        system: 'Tu es l assistant du CRM Cyrell AMP. Reponds en francais canadien, court et direct, max 4-5 lignes, pas de markdown. Donnees: ' + (context || ''),
        messages: [{ role: 'user', content: message }]
      })
    });
    const d = await resp.json();
    if (d.error) throw new Error(d.error.message);
    const reply = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    res.json({ reply });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Cyrell CRM running on port ' + PORT));
