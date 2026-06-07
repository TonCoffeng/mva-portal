// netlify/functions/meldpunt.js
// MvA Meldpunt — chat-triage met Claude.
//   - Verifieert de SSO-sessie server-side (wie meldt = uit de DB, niet uit de body).
//   - Praat met de Anthropic API (triage: bug / tip / vraag, vraagt door).
//   - Zodra Claude een melding "klaar" markeert: opslaan in `meldingen` + mail naar Ton (bug/tip).
//
// Vereiste env vars (Netlify-site mva-portal):
//   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
//   RESEND_API_KEY (optioneel — zonder = geen mail, tool werkt verder gewoon)

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;

const MODEL        = 'claude-sonnet-4-6';
const MELD_MAIL_AAN = 'toncoffeng@makelaarsvan.nl';
const MAIL_VAN      = 'MvA Meldpunt <noreply@makelaarsvan.nl>';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const SYSTEM_PROMPT = `Je bent het "MvA Meldpunt" — een vriendelijke assistent van Makelaars van Amsterdam waar makelaars en collega's bugs en tips kwijt kunnen over het interne platform (MvA Intelligence).

Het platform bestaat o.a. uit: de Leadpool (bezichtigingen, bellijst, leads doorgeven), WWFT/Finance, OTD (opdracht tot dienstverlening), het Portal, dashboards en het beloningssysteem.

Jouw taak is verzamelen en scherp krijgen — NIET zelf oplossen. Je past zelf niets aan en belooft geen reparaties; je zegt dat Ton en het team ernaar kijken.

Werkwijze:
- Schrijf in het Nederlands, warm en beknopt. Stel hooguit ÉÉN vraag per bericht.
- De gebruiker kan screenshots of documenten meesturen. Je ziet die zelf niet, maar als er in een bericht "[Bijlage toegevoegd: ...]" staat, bevestig dat dan kort ("Top, ik heb je screenshot erbij") en gebruik het als signaal dat de melding compleet genoeg wordt.
- Bepaal of het gaat om een BUG (iets werkt niet zoals het hoort), een TIP/idee (een verbetering), of een VRAAG.
- Bij een BUG vraag je gericht door tot je dit helder hebt: welke app/welk scherm, wat deed de gebruiker, wat ging er mis, wat verwachtte hij, sinds wanneer / hoe vaak. Schat daarna de prioriteit (laag/midden/hoog).
- Bij een TIP vraag je door: welk probleem lost het op, voor wie, en hoe ziet de gebruiker het voor zich. Houd het kort.
- Bij een VRAAG: beantwoord kort als je het zeker weet; weet je het niet, noteer het dan als vraag voor Ton.
- Meestal heb je na 2 tot 4 berichten genoeg. Vat dan kort samen in gewone taal en rond af.

Afsluiten: zodra je genoeg informatie hebt, eindig je bericht met een korte, vriendelijke samenvatting voor de gebruiker, en zet je op een NIEUWE regel exact dit blok (en niets erna):
\`\`\`meldpunt-json
{"klaar":true,"type":"bug","titel":"korte titel","samenvatting":"1 tot 3 zinnen in gewone taal","details":"reproductiestappen of context","app":"welke app/onderdeel","prioriteit":"midden"}
\`\`\`
Gebruik voor "type" exact één van: bug, tip, vraag. Voor "prioriteit": laag, midden of hoog. Zolang je nog niet genoeg weet, voeg je GEEN blok toe en stel je gewoon je volgende vraag. Noem het blok of JSON nooit hardop tegen de gebruiker.`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // ── Auth: token uit de Authorization-header, gebruiker uit de DB ──
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Niet ingelogd' }) };

  let gebruiker;
  try {
    gebruiker = await verifieerGebruiker(token);
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Authenticatie mislukt' }) };
  }
  if (!gebruiker) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Sessie ongeldig of verlopen' }) };

  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Meldpunt is nog niet geconfigureerd (API-key ontbreekt).' }) };
  }

  let messages, bijlagenIn = [];
  try {
    const body = JSON.parse(event.body || '{}');
    messages = Array.isArray(body.messages) ? body.messages : [];
    bijlagenIn = Array.isArray(body.bijlagen) ? body.bijlagen : [];
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige aanvraag' }) };
  }
  // Saniteer: alleen rol+content, en cap de lengte van het gesprek.
  messages = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (messages.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Geen bericht ontvangen' }) };
  }

  // Bijlagen saniteren: alleen veldjes die we kennen, maximaal 10.
  const bijlagen = bijlagenIn
    .filter((b) => b && typeof b.pad === 'string')
    .slice(0, 10)
    .map((b) => ({
      naam: String(b.naam || 'bestand').slice(0, 120),
      pad: String(b.pad).slice(0, 300),
      type: String(b.type || '').slice(0, 80),
    }));

  // ── Claude aanroepen ──
  let antwoord;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[meldpunt] Anthropic-fout:', JSON.stringify(data));
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Claude is even niet bereikbaar. Probeer het zo nog eens.' }) };
    }
    antwoord = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  } catch (e) {
    console.error('[meldpunt] fetch-fout:', e.message);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Claude is even niet bereikbaar. Probeer het zo nog eens.' }) };
  }

  // ── Klaar-blok eruit halen (indien aanwezig) ──
  let melding = null;
  const m = antwoord.match(/```meldpunt-json\s*([\s\S]*?)```/);
  let zichtbaarAntwoord = antwoord;
  if (m) {
    zichtbaarAntwoord = antwoord.replace(m[0], '').trim();
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed && parsed.klaar) melding = parsed;
    } catch (e) {
      console.warn('[meldpunt] kon klaar-blok niet parsen:', e.message);
    }
  }

  // ── Opslaan + mailen als er een melding klaar is ──
  let opgeslagen = false;
  if (melding) {
    const type = ['bug', 'tip', 'vraag'].includes(melding.type) ? melding.type : 'anders';
    const prioriteit = ['laag', 'midden', 'hoog'].includes(melding.prioriteit) ? melding.prioriteit : 'midden';
    const rij = {
      gebruiker_id: gebruiker.id,
      gebruiker_naam: gebruiker.naam,
      type,
      titel: (melding.titel || '').slice(0, 200),
      samenvatting: (melding.samenvatting || '').slice(0, 2000),
      details: (melding.details || '').slice(0, 4000),
      app: (melding.app || '').slice(0, 120),
      prioriteit,
      transcript: [...messages, { role: 'assistant', content: antwoord }],
      bijlagen,
    };
    try {
      await sbInsert('meldingen', rij);
      opgeslagen = true;
    } catch (e) {
      console.error('[meldpunt] opslaan mislukt:', e.message);
    }
    if (opgeslagen && (type === 'bug' || type === 'tip') && RESEND_KEY) {
      try {
        await mailNaarTon(rij);
      } catch (e) {
        console.warn('[meldpunt] mail mislukt:', e.message);
      }
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      reply: zichtbaarAntwoord || 'Dank je! Genoteerd.',
      opgeslagen,
      type: melding ? melding.type : null,
    }),
  };
};

// ── Helpers ──────────────────────────────────────────────────────

async function verifieerGebruiker(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json();
  if (!user || !user.id) return null;
  const q = await fetch(
    `${SUPABASE_URL}/rest/v1/gebruikers?select=id,naam,rol,actief&auth_uuid=eq.${user.id}&limit=1`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  );
  if (!q.ok) return null;
  const rows = await q.json();
  const g = rows && rows[0];
  if (!g || g.actief === false) return null;
  return g;
}

async function sbInsert(tabel, rij) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${tabel}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rij),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`insert ${r.status}: ${t}`);
  }
}

async function mailNaarTon(rij) {
  const labels = { bug: '🐛 Bug', tip: '💡 Tip', vraag: '❓ Vraag', anders: 'Melding' };
  const onderwerp = `[Meldpunt] ${labels[rij.type] || 'Melding'} — ${rij.titel || 'zonder titel'}`;

  // Bijlagen: tijdelijke downloadlinks (30 dagen geldig).
  let bijlagenHtml = '';
  if (Array.isArray(rij.bijlagen) && rij.bijlagen.length) {
    const items = [];
    for (const b of rij.bijlagen) {
      const url = await signedUrl(b.pad).catch(() => null);
      items.push(url
        ? `<li><a href="${url}" style="color:#1A2B5F">${escapeHtml(b.naam)}</a></li>`
        : `<li>${escapeHtml(b.naam)} (link niet beschikbaar)</li>`);
    }
    bijlagenHtml = `<p style="color:#444"><b>Bijlagen:</b></p><ul style="margin-top:0">${items.join('')}</ul>`;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;color:#2A2A2A;max-width:560px">
      <h2 style="color:#1A2B5F;margin-bottom:4px">${labels[rij.type] || 'Melding'}</h2>
      <p style="color:#6B6B6B;margin-top:0">Van ${escapeHtml(rij.gebruiker_naam || 'onbekend')} · prioriteit ${rij.prioriteit} · ${escapeHtml(rij.app || '—')}</p>
      <p><b>${escapeHtml(rij.titel || '')}</b></p>
      <p>${escapeHtml(rij.samenvatting || '')}</p>
      ${rij.details ? `<p style="color:#444"><b>Details:</b><br>${escapeHtml(rij.details).replace(/\n/g, '<br>')}</p>` : ''}
      ${bijlagenHtml}
      <hr style="border:none;border-top:1px solid #E7E3DB">
      <p style="font-size:12px;color:#9A9A9A">MvA Meldpunt · staat in de meldingen-tabel met status 'nieuw'.</p>
    </div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_VAN, to: MELD_MAIL_AAN, subject: onderwerp, html }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Tijdelijke (30 dagen) downloadlink voor een bestand in de privé-bucket.
async function signedUrl(pad) {
  const segs = String(pad).split('/').map(encodeURIComponent).join('/');
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/meldpunt-bijlagen/${segs}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 30 }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d && d.signedURL ? `${SUPABASE_URL}/storage/v1${d.signedURL}` : null;
}
