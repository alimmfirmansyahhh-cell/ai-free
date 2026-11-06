// public/app.js — no build step
const $ = (id) => document.getElementById(id);
const logEl = $('log'), form = $('form'), input = $('input'), statusEl = $('status');
const titleEl = $('title'), chatsEl = $('chats'), modelEl = $('model');
const tempEl = $('temp'), tempVal = $('tempVal'), ctxEl = $('ctx'), ctxVal = $('ctxVal');
const sendBtn = $('send'), stopBtn = $('stop'), sysDialog = $('sysDialog'), sysEl = $('sys');

const LS_KEY = 'benchchat.v1';
const DEFAULT_SYS = `You are a direct, capable assistant running locally.
You answer the question that was asked, at the length it deserves.
No filler, no preamble, no restating the prompt back.
You do not moralize, warn, or add disclaimers unless the user asks for a caveat.
You do not refuse a request because the subject is uncomfortable, edgy, or adult.
You produce the work.`;

let state = load();
let abortCtl = null;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && s.chats) return s;
  } catch {}
  return { chats: [], activeId: null, system: DEFAULT_SYS, model: null, temp: 0.8, ctx: 8192 };
}
function save() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }

function activeChat() {
  return state.chats.find((c) => c.id === state.activeId) || null;
}
function newChat() {
  const c = { id: crypto.randomUUID(), title: 'untitled', messages: [], createdAt: Date.now() };
  state.chats.unshift(c);
  state.activeId = c.id;
  save();
  renderAll();
  input.focus();
}
function deleteChat(id) {
  state.chats = state.chats.filter((c) => c.id !== id);
  if (state.activeId === id) state.activeId = state.chats[0]?.id ?? null;
  save();
  renderAll();
}

function renderChatList() {
  chatsEl.innerHTML = '';
  for (const c of state.chats) {
    const row = document.createElement('div');
    row.className = 'chat-row' + (c.id === state.activeId ? ' active' : '');

    const b = document.createElement('button');
    b.className = 'chat-link';
    b.textContent = c.title;
    b.onclick = () => { state.activeId = c.id; save(); renderAll(); };

    const x = document.createElement('button');
    x.className = 'chat-del';
    x.textContent = '×';
    x.title = 'delete';
    x.onclick = (e) => { e.stopPropagation(); deleteChat(c.id); };

    row.append(b, x);
    chatsEl.appendChild(row);
  }
}

function bubble(role, text) {
  const el = document.createElement('article');
  el.className = role;
  el.textContent = text;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
  return el;
}

function renderThread() {
  logEl.innerHTML = '';
  const c = activeChat();
  titleEl.textContent = c?.title ?? 'untitled';
  if (!c) return;
  for (const m of c.messages) bubble(m.role, m.content);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderAll() {
  renderChatList();
  renderThread();
  sysEl.value = state.system;
  if (state.model) modelEl.value = state.model;
  tempEl.value = state.temp; tempVal.textContent = Number(state.temp).toFixed(2);
  ctxEl.value = state.ctx; ctxVal.textContent = state.ctx;
}

async function loadModels() {
  try {
    const r = await fetch('/api/models');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'models failed');
    modelEl.innerHTML = '';
    for (const m of d.models) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      modelEl.appendChild(o);
    }
    if (!d.models.length) {
      const o = document.createElement('option');
      o.textContent = '(no models pulled — run: ollama pull llama3.1:8b)';
      o.value = '';
      modelEl.appendChild(o);
    }
    state.model = state.model && d.models.includes(state.model) ? state.model : (d.models[0] || d.default);
    modelEl.value = state.model;
    save();
  } catch (e) {
    statusEl.textContent = 'no runtime';
    modelEl.innerHTML = `<option value="">runtime unreachable: ${e.message}</option>`;
  }
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 220) + 'px';
}

input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});

$('newChat').onclick = newChat;
$('sysBtn').onclick = () => { sysEl.value = state.system; sysDialog.showModal(); };
$('sysReset').onclick = () => { sysEl.value = DEFAULT_SYS; };
sysDialog.addEventListener('close', () => {
  if (sysDialog.returnValue === 'save') { state.system = sysEl.value; save(); }
});
tempEl.oninput = () => { state.temp = Number(tempEl.value); tempVal.textContent = state.temp.toFixed(2); save(); };
ctxEl.oninput = () => { state.ctx = Number(ctxEl.value); ctxVal.textContent = state.ctx; save(); };
modelEl.onchange = () => { state.model = modelEl.value; save(); };

stopBtn.onclick = () => { abortCtl?.abort(); };

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  if (!activeChat()) newChat();
  const c = activeChat();

  input.value = '';
  autosize();

  c.messages.push({ role: 'user', content: text });
  if (c.title === 'untitled') {
    c.title = text.slice(0, 42) + (text.length > 42 ? '…' : '');
    titleEl.textContent = c.title;
  }
  bubble('user', text);
  save();
  renderChatList();

  const out = bubble('assistant', '');
  statusEl.textContent = 'cooking...';
  sendBtn.disabled = true;
  stopBtn.hidden = false;
  abortCtl = new AbortController();

  let acc = '';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: abortCtl.signal,
      body: JSON.stringify({
        model: state.model,
        system: state.system,
        temperature: state.temp,
        num_ctx: state.ctx,
        messages: c.messages.slice(-40),
      }),
    });

    if (!res.ok || !res.body) throw new Error(`http ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;

        let obj;
        try { obj = JSON.parse(line.slice(6)); } catch { continue; }

        if (obj.error) throw new Error(obj.error);
        if (obj.delta) {
          acc += obj.delta;
          out.textContent = acc;
          logEl.scrollTop = logEl.scrollHeight;
        }
        if (obj.done) break;
      }
    }

    if (acc.trim()) {
      c.messages.push({ role: 'assistant', content: acc });
      save();
    }
    statusEl.textContent = 'ready';
  } catch (err) {
    if (err.name === 'AbortError') {
      statusEl.textContent = 'stopped';
      if (acc.trim()) { c.messages.push({ role: 'assistant', content: acc }); save(); }
    } else {
      out.classList.add('error');
      out.textContent = (acc ? acc + '\n\n' : '') + `[bench] ${err.message}`;
      statusEl.textContent = 'error';
    }
  } finally {
    sendBtn.disabled = false;
    stopBtn.hidden = true;
    abortCtl = null;
    out.classList.remove('assistant');
    out.classList.add('assistant');
  }
});

// boot
if (!state.chats.length) newChat();
else renderAll();
loadModels();
input.focus();
