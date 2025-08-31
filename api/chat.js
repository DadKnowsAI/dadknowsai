// api/chat.js  — Vercel Serverless Function
// Guards included: method check, input size check, naive IP rate limit, timeout, token cap.
// NOTE: This uses an in-memory map for throttling. It's "best effort" on serverless.
// For stronger limits later, use Upstash Ratelimit (I can wire that next).

let hits = new Map(); // { ip: { count, windowStart } }
const WINDOW_MS = 60_000;      // 1 minute window
const MAX_REQ_PER_WINDOW = 20; // 20 requests / min per IP (adjust to taste)
const MAX_INPUT_CHARS = 500;   // reject very long prompts
const REPLY_MAX_TOKENS = 400;  // cap response size
const TIMEOUT_MS = 20_000;     // upstream timeout

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST' });
  }

  try {
    // Parse body
    const { message } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Missing message' });
    }
    if (message.length > MAX_INPUT_CHARS) {
      return res.status(413).json({ error: `Message too long (max ${MAX_INPUT_CHARS} chars).` });
    }

    // Basic abuse guard (very naive)
    const banned = /(?:hate\s*speech|bomb|kill|credit\s*card|ssn|password)/i;
    if (banned.test(message)) {
      return res.status(400).json({ error: 'Content not allowed.' });
    }

    // Naive per-IP rate limit (best effort)
    const ip =
      req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      'unknown';

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
      res.setHeader('Retry-After', Math.ceil(retry / 1000));
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }

    // Call OpenAI with timeout
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.5,
        max_tokens: REPLY_MAX_TOKENS,
        messages: [
          {
            role: 'system',
            content:
              'You are a warm, practical helper for everyday people. Be concise (2–5 sentences), plain English, no hype.'
          },
          { role: 'user', content: message }
        ]
      }),
      signal: controller.signal
    }).catch((e) => {
      if (e.name === 'AbortError') return { ok: false, aborted: true };
      throw e;
    });

    clearTimeout(tid);

    if (!r || !r.ok) {
      if (r?.aborted) return res.status(504).json({ error: 'Upstream timeout.' });
      const data = await r.json().catch(() => ({}));
      return res.status(502).json({ error: data?.error?.message || 'Upstream error.' });
    }

    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content?.trim() ?? '';
    return res.status(200).json({ reply: text });
  } catch (e) {
    return res.status(500).json({ error: 'Server error.' });
  }
}
