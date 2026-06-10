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
        'select=id,gebruiker_naam,type,titel,samenvatting,details,app,prioriteit,status,directie_notitie,afgehandeld_door,bijlagen,aangemaakt_op,bijgewerkt_op&order=aangemaakt_op.desc&limit=500'
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
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, melding: rows && rows[0] }) };
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
