// netlify/functions/meldpunt-inbound.js
// Ontvangt replies van melders via Resend Inbound (event 'email.received') en hangt
// ze als bericht (van: 'melder') aan de juiste melding in de berichten-thread.
//
// Flow:
//   melder mailt reply naar reply+<id>@<MELDPUNT_REPLY_DOMAIN>
//     -> Resend ontvangt (catch-all op het subdomein) en POST't deze functie
//     -> wij verifiëren de Svix-handtekening, halen de body op via de Receiving API,
//        knippen de quote-historie eraf en schrijven 'm in meldingen.correspondentie.
//
// Vereiste env vars (Netlify-site mva-portal):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY, RESEND_WEBHOOK_SECRET
//
// Resend-config (eenmalig): MX op het subdomein -> Resend, en een webhook
// (event 'email.received') die naar /.netlify/functions/meldpunt-inbound wijst.

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;

const MAIL_VAN      = 'MvA Meldpunt <noreply@makelaarsvan.nl>';
const MELD_MAIL_AAN = 'toncoffeng@makelaarsvan.nl';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  if (!WEBHOOK_SECRET || !SUPABASE_URL || !SERVICE_KEY) {
    console.error('[meldpunt-inbound] niet geconfigureerd (env ontbreekt)');
    return { statusCode: 503, body: 'Not configured' };
  }

  // Headers normaliseren naar lowercase (Netlify doet dit meestal al).
  const h = {};
  for (const k in (event.headers || {})) h[k.toLowerCase()] = event.headers[k];
  const raw = event.body || '';

  if (!verifieerSvix(WEBHOOK_SECRET, h, raw)) {
    console.warn('[meldpunt-inbound] ongeldige of ontbrekende handtekening');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let payload;
  try { payload = JSON.parse(raw); } catch { return { statusCode: 400, body: 'Bad JSON' }; }
  if (!payload || payload.type !== 'email.received') {
    return { statusCode: 200, body: 'ignored' };
  }

  const data = payload.data || {};
  const toLijst = Array.isArray(data.to) ? data.to : [];

  // Meldingsnummer uit reply+<id>@... halen
  let meldingId = null;
  for (const adres of toLijst) {
    const m = /reply\+(\d+)@/i.exec(String(adres || ''));
    if (m) { meldingId = parseInt(m[1], 10); break; }
  }
  if (!meldingId) {
    console.warn('[meldpunt-inbound] geen meldingsnummer in to:', toLijst);
    return { statusCode: 200, body: 'no match' }; // 200 zodat Resend niet blijft retryen
  }

  try {
    // Melding ophalen
    const rows = await sbSelect(
      `meldingen?select=id,gebruiker_id,gebruiker_naam,status,correspondentie&id=eq.${meldingId}&limit=1`
    );
    const melding = rows[0];
    if (!melding) {
      console.warn('[meldpunt-inbound] melding niet gevonden:', meldingId);
      return { statusCode: 200, body: 'unknown melding' };
    }

    // Body ophalen via Receiving API (webhook bevat alleen metadata)
    const ruweTekst = await haalBody(data.email_id);
    const tekst = schoonReply(ruweTekst);
    if (!tekst) {
      console.warn('[meldpunt-inbound] lege reply na opschonen, melding', meldingId);
      return { statusCode: 200, body: 'empty' };
    }

    // Aan de thread hangen
    const eerdere = Array.isArray(melding.correspondentie) ? melding.correspondentie : [];
    const nieuw = {
      van: 'melder',
      naam: melding.gebruiker_naam || 'Melder',
      van_email: data.from || '',
      tekst,
      op: new Date().toISOString(),
    };
    const patch = {
      correspondentie: [...eerdere, nieuw],
      bijgewerkt_op: new Date().toISOString(),
    };
    // Reageert de melder op een afgehandelde melding, dan heropenen we 'm.
    if (melding.status === 'afgerond' || melding.status === 'afgewezen') {
      patch.status = 'in_behandeling';
      patch.melder_gemaild_op = null;
    }
    await sbPatch(`meldingen?id=eq.${meldingId}`, patch);

    // Ton een seintje geven (best effort)
    if (RESEND_KEY) {
      try { await meldTon(meldingId, nieuw); } catch (e) { console.warn('[meldpunt-inbound] seintje mislukt:', e.message); }
    }

    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.error('[meldpunt-inbound] fout:', e.message);
    // 200 terug: Resend bewaart de mail sowieso; eindeloos retryen heeft geen zin.
    return { statusCode: 200, body: 'logged' };
  }
};

// ── Svix-handtekening verifiëren (Resend gebruikt Svix) ──
function verifieerSvix(secret, h, payload) {
  const id  = h['svix-id'];
  const ts  = h['svix-timestamp'];
  const sigHeader = h['svix-signature'];
  if (!id || !ts || !sigHeader) return false;

  // Replay-bescherming: tijdstempel binnen ~10 minuten
  const nu = Math.floor(Date.now() / 1000);
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(nu - tsNum) > 600) return false;

  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const verwacht = crypto.createHmac('sha256', key).update(`${id}.${ts}.${payload}`).digest('base64');

  return sigHeader.split(' ').some((deel) => {
    const sig = deel.split(',')[1];
    if (!sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(verwacht);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

// ── Body ophalen via Resend Receiving API ──
async function haalBody(emailId) {
  if (!emailId || !RESEND_KEY) return '';
  const r = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${RESEND_KEY}` },
  });
  if (!r.ok) throw new Error(`receiving ${r.status}: ${await r.text()}`);
  const d = await r.json();
  if (d && typeof d.text === 'string' && d.text.trim()) return d.text;
  if (d && typeof d.html === 'string') return d.html.replace(/<[^>]+>/g, ' ');
  return '';
}

// ── Reply opschonen: quote-historie en footers eraf ──
function schoonReply(text) {
  if (!text) return '';
  let t = String(text).replace(/\r\n/g, '\n');
  const markers = [
    /\n>?\s*Op .+ schreef .+:/i,        // NL "Op <datum> schreef <naam>:"
    /\n>?\s*On .+ wrote:/i,             // EN "On <datum> ... wrote:"
    /\n-{3,}\s*Original Message\s*-{3,}/i,
    /\nVan: .+\nVerzonden:/i,           // Outlook NL
    /\nFrom: .+\nSent:/i,               // Outlook EN
    /\n_{5,}/,                          // Outlook scheidingslijn
    /\nBericht over je melding/,        // onze eigen mailkop
    /\nUpdate over je melding/,
    /\nJe melding is opgepakt/,
    /\nMvA Meldpunt/,                   // onze eigen footer
  ];
  let snij = t.length;
  for (const m of markers) {
    const idx = t.search(m);
    if (idx >= 0 && idx < snij) snij = idx;
  }
  t = t.slice(0, snij);
  t = t.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n').trim();
  return t.slice(0, 4000);
}

// ── Supabase REST helpers (service role) ──
async function sbSelect(pad) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pad}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`select ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbPatch(pad, patch) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pad}`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`patch ${r.status}: ${await r.text()}`);
}

// ── Seintje naar Ton ──
async function meldTon(meldingId, bericht) {
  const kort = bericht.tekst.length > 300 ? bericht.tekst.slice(0, 300) + '\u2026' : bericht.tekst;
  const html = `
    <div style="font-family:Arial,sans-serif;color:#2A2A2A;max-width:560px">
      <h2 style="color:#1A2B5F;margin-bottom:4px">Nieuwe reactie op melding #${meldingId}</h2>
      <p><b>${escapeHtml(bericht.naam)}</b> heeft gereageerd:</p>
      <p style="color:#444;background:#F6F4EF;border-radius:8px;padding:12px">${escapeHtml(kort).replace(/\n/g, '<br>')}</p>
      <p style="color:#6B6B6B">Open het Meldpunt op het portal, tab "Meldingen", om te reageren.</p>
    </div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_VAN, to: MELD_MAIL_AAN, subject: `[Meldpunt] Reactie op melding #${meldingId}`, html }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
