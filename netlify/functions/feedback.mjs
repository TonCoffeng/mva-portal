// netlify/functions/feedback.mjs
// Ontvangt een wens/verbeterpunt vanuit de portal-assistent, slaat het op in
// Supabase (tabel portal_feedback) en mailt het naar de directie via Resend.
// Geen externe dependencies: alles via fetch.

const SUPABASE_URL = process.env.SUPABASE_URL || "https://olfcrzusdkijxroxvsgm.supabase.co";
const FEEDBACK_TO = ["toncoffeng@makelaarsvan.nl"];
const MAIL_FROM = "MvA Intelligence <portal@makelaarsvan.nl>";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  if (!serviceKey) return json({ error: "SUPABASE_SERVICE_KEY ontbreekt op de server" }, 500);
  if (!resendKey) return json({ error: "RESEND_API_KEY ontbreekt op de server" }, 500);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: "Ongeldige JSON in request" }, 400); }

  const naam = (body.naam || "Onbekend").toString().slice(0, 200);
  const rol = (body.rol || "").toString().slice(0, 100);
  const email = (body.email || "").toString().slice(0, 200);
  const bericht = (body.bericht || "").toString().trim();
  const gesprek = Array.isArray(body.gesprek) ? body.gesprek : [];
  const screenshot = typeof body.screenshot === "string" ? body.screenshot : null;

  if (!bericht) return json({ error: "Leeg bericht" }, 400);

  // Screenshot (data-URL) ontleden naar base64 + extensie
  let attachment = null;
  let heeftScreenshot = false;
  if (screenshot && screenshot.indexOf("data:") === 0) {
    const m = screenshot.match(/^data:([^;]+);base64,(.+)$/);
    if (m) {
      const ext = (m[1].split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
      attachment = { filename: "screenshot." + ext, content: m[2] };
      heeftScreenshot = true;
    }
  }

  // 1) Opslaan in Supabase (service role -> bypasst RLS)
  let savedId = null;
  try {
    const r = await fetch(SUPABASE_URL + "/rest/v1/portal_feedback", {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: "Bearer " + serviceKey,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        naam: naam,
        rol: rol,
        email: email,
        bericht: bericht,
        gesprek: gesprek,
        heeft_screenshot: heeftScreenshot,
        screenshot: screenshot,
        bron: "portal-assistent",
      }),
    });
    const data = await r.json();
    if (!r.ok) return json({ error: "Opslaan in Supabase mislukt", detail: data }, 502);
    savedId = Array.isArray(data) && data[0] ? data[0].id : null;
  } catch (e) {
    return json({ error: "Supabase-fout", detail: String(e) }, 502);
  }

  // 2) Mailen via Resend (opslaan is al gelukt; mailfout mag de boel niet breken)
  try {
    const payload = {
      from: MAIL_FROM,
      to: FEEDBACK_TO,
      subject: "Portal-wens van " + naam + (rol ? " (" + rol + ")" : ""),
      html: buildHtml({ naam: naam, rol: rol, email: email, bericht: bericht, gesprek: gesprek, heeftScreenshot: heeftScreenshot, savedId: savedId }),
    };
    if (email) payload.reply_to = email;
    if (attachment) payload.attachments = [attachment];

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + resendKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const d = await r.json().catch(function () { return {}; });
      return json({ ok: true, saved: true, mailed: false, id: savedId, mailError: d }, 200);
    }
  } catch (e) {
    return json({ ok: true, saved: true, mailed: false, id: savedId, mailError: String(e) }, 200);
  }

  return json({ ok: true, saved: true, mailed: true, id: savedId }, 200);
};

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildHtml(d) {
  var rows = d.gesprek.map(function (m) {
    var who = m.role === "user" ? "Gebruiker" : "Assistent";
    var c = typeof m.content === "string" ? m.content : "";
    return '<div style="margin:6px 0"><strong>' + who + ':</strong> ' + esc(c).replace(/\n/g, "<br>") + "</div>";
  }).join("");

  return [
    '<div style="font-family:Arial,sans-serif;color:#1A2B5F;max-width:600px">',
    '<h2 style="color:#E8500A;margin-bottom:4px">Nieuwe wens / verbeterpunt</h2>',
    '<p style="margin-top:0;color:#555">Ingestuurd via de MvA-assistent op het portal.</p>',
    '<table style="font-size:14px;margin:12px 0;border-collapse:collapse">',
    '<tr><td style="padding:2px 12px 2px 0;color:#888">Van</td><td>' + esc(d.naam) + (d.rol ? " (" + esc(d.rol) + ")" : "") + "</td></tr>",
    d.email ? '<tr><td style="padding:2px 12px 2px 0;color:#888">E-mail</td><td>' + esc(d.email) + "</td></tr>" : "",
    d.heeftScreenshot ? '<tr><td style="padding:2px 12px 2px 0;color:#888">Bijlage</td><td>printscreen (zie bijlage)</td></tr>' : "",
    "</table>",
    '<div style="background:#F6F4EF;border-radius:8px;padding:14px;margin:12px 0">',
    '<div style="font-weight:bold;margin-bottom:6px">De wens</div>',
    "<div>" + esc(d.bericht).replace(/\n/g, "<br>") + "</div>",
    "</div>",
    d.gesprek.length ? '<details style="margin:12px 0"><summary style="cursor:pointer;color:#888">Volledig gesprek</summary><div style="font-size:13px;margin-top:8px">' + rows + "</div></details>" : "",
    '<p style="font-size:12px;color:#aaa">Opgeslagen in Supabase &bull; tabel portal_feedback' + (d.savedId ? " &bull; id " + d.savedId : "") + ".</p>",
    "</div>",
  ].join("");
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status, headers: { "content-type": "application/json" } });
}
