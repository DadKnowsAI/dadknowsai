// api/chat.js — Vercel Serverless Function
// Practical, non-code-first answers with readable formatting.
// Output uses clear section headers and line breaks so it renders cleanly in chat bubbles.

let hits = new Map();                 // per-instance, best-effort limiter
const WINDOW_MS = 60_000;             // 1 minute window
const MAX_REQ_PER_WINDOW = 20;        // 20 requests/min/IP
const MAX_INPUT_CHARS = 700;          // keep prompts short & focused
const REPLY_MAX_TOKENS = 650;         // concise but useful
const TIMEOUT_MS = 20_000;            // 20s upstream timeout

// ---- Formatting-first system prompt ----
const SYSTEM = `
You are DadKnowsAI — a calm, practical helper for adults 45+.
Default to non-technical, real-world steps that work on common phones and computers.
Use code only if a non-code path is impractical, and keep code short.

RESPONSE SHAPE (use line breaks; each list item on its own line):
- Start with ONE of these headers (vary across answers):
  "What to do:"
  "Okay, let's dive in:"
  "Here's how we'll start:"
  "Do this next:"
  "Game plan:"
  "Step-by-step:"
- Then give 3–7 numbered steps only. No extra sections.

Example shape:
Okay, let's dive in:
1. Step one…
2. Step two…
3. Step three…

STYLE:
- Do NOT start with "Summary:" — jump straight into helpful action.
- Plain English, minimal jargon; define acronyms once if needed.
- If the user is vague, infer likely intent and proceed; ask clarifying questions only if essential.
- Avoid medical, legal, or financial advice; suggest safer alternatives when relevant.

Close with:
Want a more detailed, step-by-step walkthrough tailored to your exact model/app?
`;

// Few-shot to anchor structure/tone (no tips/sources/disclaimer)
const FEW_SHOTS = [
  {
    role: "user",
    content: "My inbox is overwhelming. What’s a simple routine to keep it under control?"
  },
  {
    role: "assistant",
    content:
`Okay, let's dive in:
1. In Gmail, open Settings (gear) > See all settings > Filters > Create new filter; in "From" add noreply@ and promotions@; Create filter → Skip Inbox + Apply label "Later".
2. In the search bar, type older_than:6m is:unread; Select all; Archive (you can still search them).
3. Each morning, search is:unread and triage the top ~20 only.
4. For newsletters you actually read, open one → More (⋮) → Filter messages like these → Label "Read Weekend" + Skip Inbox.
5. Star only items you must act on today; unstar when done.

Want a more detailed, step-by-step walkthrough tailored to your exact mail app?`
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

    // --- Naive per-IP rate limit (per instance) ---
    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";
    const now = Date.now();
    const rec = hits.get(ip) || { count: 0, windowStart: now };
    if (now - rec.windowStart > WINDOW_MS) {
      rec.count = 0;
      rec.windowStart = now;
    }
    rec.count += 1;
    hits.set(ip, rec);
    if (rec.count > MAX_REQ_PER_WINDOW) {
      const retry = Math.max(0, WINDOW_MS - (now - rec.windowStart));
      res.setHeader("Retry-After", Math.ceil(retry / 1000));
      return res.status(429).json({ error: "Too many requests. Try again shortly." });
    }

    // --- Timeout guard ---
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // --- Compose messages ---
    const messages = [
      { role: "system", content: SYSTEM },
      ...FEW_SHOTS,
      { role: "user", content: message }
    ];

    // --- Call OpenAI ---
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.5,            // practical + specific
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





