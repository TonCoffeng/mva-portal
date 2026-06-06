// netlify/functions/claude.mjs
// Server-side koppeling met de Claude API. De API-key (ANTHROPIC_API_KEY)
// blijft op de server en komt nooit in de browser terecht.
//
// Aanroepen vanuit de frontend:
//   const res = await fetch("/.netlify/functions/claude", {
//     method: "POST",
//     headers: { "content-type": "application/json" },
//     body: JSON.stringify({ prompt: "Hallo Claude" })
//   });
//   const data = await res.json();   // -> { text: "..." }

export default async (req) => {
  // Alleen POST toestaan
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: "ANTHROPIC_API_KEY ontbreekt op de server" }, 500);
  }

  // Request-body lezen
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Ongeldige JSON in request" }, 400);
  }

  const {
    prompt,
    messages,
    model = "claude-sonnet-4-6",
    max_tokens = 1024,
    system,
  } = body || {};

  // Of een kant-en-klare messages-array, of een losse prompt
  const finalMessages =
    Array.isArray(messages) && messages.length > 0
      ? messages
      : [{ role: "user", content: String(prompt ?? "") }];

  if (!finalMessages[0] || !finalMessages[0].content) {
    return json({ error: "Geen prompt of messages meegegeven" }, 400);
  }

  // Anthropic API aanroepen
  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens,
        ...(system ? { system } : {}),
        messages: finalMessages,
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return json(
        { error: (data && data.error && data.error.message) || "Anthropic API-fout", detail: data },
        upstream.status
      );
    }

    // Tekst uit het antwoord halen
    const text = Array.isArray(data.content)
      ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : "";

    return json({ text, raw: data }, 200);
  } catch (err) {
    return json({ error: "Serverfout bij aanroepen Anthropic", detail: String(err) }, 500);
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
