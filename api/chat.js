// api/chat.js — Vercel Serverless Function
// Practical, non-code-first answers with readable formatting.
// Output uses clear section headers and line breaks.
// Includes basic guards (rate limit, size, timeout).

let hits = new Map();
const WINDOW_MS = 60_000;
const MAX_REQ_PER_WINDOW = 20;
const MAX_INPUT_CHARS = 700;
const REPLY_MAX_TOKENS = 650;
const TIMEOUT_MS = 20_000;

// ---- Formatting-first system prompt ----
const SYSTEM = `
You are DadKnowsAI — a calm, practical helper for adults 45+.
Give non-technical, real-world steps that work on common devices/apps.
Use code only if a non-code path is impractical.

FORMAT (follow exactly; use line breaks liberally):

What to do:
1. Step one…
2. Step two…
3. Step three…

Tips & gotchas:
- Tip one…
- Tip two…

Sources:
- Name reputable sources or give exact search phrases. Do NOT invent URLs.
- Example: Owner’s manual (Search: "2008 Dodge Ram owner's manual PDF Mopar").

Disclaimer:
I’m not perfect, and models can miss details. Based on what I can gather, here’s the safe approach.

Close with:
Want a more detailed, step-by-step walkthrough tailored to your exact model/app?

STYLE:
- No "Summary:" section.
- Plain English; minimal jargon; define acronyms once if needed.
- Only ask clarifying questions if essential; otherwise infer likely intent and proceed.
- Avoid medical/legal/financial advice; suggest safer alternatives when relevant.
`;

const FEW_SHOTS = [
  {
    role: "user",
    content: "My inbox is overwhelming. What’s a simple routine to keep it under control?"
  },
  {
    role: "assistant",
    content:
`What to do:
1. Gmail > Settings (gear) > See all settings > Filters > Create new filter > In "From" add noreply@, promotions@ → Create filter → Skip Inbox + Apply label "Later".
2. In the search bar type: older_than:6m is:unread → Select all → Archive (you can still search them later).
3. Each morning: open Gmail and search is:unread, triage the top ~20 only.
4. For newsletters you actually read: open one → More (⋮) → Filter messages like these → label "Read Weekend" + Skip Inbox.
5. Star only items you must act on today; unstar when done.

Tips & gotchas:
- Filters affect new mail; use search to clean up old mail in batches.
- Outlook: Rules > New Rule > move messages with "Unsubscribe" to "Later".
- Check "Later" and "Read Weekend" weekly so you don’t miss anything.

Sources:
- Gmail Help — Filters and blocked addresses (Search: "Gmail create filter help").
- Microsoft Outlook Rules (Search: "Outlook create rule move messages").

Disclaimer:
I’m not perfect, and models can miss details. Based on what I can gather, here’s the safe approach.

Want a more detailed, step-by-step walkthrough tailored to your mail app?`
  }
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const { message } = req.body || {};
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Missing message" });
    }
    if (message.length > MAX_INPUT_CHARS) {
      return res.status(413).json({ error: `Message too long (max ${MAX_INPUT_CHARS} chars).` });
    }

    // Naive per-IP rate limit (per instance)
    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";
    const now = Date.now();
    const rec = hits.get(ip) || { count: 0, windowStart: now };
    if (now - rec.windowStart > WINDOW_MS) {
      rec.count = 0; rec.windowStart = now;
    }
    rec.count += 1; hits.set(ip, rec);
    if (rec.count > MAX_REQ_PER_WINDOW) {
      const retry = Math.max(0, WINDOW_MS - (now - rec.windowStart));
      res.setHeader("Retry-After", Math.ceil(retry / 1000));
      return res.status(429).json({ error: "Too many requests. Try again shortly." });
    }

    // Timeout controller
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const messages = [
      { role: "system", content: SYSTEM },
      ...FEW_SHOTS,
      { role: "user", content: message }
    ];

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.5,
        max_tokens: REPLY_MAX_TOKENS,
        presence_penalty: 0.0,
        frequency_penalty: 0.1,
        messages
      }),
      signal: controller.signal
    }).catch((e) => {
      if (e.name === "AbortError") return { ok: false, aborted: true };
      throw e;
    });

    clearTimeout(tid);

    if (!r || !r.ok) {
      if (r?.aborted) return res.status(504).json({ error: "Upstream timeout." });
      const data = await r.json().catch(() => ({}));
      return res.status(502).json({ error: data?.error?.message || "Upstream error." });
    }

    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content?.trim() ?? "";
    return res.status(200).json({ reply: text });
  } catch {
    return res.status(500).json({ error: "Server error." });
  }
}



