/* ============================================================
   Asistente de Growth — Bancor
   Widget standalone. Se auto-inyecta en el DOM al cargar este
   script — solo hace falta incluir assistant-widget.css y este
   archivo antes de </body> en el dashboard.

   Backend esperado: POST /api/growth-assistant
     body:  { message: string, history: [{role, content}] }
     resp:  { reply: string, dataAsOf?: string }
   ============================================================ */
(function () {
  const ENDPOINT = window.GA_ASSISTANT_ENDPOINT || '/api/growth-assistant';
  const STORAGE_KEY = 'ga_growth_assistant_history_v1';

  const ICON_SPARKLE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12a6 6 0 1 1 2.1 4.55c-.28.24-1.2.9-2.8 1.45.28-1 .55-2.05.5-2.5A5.98 5.98 0 0 1 8 12Z"/><path d="M17 6.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3Z" fill="currentColor" stroke="none"/></svg>`;
  const ICON_BOT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 4h6"/><circle cx="9" cy="14" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="14" r="1.2" fill="currentColor" stroke="none"/></svg>`;
  const ICON_CLOSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
  const ICON_SEND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/></svg>`;

  let state = {
    open: false,
    sending: false,
    history: loadHistory()
  };

  function loadHistory() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveHistory() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state.history)); } catch (e) {}
  }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function build() {
    const root = el(`
      <div id="ga-root">
        <div id="ga-shell" class="ga-surface">
          <div id="ga-pulse"></div>
          <div id="ga-bubble-face">
            <span id="ga-bubble-placeholder">Preguntá sobre growth</span>
            <span id="ga-bubble-icon">${ICON_SPARKLE}</span>
            <span class="ga-dot"></span>
          </div>
          <div id="ga-panel">
            <div id="ga-header">
              <div id="ga-header-icon">${ICON_BOT}</div>
              <div id="ga-header-text">
                <div id="ga-header-title">Asistente de Growth</div>
                <div id="ga-header-sub"><span class="ga-live-dot"></span>Bancor · datos en vivo</div>
              </div>
              <button id="ga-close" aria-label="Cerrar">${ICON_CLOSE}</button>
            </div>
            <div id="ga-messages"></div>
            <div id="ga-inputbar">
              <textarea id="ga-input" rows="1" placeholder="Preguntame sobre ritmo, squads o estrategia de growth..."></textarea>
              <button id="ga-send" aria-label="Enviar">${ICON_SEND}</button>
            </div>
          </div>
        </div>
      </div>
    `);
    document.body.appendChild(root);
    return root;
  }

  function renderMessages() {
    const container = document.getElementById('ga-messages');
    container.innerHTML = '';
    if (state.history.length === 0) {
      container.appendChild(el(`<div id="ga-empty">Preguntame</div>`));
    }
    state.history.forEach((m) => {
      const bubble = el(`<div class="ga-msg ga-msg-${m.role === 'user' ? 'user' : 'assistant'}"></div>`);
      bubble.textContent = m.content;
      container.appendChild(bubble);
    });
    container.scrollTop = container.scrollHeight;
  }

  function setTyping(on) {
    const container = document.getElementById('ga-messages');
    const existing = document.getElementById('ga-typing');
    if (on && !existing) {
      container.appendChild(el(`<div id="ga-typing"><span></span><span></span><span></span></div>`));
      container.scrollTop = container.scrollHeight;
    } else if (!on && existing) {
      existing.remove();
    }
  }

  async function sendMessage(text) {
    const value = (text || '').trim();
    if (!value || state.sending) return;

    state.history.push({ role: 'user', content: value });
    renderMessages();
    saveHistory();

    const input = document.getElementById('ga-input');
    input.value = '';
    autosize(input);
    state.sending = true;
    document.getElementById('ga-send').disabled = true;
    setTyping(true);

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: value,
          history: state.history.slice(0, -1).slice(-10) // últimos 10 turnos de contexto
        })
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();

      setTyping(false);
      state.history.push({ role: 'assistant', content: data.reply || 'No pude generar una respuesta, probá de nuevo.' });
      renderMessages();
      saveHistory();
    } catch (err) {
      setTyping(false);
      state.history.push({
        role: 'assistant',
        content: 'Se cortó la conexión con el asistente. Probá de nuevo en un momento — si sigue fallando, avisá al equipo de Growth Eng.'
      });
      renderMessages();
      saveHistory();
    } finally {
      state.sending = false;
      document.getElementById('ga-send').disabled = false;
    }
  }

  function autosize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 90) + 'px';
  }

  function openPanel() {
    state.open = true;
    document.getElementById('ga-shell').classList.add('ga-open');
    setTimeout(() => document.getElementById('ga-input').focus(), 300);
  }
  function closePanel() {
    state.open = false;
    document.getElementById('ga-shell').classList.remove('ga-open');
  }

  function wireEvents() {
    document.getElementById('ga-bubble-face').addEventListener('click', openPanel);
    document.getElementById('ga-close').addEventListener('click', closePanel);
    document.getElementById('ga-send').addEventListener('click', () => sendMessage(document.getElementById('ga-input').value));
    const input = document.getElementById('ga-input');
    input.addEventListener('input', () => autosize(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(input.value);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.open) closePanel();
    });
  }

  function init() {
    build();
    renderMessages();
    wireEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
