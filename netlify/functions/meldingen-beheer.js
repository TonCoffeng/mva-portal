// netlify/functions/meldingen-beheer.js
// MvA Meldpunt — directie-inbox.
//   - Verifieert de SSO-sessie server-side (rol uit de DB, niet uit de body).
//   - Alleen rol 'directie' mag hier iets.
//   - GET            → lijst van alle meldingen (nieuwste eerst).
//   - POST {actie:'bijwerken', id, status?, directie_notitie?} → status/notitie aanpassen.
//
// Vereiste env vars (Netlify-site mva-portal) — al aanwezig voor het Meldpunt:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const MAIL_VAN     = 'MvA Meldpunt <noreply@makelaarsvan.nl>';

const GELDIGE_STATUS = ['nieuw', 'opgepakt', 'klaar', 'afgewezen'];

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Niet geconfigureerd (Supabase-keys ontbreken).' }) };
  }

  // ── Auth: token uit de Authorization-header, gebruiker + rol uit de DB ──
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
  if (gebruiker.rol !== 'directie') {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen voor directie' }) };
  }

  // ── GET: lijst ──
  if (event.httpMethod === 'GET') {
    try {
      const rows = await sbGet(
        'meldingen',
        'select=id,gebruiker_naam,type,titel,samenvatting,details,app,prioriteit,status,directie_notitie,afgehandeld_door,melder_gemaild_op,bijlagen,aangemaakt_op,bijgewerkt_op&order=aangemaakt_op.desc&limit=500'
      );
      return { statusCode: 200, headers, body: JSON.stringify({ meldingen: rows }) };
    } catch (e) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Ophalen mislukt' }) };
    }
  }

  // ── POST: bijwerken ──
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige aanvraag' }) }; }

    if (body.actie !== 'bijwerken') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Onbekende actie' }) };
    }
    const id = Number(body.id);
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Geen geldig id' }) };

    const patch = { bijgewerkt_op: new Date().toISOString() };
    if (body.status !== undefined) {
      if (!GELDIGE_STATUS.includes(body.status)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige status' }) };
      }
      patch.status = body.status;
      patch.afgehandeld_door = gebruiker.naam;
    }
    if (body.directie_notitie !== undefined) {
      patch.directie_notitie = String(body.directie_notitie).slice(0, 4000);
    }

    try {
      const rows = await sbPatch('meldingen', `id=eq.${id}`, patch);
      let m = rows && rows[0];
      let gemaild = false;

      // Terugkoppeling naar de melder zodra de melding op 'klaar' gaat — eenmalig.
      if (m && patch.status === 'klaar' && !m.melder_gemaild_op) {
        try {
          const verstuurd = await mailNaarMelder(m);
          if (verstuurd) {
            const na = await sbPatch('meldingen', `id=eq.${id}`, { melder_gemaild_op: new Date().toISOString() });
            if (na && na[0]) m = na[0];
            gemaild = true;
          }
        } catch (e) { /* een mislukte mail mag het afronden niet blokkeren */ }
      }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, melding: m, gemaild }) };
    } catch (e) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Bijwerken mislukt' }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
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

async function sbGet(tabel, query) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${tabel}?${query}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`get ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbPatch(tabel, filter, patch) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${tabel}?${filter}`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`patch ${r.status}: ${await r.text()}`);
  return r.json();
}

// Stuurt de melder een terugkoppeling met de fix (= directie_notitie). Geeft true terug bij verzending.
async function mailNaarMelder(m) {
  if (!RESEND_KEY || !m.gebruiker_id) return false;

  let email = null, naam = m.gebruiker_naam || '';
  try {
    const rows = await sbGet('gebruikers', `select=email,naam&id=eq.${m.gebruiker_id}&limit=1`);
    const g = rows && rows[0];
    if (g) { email = (g.email || '').trim() || null; naam = g.naam || naam; }
  } catch (e) { return false; }
  if (!email) return false;

  const voornaam = (naam || '').trim().split(/\s+/)[0] || 'collega';
  const titel = m.titel || 'je melding';
  const fix = (m.directie_notitie || '').trim();
  const onderwerp = `Je melding is opgelost — ${titel}`;

  const fixBlok = fix
    ? `<div style="background:#EAF3DE;border:1px solid #cfe3b4;border-radius:8px;padding:12px 14px;margin:14px 0">
         <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#3A6310;margin-bottom:5px">Wat we hebben gedaan</div>
         <div style="white-space:pre-wrap;font-size:14px;line-height:1.55">${escapeHtml(fix)}</div>
       </div>`
    : `<p style="margin:14px 0;font-size:14px;line-height:1.55">We hebben je melding opgepakt en afgerond.</p>`;

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#2A2A2A">
       <div style="background:#1A2B5F;padding:18px 22px;border-radius:10px 10px 0 0">
         <span style="color:#fff;font-size:16px;font-weight:bold">Makelaars van Amsterdam</span>
         <span style="color:rgba(255,255,255,.6);font-size:11px;letter-spacing:.06em;text-transform:uppercase;display:block;margin-top:2px">MvA Intelligence · Meldpunt</span>
       </div>
       <div style="border:1px solid #E7E3DB;border-top:none;border-radius:0 0 10px 10px;padding:22px">
         <p style="margin:0 0 12px;font-size:14px">Hoi ${escapeHtml(voornaam)},</p>
         <p style="margin:0 0 6px;font-size:14px">Je melding via het Meldpunt is afgehandeld:</p>
         <p style="margin:0;font-weight:bold;font-size:15px;color:#1A2B5F">${escapeHtml(titel)}</p>
         ${fixBlok}
         <p style="margin:14px 0 0;color:#6B6760;font-size:13px">Bedankt voor het melden — dat helpt ons het platform te verbeteren.</p>
         <p style="margin:16px 0 0;font-size:12px;color:#9A968D">MvA Intelligence</p>
       </div>
     </div>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_VAN, to: email, subject: onderwerp, html }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
  return true;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}
