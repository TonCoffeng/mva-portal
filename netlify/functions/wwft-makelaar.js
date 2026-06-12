// netlify/functions/wwft-makelaar.js
// WWFT portaal voor makelaars — eigen zaken inzien, bewijs uploaden, vinkje zetten.
//
// Vereiste env vars (site mva-portal):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const BUCKET        = 'wwft-bewijs';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null };
}

// Verifieer sessie-token en geef gebruiker terug
async function verifySessie(token) {
  if (!token) return null;
  const r = await sbFetch(`gebruikers?select=id,naam,email,rol&actieve_sessie=eq.${encodeURIComponent(token)}&limit=1`);
  if (!r.ok || !r.body?.length) return null;
  return r.body[0];
}

// ── Storage: upload signed URL genereren ─────────────────────────────────────

async function getUploadUrl(path) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${path}`,
    {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ upsert: false }),
    }
  );
  const data = await res.json();
  return { ok: res.ok, data };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

  const { action, token } = body;

  // Sessie verifiëren
  const gebruiker = await verifySessie(token);
  if (!gebruiker) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Niet ingelogd' }) };
  }

  // ── Zaken ophalen ────────────────────────────────────────────────────────────
  if (action === 'laad_zaken') {
    const r = await sbFetch(
      `wwft_zaken?makelaar_email=eq.${encodeURIComponent(gebruiker.email)}&status=neq.afgerond&order=aangemaakt_op.desc&select=id,object_adres,bron,aangemaakt_op,ondertekend_op,otd_aanwezig,wwft_uitgevoerd,wwft_bewijs_urls,op_slot,factuur_id,status`
    );
    if (!r.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Database fout' }) };
    return { statusCode: 200, headers, body: JSON.stringify({ zaken: r.body || [] }) };
  }

  // ── Vinkje wwft_uitgevoerd zetten ────────────────────────────────────────────
  if (action === 'zet_vinkje') {
    const { zaak_id, waarde } = body;
    if (!zaak_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'zaak_id vereist' }) };

    // Controleer of zaak van deze makelaar is en niet op slot
    const check = await sbFetch(
      `wwft_zaken?id=eq.${zaak_id}&makelaar_email=eq.${encodeURIComponent(gebruiker.email)}&select=id,op_slot`
    );
    if (!check.ok || !check.body?.length) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Zaak niet gevonden of geen toegang' }) };
    }
    if (check.body[0].op_slot) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Zaak op slot — factuur is ontvangen' }) };
    }

    const upd = await sbFetch(`wwft_zaken?id=eq.${zaak_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ wwft_uitgevoerd: !!waarde, bijgewerkt_op: new Date().toISOString() }),
    });
    if (!upd.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Update mislukt' }) };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // ── Upload signed URL aanvragen ───────────────────────────────────────────────
  if (action === 'upload_url') {
    const { zaak_id, bestandsnaam } = body;
    if (!zaak_id || !bestandsnaam) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'zaak_id en bestandsnaam vereist' }) };
    }

    // Controleer eigenaarschap + niet op slot
    const check = await sbFetch(
      `wwft_zaken?id=eq.${zaak_id}&makelaar_email=eq.${encodeURIComponent(gebruiker.email)}&select=id,op_slot`
    );
    if (!check.ok || !check.body?.length) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Zaak niet gevonden of geen toegang' }) };
    }
    if (check.body[0].op_slot) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Zaak op slot' }) };
    }

    // Sanitize bestandsnaam
    const veilig = bestandsnaam.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const pad = `${gebruiker.email}/${zaak_id}/${Date.now()}_${veilig}`;

    const { ok, data } = await getUploadUrl(pad);
    if (!ok) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Upload URL mislukt', detail: data }) };

    return { statusCode: 200, headers, body: JSON.stringify({ upload_url: data.url, pad }) };
  }

  // ── Bewijs URL opslaan na succesvolle upload ──────────────────────────────────
  if (action === 'sla_bewijs_op') {
    const { zaak_id, pad } = body;
    if (!zaak_id || !pad) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'zaak_id en pad vereist' }) };
    }

    // Haal huidige bewijs_urls op
    const huidig = await sbFetch(
      `wwft_zaken?id=eq.${zaak_id}&makelaar_email=eq.${encodeURIComponent(gebruiker.email)}&select=id,wwft_bewijs_urls,op_slot`
    );
    if (!huidig.ok || !huidig.body?.length) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Zaak niet gevonden' }) };
    }
    if (huidig.body[0].op_slot) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Zaak op slot' }) };
    }

    const bestaand = huidig.body[0].wwft_bewijs_urls || [];
    const nieuweUrls = [...bestaand, pad];

    const upd = await sbFetch(`wwft_zaken?id=eq.${zaak_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ wwft_bewijs_urls: nieuweUrls, bijgewerkt_op: new Date().toISOString() }),
    });
    if (!upd.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Opslaan mislukt' }) };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, urls: nieuweUrls }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Onbekende actie' }) };
}
