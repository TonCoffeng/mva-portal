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
const MELDER_REPLY_TO = 'toncoffeng@makelaarsvan.nl'; // replies van melders komen (voorlopig) hier binnen
// Zodra MELDPUNT_REPLY_DOMAIN is gezet (bv. 'reply.makelaarsvan.nl'), gaan replies
// via Resend Inbound naar het Meldpunt (reply+<id>@domein) i.p.v. de mailbox hierboven.
const MELDPUNT_REPLY_DOMAIN = process.env.MELDPUNT_REPLY_DOMAIN || '';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const SYSTEM_PROMPT = `Je bent het "MvA Meldpunt" — een vriendelijke assistent van Makelaars van Amsterdam waar makelaars en collega's bugs en tips kwijt kunnen over het interne platform (MvA Intelligence).

Het platform bestaat o.a. uit: de Leadpool (bezichtigingen, bellijst, leads doorgeven), WWFT/Finance, OTD (opdracht tot dienstverlening), het Portal, dashboards en het beloningssysteem.

Jouw taak is verzamelen en scherp krijgen — NIET zelf oplossen. Je past zelf niets aan en belooft geen reparaties; je zegt dat Ton en het team ernaar kijken.

Onderaan vind je twee naslagdelen: "Hoe het platform in elkaar zit" (gebruik dit om vragen te beantwoorden en de juiste app te herkennen) en "Recent al gemeld" (gebruik dit om te zien of iets al bekend is). Als iets al gemeld is, zeg dat dan vriendelijk en noem de status, en vraag of de gebruiker er nog iets aan toe te voegen heeft. Verzin nooit feiten die niet in deze naslag staan; weet je iets niet, zeg dat dan eerlijk.

Werkwijze:
- Schrijf in het Nederlands, warm en beknopt. Stel hooguit ÉÉN vraag per bericht.
- De gebruiker kan screenshots of documenten meesturen. Je ziet die zelf niet, maar als er in een bericht "[Bijlage toegevoegd: ...]" staat, bevestig dat dan kort ("Top, ik heb je screenshot erbij") en gebruik het als signaal dat de melding compleet genoeg wordt.
- Bepaal of het gaat om een BUG (iets werkt niet zoals het hoort), een TIP/idee (een verbetering), of een VRAAG.
- Bij een BUG vraag je gericht door tot je dit helder hebt: welke app/welk scherm, wat deed de gebruiker, wat ging er mis, wat verwachtte hij, sinds wanneer / hoe vaak. Schat daarna de prioriteit (laag/midden/hoog).
- Bij een TIP vraag je door: welk probleem lost het op, voor wie, en hoe ziet de gebruiker het voor zich. Houd het kort.
- Bij een VRAAG: gebruik de platformkennis hieronder om kort en concreet te antwoorden als je het zeker weet. Weet je het niet zeker, noteer het dan als vraag voor Ton (en verzin niets).
- Meestal heb je na 2 tot 4 berichten genoeg. Vat dan kort samen in gewone taal en rond af.

Afsluiten: zodra je genoeg informatie hebt, eindig je bericht met een korte, vriendelijke samenvatting voor de gebruiker, en zet je op een NIEUWE regel exact dit blok (en niets erna):
\`\`\`meldpunt-json
{"klaar":true,"type":"bug","titel":"korte titel","samenvatting":"1 tot 3 zinnen in gewone taal","details":"reproductiestappen of context","app":"welke app/onderdeel","prioriteit":"midden"}
\`\`\`
Gebruik voor "type" exact één van: bug, tip, vraag. Voor "prioriteit": laag, midden of hoog. Zolang je nog niet genoeg weet, voeg je GEEN blok toe en stel je gewoon je volgende vraag. Noem het blok of JSON nooit hardop tegen de gebruiker.`;

const PLATFORM_OVERZICHT = `MvA Intelligence is het interne platform van Makelaars van Amsterdam. Het is opgebouwd uit losse apps die samen één geheel vormen, met één centrale inlog.

Apps:
- Portal (portal.makelaarsvan.nl): de startpagina met tegels naar alle apps. Wat je ziet hangt af van je rol. Hier log je in; die inlog geldt meteen voor alle apps.
- Leadpool (leadpool.makelaarsvan.nl): het hart voor leads en bezichtigingen.
  - Bezichtigingen komen automatisch binnen vanuit Realworks (het CRM) en verversen elke 10 minuten.
  - Na een bezichtiging kan een makelaar een lead "doorgeven" aan de pool; collega's kunnen die pool-leads bellen. Verdeling gaat via een roterend (round-robin) schema.
  - Een bezichtiging kan de status "pool" hebben (doorgegeven), "geannuleerd" (in Realworks afgezegd, maar blijft zichtbaar) of gearchiveerd zijn.
  - Bellijst: leads bellen en een belstatus bijhouden (nieuw, bereikt, bel terug, afspraak, deal, enz.).
  - Beloningen: een makelaar krijgt €175 voor een doorgegeven lead die tot iets leidt, en €650 voor een hypotheekverwijzing. "Mijn beloningen" op de portal toont het tegoed.
- WWFT / Finance (finance.makelaarsvan.nl): compliance (WWFT-dossiers) en facturen. Directie en compliance (Monique) bewerken; een makelaar ziet zijn eigen dossiers alleen-lezen.
- OTD (opdracht tot dienstverlening): de overeenkomst met een klant opstellen, met productkeuze en digitale ondertekening. Vervangt de oude Effytool.
- Dashboards: cijfers en overzichten voor directie.
- Meldpunt (deze tool): bugs en tips melden.

Onderliggende techniek (op hoofdlijnen):
- Supabase = de database én de inlog (accounts en rollen).
- Netlify = waar de apps draaien (hosting); kleine achtergrondtaken draaien als "functions".
- Een aparte server ververst elke 10 minuten de bezichtigingen vanuit Realworks.
- Realworks = het makelaars-CRM (bron van bezichtigingen en relaties). Cloze = relatiebeheer. Resend = uitgaande e-mail. Signhost = digitaal ondertekenen.

Rollen: directie, makelaar, makelaar-mentor, compliance en extern. De portal toont per rol andere tegels.

Bekende, opgeloste kwestie: eerder verdwenen sommige bezichtigingen naar het archief door de 10-minuten-synchronisatie; dat is herkend en hersteld, en er staat nu een logboek op zodat het te volgen is.`;

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

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige aanvraag' }) };
  }

  // ── Beheer-acties (overzicht-tab): lijst / detail / update ─────────
  // Deze route heeft geen Claude nodig en draait dus vóór de API-check.
  if (body.action) {
    try {
      return await beheerActie(body, gebruiker);
    } catch (e) {
      console.error('[meldpunt] beheer-fout:', e.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Er ging iets mis. Probeer het zo nog eens.' }) };
    }
  }

  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Meldpunt is nog niet geconfigureerd (API-key ontbreekt).' }) };
  }

  let messages, bijlagenIn = [];
  messages = Array.isArray(body.messages) ? body.messages : [];
  bijlagenIn = Array.isArray(body.bijlagen) ? body.bijlagen : [];
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

  // Recente meldingen erbij zodat Claude dubbels herkent en de status kan noemen.
  const recent = await recenteMeldingen();
  const systeemprompt =
    SYSTEM_PROMPT +
    '\n\n## Hoe het platform in elkaar zit\n' + PLATFORM_OVERZICHT +
    '\n\n## Recent al gemeld (nieuwste eerst)\n' + (recent || 'Nog niets eerder gemeld.');

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
        system: systeemprompt,
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

// ── Beheer-acties voor het Meldingen-overzicht ───────────────────
// directie: ziet en beheert alles. Overige rollen: zien alleen hun
// eigen meldingen, alleen-lezen. Statusflow: nieuw → in_behandeling →
// afgerond/afgewezen. Bij afgerond/afgewezen gaat er één keer een mail
// naar de melder (melder_gemaild_op voorkomt dubbele mails).
const STATUSSEN = ['nieuw', 'in_behandeling', 'afgerond', 'afgewezen'];

const beheerOk  = (data) => ({ statusCode: 200, headers, body: JSON.stringify(data) });
const beheerErr = (code, msg) => ({ statusCode: code, headers, body: JSON.stringify({ error: msg }) });

async function beheerActie(body, gebruiker) {
  const isDirectie = gebruiker.rol === 'directie';

  if (body.action === 'lijst') {
    const filter = isDirectie ? '' : `&gebruiker_id=eq.${gebruiker.id}`;
    const rows = await sbSelect(
      `meldingen?select=id,gebruiker_id,gebruiker_naam,type,titel,samenvatting,app,prioriteit,status,` +
      `aangemaakt_op,bijgewerkt_op,afgehandeld_door,directie_notitie,melder_gemaild_op` +
      `&order=aangemaakt_op.desc&limit=200${filter}`
    );
    return beheerOk({
      ik: { id: gebruiker.id, naam: gebruiker.naam, rol: gebruiker.rol, directie: isDirectie },
      meldingen: rows,
    });
  }

  if (body.action === 'detail') {
    const id = parseInt(body.id);
    if (!id) return beheerErr(400, 'Geen geldige melding-id');
    const rows = await sbSelect(`meldingen?select=*&id=eq.${id}&limit=1`);
    const m = rows[0];
    if (!m) return beheerErr(404, 'Melding niet gevonden');
    if (!isDirectie && Number(m.gebruiker_id) !== Number(gebruiker.id)) {
      return beheerErr(403, 'Geen toegang tot deze melding');
    }
    // Bijlagen: verse tijdelijke downloadlinks
    const bijlagen = [];
    for (const b of (Array.isArray(m.bijlagen) ? m.bijlagen : [])) {
      const url = await signedUrl(b.pad).catch(() => null);
      bijlagen.push({ naam: b.naam || 'bestand', type: b.type || '', url });
    }
    // Signeer ook de bijlagen in de berichten-thread
    const correspondentie = [];
    for (const c of (Array.isArray(m.correspondentie) ? m.correspondentie : [])) {
      const cb = [];
      for (const b of (Array.isArray(c.bijlagen) ? c.bijlagen : [])) {
        const url = await signedUrl(b.pad).catch(() => null);
        cb.push({ naam: b.naam || 'bestand', type: b.type || '', url });
      }
      correspondentie.push({ ...c, bijlagen: cb });
    }
    return beheerOk({ melding: { ...m, bijlagen, correspondentie } });
  }

  if (body.action === 'update') {
    if (!isDirectie) return beheerErr(403, 'Alleen directie kan meldingen bijwerken');
    const id = parseInt(body.id);
    if (!id) return beheerErr(400, 'Geen geldige melding-id');
    const rows = await sbSelect(
      `meldingen?select=id,gebruiker_id,gebruiker_naam,type,titel,status,directie_notitie,melder_gemaild_op&id=eq.${id}&limit=1`
    );
    const m = rows[0];
    if (!m) return beheerErr(404, 'Melding niet gevonden');

    const patch = { bijgewerkt_op: new Date().toISOString() };
    if (body.status && STATUSSEN.includes(body.status)) patch.status = body.status;
    if (typeof body.directie_notitie === 'string') patch.directie_notitie = body.directie_notitie.slice(0, 4000);
    if (patch.status && patch.status !== 'nieuw') patch.afgehandeld_door = gebruiker.naam;
    if (patch.status === 'nieuw') patch.afgehandeld_door = null;
    // Heropenen (terug naar nieuw/in_behandeling) reset de mail-blokkade:
    // wordt de melding daarna opnieuw afgerond, dan krijgt de melder
    // gewoon weer een afrondingsmail (bv. klacht kwam terug).
    if (patch.status === 'nieuw' || patch.status === 'in_behandeling') patch.melder_gemaild_op = null;

    await sbPatchRow(`meldingen?id=eq.${id}`, patch);

    // Mail naar de melder bij afronden/afwijzen — precies één keer
    let gemaild = false;
    const eindstatus = patch.status === 'afgerond' || patch.status === 'afgewezen';
    if (eindstatus && !m.melder_gemaild_op && RESEND_KEY) {
      try {
        const melderRows = await sbSelect(`gebruikers?select=naam,email&id=eq.${m.gebruiker_id}&limit=1`);
        const melder = melderRows[0];
        if (melder && melder.email) {
          await mailNaarMelder({
            melder,
            titel:    m.titel || 'je melding',
            type:     m.type,
            status:   patch.status,
            notitie:  patch.directie_notitie !== undefined ? patch.directie_notitie : (m.directie_notitie || ''),
            meldingId: id,
          });
          await sbPatchRow(`meldingen?id=eq.${id}`, { melder_gemaild_op: new Date().toISOString() });
          gemaild = true;
        }
      } catch (e) {
        console.warn('[meldpunt] melder-mail mislukt:', e.message);
      }
    }
    return beheerOk({ ok: true, gemaild });
  }

  if (body.action === 'bericht') {
    if (!isDirectie) return beheerErr(403, 'Alleen directie kan een bericht sturen');
    const id = parseInt(body.id);
    if (!id) return beheerErr(400, 'Geen geldige melding-id');
    const tekst = (typeof body.tekst === 'string' ? body.tekst : '').trim().slice(0, 4000);
    const bijlagenIn = (Array.isArray(body.bijlagen) ? body.bijlagen : [])
      .filter((b) => b && typeof b.pad === 'string')
      .slice(0, 5)
      .map((b) => ({ naam: String(b.naam || 'bestand').slice(0, 120), pad: b.pad, type: String(b.type || '') }));
    if (!tekst && bijlagenIn.length === 0) return beheerErr(400, 'Leeg bericht');

    const rows = await sbSelect(
      `meldingen?select=id,gebruiker_id,type,titel,status,correspondentie&id=eq.${id}&limit=1`
    );
    const m = rows[0];
    if (!m) return beheerErr(404, 'Melding niet gevonden');

    // Bericht loggen in de thread
    const eerdere = Array.isArray(m.correspondentie) ? m.correspondentie : [];
    const nieuw = { van: 'directie', naam: gebruiker.naam || 'Directie', tekst, op: new Date().toISOString(), bijlagen: bijlagenIn };
    const patch = {
      correspondentie: [...eerdere, nieuw],
      bijgewerkt_op: new Date().toISOString(),
    };
    // Een bericht sturen betekent: de melding is in behandeling.
    // Status blijft verder ongemoeid; melder_gemaild_op (afrond-blokkade) raken we niet aan.
    if (m.status === 'nieuw') { patch.status = 'in_behandeling'; patch.afgehandeld_door = gebruiker.naam; }
    await sbPatchRow(`meldingen?id=eq.${id}`, patch);

    // Direct mailen naar de melder (los van afronding)
    let gemaild = false;
    if (RESEND_KEY) {
      try {
        const melderRows = await sbSelect(`gebruikers?select=naam,email&id=eq.${m.gebruiker_id}&limit=1`);
        const melder = melderRows[0];
        if (melder && melder.email) {
          await mailBerichtAanMelder({ melder, titel: m.titel || 'je melding', type: m.type, tekst, meldingId: id, bijlagen: bijlagenIn });
          gemaild = true;
        }
      } catch (e) {
        console.warn('[meldpunt] bericht-mail mislukt:', e.message);
      }
    }
    return beheerOk({ ok: true, gemaild, bericht: nieuw, status: patch.status || m.status });
  }

  return beheerErr(400, 'Onbekende actie');
}

async function sbSelect(pad) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pad}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`select ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbPatchRow(pad, patch) {
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

// Reply-To bepalen: inbound-adres met meldingsnummer zodra het domein is gezet,
// anders de mailbox. Zo schakelt de hele flow met één env-var om.
function replyToVoor(id) {
  return MELDPUNT_REPLY_DOMAIN ? `reply+${id}@${MELDPUNT_REPLY_DOMAIN}` : MELDER_REPLY_TO;
}

// Nette afrondingsmail naar de melder (huisstijl, één keer per melding).
async function mailNaarMelder({ melder, titel, type, status, notitie, meldingId }) {
  const labels = { bug: 'bug', tip: 'tip', vraag: 'vraag', anders: 'melding' };
  const soort = labels[type] || 'melding';
  const afgerond = status === 'afgerond';
  const onderwerp = afgerond
    ? `[Meldpunt] Je ${soort} is opgepakt: ${titel}`
    : `[Meldpunt] Update over je ${soort}: ${titel}`;
  const kop = afgerond ? 'Je melding is opgepakt \u2713' : 'Update over je melding';
  const intro = afgerond
    ? `Goed nieuws: je ${soort} <b>"${escapeHtml(titel)}"</b> is opgepakt en afgerond.`
    : `Je ${soort} <b>"${escapeHtml(titel)}"</b> is bekeken, maar wordt op dit moment niet opgepakt.`;
  const html = `
    <div style="font-family:Arial,sans-serif;color:#2A2A2A;max-width:560px">
      <h2 style="color:#1A2B5F;margin-bottom:4px">${kop}</h2>
      <p>Hoi ${escapeHtml(melder.naam || '')},</p>
      <p>${intro}</p>
      ${notitie ? `<p style="color:#444;background:#F6F4EF;border-radius:8px;padding:12px"><b>Toelichting:</b><br>${escapeHtml(notitie).replace(/\n/g, '<br>')}</p>` : ''}
      <p style="color:#6B6B6B">De volledige status van al je meldingen vind je in het Meldpunt op het portal, tab "Meldingen".</p>
      <hr style="border:none;border-top:1px solid #E7E3DB">
      <p style="font-size:12px;color:#9A9A9A">MvA Meldpunt &middot; bedankt voor het meedenken!</p>
    </div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_VAN, to: melder.email, reply_to: replyToVoor(meldingId), subject: onderwerp, html }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
}

// Tussentijds bericht aan de melder (tijdens behandeling, los van afronding).
async function mailBerichtAanMelder({ melder, titel, type, tekst, meldingId, bijlagen }) {
  const labels = { bug: 'bug', tip: 'tip', vraag: 'vraag', anders: 'melding' };
  const soort = labels[type] || 'melding';
  const onderwerp = `[Meldpunt] Bericht over je ${soort}: ${titel}`;

  // Bijlagen: gesignde URL's; Resend haalt ze op bij verzending.
  const attachments = [];
  for (const b of (Array.isArray(bijlagen) ? bijlagen : [])) {
    const url = await signedUrl(b.pad).catch(() => null);
    if (url) attachments.push({ filename: b.naam || 'bijlage', path: url });
  }
  const tekstHtml = tekst
    ? `<p style="color:#444;background:#F6F4EF;border-radius:8px;padding:12px">${escapeHtml(tekst).replace(/\n/g, '<br>')}</p>`
    : '';
  const bijlHtml = attachments.length
    ? `<p style="color:#6B6B6B">\u{1F4CE} Bijlage(n): ${attachments.map((a) => escapeHtml(a.filename)).join(', ')}</p>`
    : '';
  const html = `
    <div style="font-family:Arial,sans-serif;color:#2A2A2A;max-width:560px">
      <h2 style="color:#1A2B5F;margin-bottom:4px">Bericht over je melding</h2>
      <p>Hoi ${escapeHtml(melder.naam || '')},</p>
      <p>Over je ${soort} <b>"${escapeHtml(titel)}"</b> hebben we het volgende:</p>
      ${tekstHtml}
      ${bijlHtml}
      <p style="color:#6B6B6B">Je vindt dit bericht ook terug in het Meldpunt op het portal, tab "Meldingen".</p>
      <hr style="border:none;border-top:1px solid #E7E3DB">
      <p style="font-size:12px;color:#9A9A9A">MvA Meldpunt &middot; we houden je op de hoogte.</p>
    </div>`;
  const payload = { from: MAIL_VAN, to: melder.email, reply_to: replyToVoor(meldingId), subject: onderwerp, html };
  if (attachments.length) payload.attachments = attachments;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
}

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

// Compacte lijst van recente meldingen voor Claude (dubbel-herkenning + status).
async function recenteMeldingen() {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/meldingen?select=type,titel,status,prioriteit,aangemaakt_op&order=aangemaakt_op.desc&limit=30`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    if (!r.ok) return '';
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return '';
    return rows
      .map((m) => {
        const d = (m.aangemaakt_op || '').slice(0, 10);
        return `- [${m.type}] ${m.titel || 'zonder titel'} \u2014 status: ${m.status}, prioriteit: ${m.prioriteit} (${d})`;
      })
      .join('\n');
  } catch {
    return '';
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
