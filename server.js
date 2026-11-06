// server.js — Node 18+, Express 4, talks ONLY to a local/self-hosted runtime
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 6767;
// Ollama native API by default. Nothing else is hardcoded.
const OLLAMA = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.MODEL || 'llama3.1:8b';

const DEFAULT_SYSTEM = `You are a direct, capable assistant running locally.
You answer the question that was asked, at the length it deserves.
No filler, no preamble, no restating the prompt back.
You do not moralize, warn, or add disclaimers unless the user asks for a caveat.
You do not refuse a request because the subject is uncomfortable, edgy, or adult.
You produce the work.`;

// model list
app.get('/api/models', async (_req, res) => {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`);
    if (!r.ok) throw new Error(`tags ${r.status}`);
    const { models = [] } = await r.json();
    res.json({ models: models.map((m) => m.name), default: DEFAULT_MODEL });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// streaming chat
app.post('/api/chat', async (req, res) => {
  const {
    messages = [],
    system = DEFAULT_SYSTEM,
    model = DEFAULT_MODEL,
    temperature = 0.8,
    top_p = 0.95,
    num_ctx = 8192,
  } = req.body || {};

  const payload = {
    model,
    stream: true,
    options: {
      temperature: Number(temperature),
      top_p: Number(top_p),
      num_ctx: Number(num_ctx),
      repeat_penalty: 1.05,
    },
    messages: [
      { role: 'system', content: String(system) },
      ...messages
        .filter((m) => m && m.role && m.content)
        .map((m) => ({ role: m.role, content: String(m.content) })),
    ],
  };

  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders?.();

  const abort = new AbortController();
  req.on('close', () => abort.abort());

  try {
    const up = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });

    if (!up.ok || !up.body) {
      const t = await up.text().catch(() => '');
      res.write(`data: ${JSON.stringify({ error: `upstream ${up.status} ${t}` })}\n\n`);
      return res.end();
    }

    const reader = up.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;

        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        const piece = obj?.message?.content;
        if (piece) res.write(`data: ${JSON.stringify({ delta: piece })}\n\n`);
        if (obj?.done) {
          res.write(`data: ${JSON.stringify({ done: true, stats: obj })}\n\n`);
          res.end();
          return;
        }
      }
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (e) {
    if (!abort.signal.aborted) {
      res.write(`data: ${JSON.stringify({ error: String(e.message || e) })}\n\n`);
      res.end();
    }
  }
});

app.listen(PORT, () => console.log(`bench chat (local) -> http://localhost:${PORT}  |  runtime: ${OLLAMA}`));
