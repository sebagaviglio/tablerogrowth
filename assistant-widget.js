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

  /* ---- mini markdown renderer: tablas, negrita/cursiva, código, listas ----
     Escapa TODO el HTML de entrada antes de interpretar markdown, así el
     contenido del modelo nunca puede inyectar HTML/JS real. */
  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function inlineMd(text) {
    return text
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*_])[*_]([^*_]+)[*_](?!\*|_)/g, '$1<em>$2</em>');
  }

  function splitTableRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  }

  function unescapeHtml(s) {
    return s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /* ---- gráficos: Chart.js se carga bajo demanda, solo si una respuesta
     trae un bloque ```chart```. No agrega peso si nunca se usa. ---- */
  const CHART_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';
  const CHART_PALETTE = ['#00A39C', '#ADEB00', '#EE632C', '#CB91FF', '#FFDF00', '#00605C'];
  let chartJsPromise = null;
  let activeCharts = [];
  let pendingChartSpecs = {};
  let chartIdCounter = 0;

  function ensureChartJs() {
    if (window.Chart) return Promise.resolve();
    if (chartJsPromise) return chartJsPromise;
    chartJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = CHART_CDN;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('No se pudo cargar Chart.js'));
      document.head.appendChild(s);
    });
    return chartJsPromise;
  }

  function destroyActiveCharts() {
    activeCharts.forEach((c) => { try { c.destroy(); } catch (e) {} });
    activeCharts = [];
  }

  function hydrateCharts() {
    const specs = pendingChartSpecs;
    pendingChartSpecs = {};
    const ids = Object.keys(specs);
    if (ids.length === 0) return;
    ensureChartJs().then(() => {
      ids.forEach((id) => {
        const canvas = document.getElementById(id);
        const spec = specs[id];
        if (!canvas || !spec) return;
        const isCircular = spec.type === 'pie' || spec.type === 'doughnut';
        const datasets = (spec.datasets || []).map((d, idx) => ({
          label: d.label || '',
          data: (d.data || []).map(Number),
          backgroundColor: isCircular ? CHART_PALETTE : (spec.type === 'line' ? 'rgba(0,163,156,0.15)' : CHART_PALETTE[idx % CHART_PALETTE.length]),
          borderColor: isCircular ? '#0A1615' : CHART_PALETTE[idx % CHART_PALETTE.length],
          borderWidth: spec.type === 'line' ? 2 : (isCircular ? 1 : 0),
          tension: 0.35,
          fill: spec.type === 'line',
          borderRadius: spec.type === 'bar' ? 6 : 0
        }));
        try {
          const chart = new window.Chart(canvas, {
            type: spec.type,
            data: { labels: (spec.labels || []).map(String), datasets },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: {
                  display: datasets.length > 1 || isCircular,
                  labels: { color: 'rgba(234,246,244,0.65)', font: { family: 'Inter', size: 10 }, boxWidth: 10 }
                }
              },
              scales: isCircular ? {} : {
                x: { ticks: { color: 'rgba(234,246,244,0.5)', font: { size: 9.5 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { ticks: { color: 'rgba(234,246,244,0.5)', font: { size: 9.5 } }, grid: { color: 'rgba(255,255,255,0.05)' } }
              }
            }
          });
          activeCharts.push(chart);
        } catch (e) { /* un gráfico roto no debe romper el resto de la respuesta */ }
      });
    }).catch(() => { /* si Chart.js no carga, el texto de la respuesta igual queda */ });
  }

  function sanitizeJsonish(text) {
    return text
      .replace(/[\u201C\u201D]/g, '"')   // comillas tipográficas dobles -> rectas
      .replace(/[\u2018\u2019]/g, "'")   // comillas tipográficas simples -> rectas
      .replace(/,\s*([}\]])/g, '$1');    // coma colgante antes de } o ] (error común de LLM)
  }

  function renderChartBlock(escapedSpecText) {
    const rawText = unescapeHtml(escapedSpecText);
    let spec;
    try {
      spec = JSON.parse(sanitizeJsonish(rawText));
    } catch (e) {
      // El JSON vino roto (ej. un array truncado con "..."). En vez de perder
      // la respuesta, mostramos el bloque tal cual como texto — mejor eso
      // que un error mudo.
      return '<div class="ga-chart-error">No pude renderizar esto como gráfico, así que va como texto:</div><pre><code>' + escapedSpecText + '</code></pre>';
    }
    const allowed = ['bar', 'line', 'pie', 'doughnut'];
    if (!spec || !allowed.includes(spec.type) || !Array.isArray(spec.labels) || !Array.isArray(spec.datasets)) {
      return '<div class="ga-chart-error">No pude renderizar esto como gráfico, así que va como texto:</div><pre><code>' + escapedSpecText + '</code></pre>';
    }
    const id = 'ga-chart-' + (chartIdCounter++);
    pendingChartSpecs[id] = spec;
    const title = spec.title ? '<div class="ga-chart-title">' + escapeHtml(String(spec.title)) + '</div>' : '';
    return '<div class="ga-chart-wrap">' + title + '<canvas id="' + id + '"></canvas></div>';
  }

  function renderMarkdown(raw) {
    const lines = escapeHtml(raw || '').split(/\r?\n/);
    const blocks = [];
    let listBuf = null;   // { type: 'ul'|'ol', items: [] }
    let paraBuf = [];
    let i = 0;

    const flushPara = () => {
      if (paraBuf.length) { blocks.push('<p>' + paraBuf.join('<br>') + '</p>'); paraBuf = []; }
    };
    const flushList = () => {
      if (listBuf) {
        const tag = listBuf.type;
        blocks.push('<' + tag + '>' + listBuf.items.map((it) => '<li>' + it + '</li>').join('') + '</' + tag + '>');
        listBuf = null;
      }
    };

    while (i < lines.length) {
      const line = lines[i];

      // bloque con fence: ```chart -> gráfico, ``` a secas -> código genérico
      const fenceMatch = line.match(/^```\s*(\w+)?\s*$/);
      if (fenceMatch) {
        flushPara(); flushList();
        const lang = (fenceMatch[1] || '').toLowerCase();
        i++;
        const codeLines = [];
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { codeLines.push(lines[i]); i++; }
        i++; // saltea el fence de cierre
        const codeText = codeLines.join('\n');
        blocks.push(lang === 'chart' ? renderChartBlock(codeText) : '<pre><code>' + codeText + '</code></pre>');
        continue;
      }

      // encabezado (## Sección) — para reportes con subtítulos
      const headingMatch = line.match(/^\s*#{1,6}\s+(.*)$/);
      if (headingMatch) {
        flushPara(); flushList();
        blocks.push('<h4>' + inlineMd(headingMatch[1]) + '</h4>');
        i++;
        continue;
      }

      // tabla estilo GFM: fila de encabezado + fila separadora (|---|---|)
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flushPara(); flushList();
        const header = splitTableRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(splitTableRow(lines[i])); i++; }
        const thead = '<tr>' + header.map((c) => '<th>' + inlineMd(c) + '</th>').join('') + '</tr>';
        const tbody = rows.map((r) => '<tr>' + r.map((c) => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>').join('');
        blocks.push('<div class="ga-table-wrap"><table class="ga-table"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div>');
        continue;
      }

      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
      if (bullet || numbered) {
        flushPara();
        const type = bullet ? 'ul' : 'ol';
        if (!listBuf || listBuf.type !== type) { flushList(); listBuf = { type, items: [] }; }
        listBuf.items.push(inlineMd(bullet ? bullet[1] : numbered[1]));
        i++;
        continue;
      }

      if (/^\s*$/.test(line)) { flushPara(); flushList(); i++; continue; }

      flushList();
      paraBuf.push(inlineMd(line));
      i++;
    }
    flushPara(); flushList();
    return blocks.join('');
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
    destroyActiveCharts();
    container.innerHTML = '';
    if (state.history.length === 0) {
      container.appendChild(el(`<div id="ga-empty">Preguntame</div>`));
    }
    state.history.forEach((m) => {
      const bubble = el(`<div class="ga-msg ga-msg-${m.role === 'user' ? 'user' : 'assistant'}"></div>`);
      if (m.role === 'assistant') {
        bubble.innerHTML = renderMarkdown(m.content);
      } else {
        bubble.textContent = m.content;
      }
      container.appendChild(bubble);
    });
    container.scrollTop = container.scrollHeight;
    hydrateCharts();
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
