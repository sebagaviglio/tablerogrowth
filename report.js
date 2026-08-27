/* ============================================================
   Informe semanal de Growth — Bancor + Bezza
   Se auto-inyecta en el DOM: primero un modal para cargar el
   insight de cada PO (opcional), después el overlay con el informe
   de los últimos 7 días. Requiere:
     - report.css cargado
     - un botón en el DOM con id="report-launch-btn" (index.html)
   Backend: POST /api/growth-report  body: { comentariosPO?: {squad: texto} }
   ============================================================ */
(function () {
  const ENDPOINT = window.GA_REPORT_ENDPOINT || '/api/growth-report';
  const SQUADS = ['Adquisición y Crosselling', 'Habitualidad', 'Bezza Hub', 'Empresas'];

  const ICON_DOC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6M9 9h1"/></svg>`;
  const ICON_PRINT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>`;
  const ICON_CLOSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function escapeHtml(s) {
    return (s == null ? '' : String(s))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtNum(n, digits) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return n.toLocaleString('es-AR', { maximumFractionDigits: digits || 0 });
  }

  function estadoBadgeClass(estado) {
    if (estado === 'en línea') return 'ok';
    if (estado === 'vigilar') return 'warn';
    if (estado === 'atrasado') return 'bad';
    return 'nodata';
  }
  function estadoBarColor(estado) {
    if (estado === 'en línea') return 'var(--lime-fill)';
    if (estado === 'vigilar') return 'var(--gold-fill)';
    if (estado === 'atrasado') return 'var(--orange-fill)';
    return 'var(--ink-300)';
  }

  /* ---- overlay shell ---- */
  function buildOverlay() {
    if (document.getElementById('report-overlay')) return;
    const overlay = el(`
      <div id="report-overlay">
        <div id="report-sheet">
          <div id="report-toolbar">
            <div class="rt-left"><span>Informe semanal · Growth</span></div>
            <div class="rt-actions">
              <button class="rt-btn" id="report-print-btn">${ICON_PRINT}Exportar / Imprimir</button>
              <button class="rt-btn rt-close" id="report-close-btn">${ICON_CLOSE}Cerrar</button>
            </div>
          </div>
          <div id="report-body">
            <div id="report-loading">
              <div class="rp-loader"></div>
              <div class="rp-loading-text" id="report-loading-text">Leyendo el tablero y armando el informe...</div>
            </div>
            <div id="report-error"></div>
            <div id="report-content" style="display:none;"></div>
          </div>
        </div>
      </div>
    `);
    document.body.appendChild(overlay);

    document.getElementById('report-close-btn').addEventListener('click', closeOverlay);
    document.getElementById('report-print-btn').addEventListener('click', () => window.print());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('open')) closeOverlay();
    });
  }

  /* ---- modal previo: insights de los PO por squad ---- */
  function buildPoModal() {
    if (document.getElementById('po-comments-overlay')) return;
    const fields = SQUADS.map((sq) => `
      <div class="po-field">
        <label for="po-input-${slug(sq)}">${escapeHtml(sq)}</label>
        <textarea id="po-input-${slug(sq)}" data-squad="${escapeHtml(sq)}" rows="2" placeholder="¿Algo para agregar sobre esta semana? (opcional)"></textarea>
      </div>
    `).join('');
    const modal = el(`
      <div id="po-comments-overlay">
        <div id="po-comments-modal">
          <h2>Antes de generar el informe</h2>
          <div class="sub">Sumá el insight de cada PO sobre esta semana — el informe lo va a tener en cuenta al redactar cada squad, y además queda guardado en el Sheet como base de conocimiento para los próximos informes. Es opcional, podés dejarlo en blanco.</div>
          <div id="po-fields">${fields}</div>
          <div class="po-btn-row">
            <button class="rt-btn" id="po-skip-btn">Generar sin comentarios</button>
            <button class="rt-btn po-submit" id="po-submit-btn">Generar informe</button>
          </div>
        </div>
      </div>
    `);
    document.body.appendChild(modal);
    document.getElementById('po-skip-btn').addEventListener('click', () => submitPoModal(true));
    document.getElementById('po-submit-btn').addEventListener('click', () => submitPoModal(false));
    modal.addEventListener('click', (e) => { if (e.target === modal) closePoModal(); });
  }

  function slug(s) { return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-'); }

  function openPoModal() {
    buildPoModal();
    document.getElementById('po-comments-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closePoModal() {
    const modal = document.getElementById('po-comments-overlay');
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
  }

  function submitPoModal(skip) {
    const comentarios = {};
    if (!skip) {
      SQUADS.forEach((sq) => {
        const ta = document.getElementById('po-input-' + slug(sq));
        if (ta && ta.value.trim()) comentarios[sq] = ta.value.trim();
      });
    }
    closePoModal();
    generateReport(comentarios);
  }

  function openOverlay() {
    buildOverlay();
    document.getElementById('report-overlay').classList.add('open');
    document.getElementById('report-loading').style.display = 'flex';
    document.getElementById('report-error').style.display = 'none';
    document.getElementById('report-content').style.display = 'none';
    document.getElementById('report-content').innerHTML = '';
    document.body.style.overflow = 'hidden';
  }
  function closeOverlay() {
    const overlay = document.getElementById('report-overlay');
    if (overlay) overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  /* ---- animaciones ---- */
  function animateCount(elNode, target, opts) {
    opts = opts || {};
    const suffix = opts.suffix || '';
    const digits = opts.digits || 0;
    const duration = 900;
    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = target * eased;
      elNode.textContent = fmtNum(val, digits) + suffix;
      if (t < 1) requestAnimationFrame(frame);
      else elNode.textContent = fmtNum(target, digits) + suffix;
    }
    requestAnimationFrame(frame);
  }

  function observeSections(root) {
    const sections = root.querySelectorAll('.rp-section');
    if (!('IntersectionObserver' in window)) {
      sections.forEach((s) => s.classList.add('rp-visible'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('rp-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, root: document.getElementById('report-overlay') });
    sections.forEach((s) => io.observe(s));
    // primera sección siempre visible de entrada (arriba del todo)
    if (sections[0]) sections[0].classList.add('rp-visible');
  }

  /* ---- render ---- */
  function renderReport(payload, comentariosPO) {
    const report = payload.report;
    const period = payload.period;
    const comentarios = comentariosPO || {};
    let commentsNote = '';
    if (payload.commentsSavedCount) {
      commentsNote = payload.commentsSaved
        ? ` · ${payload.commentsSavedCount} comentario${payload.commentsSavedCount > 1 ? 's' : ''} de PO guardado${payload.commentsSavedCount > 1 ? 's' : ''} en el Sheet`
        : ` · no se pudieron guardar los comentarios de PO en el Sheet (${escapeHtml(payload.commentsError || 'sin detalle')}) — se usaron igual para este informe`;
      // Si se guardaron bien, refrescamos solo esa pestaña en el tablero de fondo
      // (sin esperar a la próxima sincronización completa) para que ya aparezcan
      // en el tooltip del evolutivo diario apenas se cierra el informe.
      if (payload.commentsSaved && typeof window.GA_refreshPOComments === 'function') {
        window.GA_refreshPOComments();
      }
    }

    const squadsHtml = (report.squads || []).map((sq) => {
      const productos = (sq.productos || []).map((p) => `
        <div class="rp-prod-row">
          <span class="rp-prod-name" title="${escapeHtml(p.nombre)}">${escapeHtml(p.nombre)}</span>
          <span class="rp-prod-pct" style="color:${estadoBarColor(p.estado)}">${p.estado === 'sin datos' ? 'sin datos' : fmtNum(p.ritmoPct, 0) + '%'}</span>
        </div>
      `).join('');
      const ritmo = Math.max(0, Math.min(160, sq.ritmoPromedioPct || 0));
      const comentarioPO = sq.comentarioPO;
      const poQuoteHtml = comentarioPO ? `
        <div class="rp-po-quote">
          <span class="rp-po-quote-icon">💬</span>
          <div>
            <div class="rp-po-quote-label">Insight del PO · ${escapeHtml(sq.po || '')}</div>
            <div class="rp-po-quote-text">${escapeHtml(comentarioPO)}</div>
          </div>
        </div>
      ` : '';
      return `
        <div class="rp-squad-card">
          <div class="rp-squad-head">
            <span class="rp-squad-name">${escapeHtml(sq.nombre)}</span>
            <span class="rp-badge ${estadoBadgeClass(sq.estado)}">${escapeHtml(sq.estado || 'sin datos')}</span>
          </div>
          <div class="rp-squad-po">PO · ${escapeHtml(sq.po || 'Sin asignar')}</div>
          <div class="rp-squad-headline">${escapeHtml(sq.headline || '')}</div>
          ${poQuoteHtml}
          <div class="rp-bar-track"><div class="rp-bar-fill" data-target="${ritmo}" style="background:${estadoBarColor(sq.estado)};"></div></div>
          ${productos}
        </div>
      `;
    }).join('');

    const campaigns = report.campanas || [];
    const campaignsHtml = campaigns.map((c) => `
      <div class="rp-camp-card">
        <div class="rp-camp-top">
          <span class="rp-camp-name">${escapeHtml(c.nombre)}</span>
        </div>
        <div class="rp-camp-meta">${escapeHtml(c.squad || '')} · ${escapeHtml(c.canal || '')} · ${escapeHtml(c.estado || '')}</div>
        <div class="rp-camp-stats">
          <div class="rp-camp-stat"><b>${escapeHtml(c.presupuesto || '—')}</b><span>Presupuesto</span></div>
          <div class="rp-camp-stat"><b>${escapeHtml(c.gastoMTD || '—')}</b><span>Gasto MTD</span></div>
          <div class="rp-camp-stat"><b>${escapeHtml(c.cpa || '—')}</b><span>CPA</span></div>
        </div>
        <div class="rp-camp-note">${escapeHtml(c.nota || '')}</div>
      </div>
    `).join('');
    // Solo se muestra la sección si el modelo encontró algo realmente destacable esta semana —
    // no se fuerza a mostrar medios pagos/campañas de relleno.
    const campaignsSection = campaigns.length ? `
      <div class="rp-section" id="rp-sec-campaigns">
        <h2><span class="rp-dot" style="background:var(--orange-fill);"></span>Campañas y experimentos del período</h2>
        <div class="rp-sub">Lo más relevante de la semana — se muestra solo lo que aporta al ritmo de algún squad.</div>
        <div class="rp-camp-grid">${campaignsHtml}</div>
      </div>` : '';

    const insightsHtml = (report.insights || []).map((ins) => `
      <div class="rp-insight ${ins.tipo === 'positive' ? 'positive' : 'negative'}">
        <span class="rp-insight-icon">${ins.tipo === 'positive' ? '▲' : '▼'}</span>
        <div class="rp-insight-metric">${escapeHtml(ins.metrica || '')}</div>
        <div class="rp-insight-title">${escapeHtml(ins.titulo || '')}</div>
        <div class="rp-insight-body">${escapeHtml(ins.cuerpo || '')}</div>
        <div class="rp-insight-squad">${escapeHtml(ins.squad || 'General')}</div>
      </div>
    `).join('');

    const recos = report.recomendaciones || [];
    const recosSection = recos.length ? `
      <div class="rp-section" id="rp-sec-recos">
        <h2><span class="rp-dot" style="background:var(--gold-fill);"></span>Recomendaciones</h2>
        <div class="rp-sub">Próximos pasos sugeridos a partir de los datos de este período.</div>
        <div class="rp-reco-list">
          ${recos.map((r, i) => `<div class="rp-reco-item"><span class="num">${i + 1}.</span><span>${escapeHtml(r)}</span></div>`).join('')}
        </div>
      </div>` : '';

    const html = `
      <div class="rp-head">
        <div class="rp-brands">
          <img src="Logo_Bancor_RGB-02.png" alt="Bancor">
          <span class="rp-plus">+</span>
          <span class="rp-bezza-chip">Bezza</span>
        </div>
        <div class="rp-period"><span class="dot"></span>Período: ${escapeHtml(period.label)}</div>
        ${Object.keys(comentarios).length ? `<div class="rp-po-badge">💬 ${Object.keys(comentarios).length} comentario${Object.keys(comentarios).length > 1 ? 's' : ''} de PO incorporado${Object.keys(comentarios).length > 1 ? 's' : ''}</div>` : ''}
      </div>
      <div class="rp-title">Informe semanal de Growth — para Dirección</div>
      <div class="rp-summary">${escapeHtml(report.resumenEjecutivo || '')}</div>

      <div class="rp-hero">
        <div class="rp-hero-num" id="rp-cumplimiento-num">0<sup>%</sup></div>
        <div class="rp-hero-text">
          <div class="rp-hero-label">Objetivos cumplidos sobre el total · ${escapeHtml(period.label)}</div>
          <div class="rp-hero-headline">${escapeHtml((report.cumplimiento && report.cumplimiento.headline) || '')}</div>
        </div>
      </div>

      <div class="rp-section" id="rp-sec-squads">
        <h2><span class="rp-dot" style="background:var(--teal-500);"></span>Evolución por squad</h2>
        <div class="rp-sub">Ritmo = acumulado real ÷ objetivo prorrateado a la fecha, dentro del período indicado arriba.</div>
        <div class="rp-squad-grid">${squadsHtml}</div>
      </div>

      ${campaignsSection}

      <div class="rp-section" id="rp-sec-insights">
        <h2><span class="rp-dot" style="background:var(--lavender-fill);"></span>Insights relevantes</h2>
        <div class="rp-sub">Lo más destacado del período — positivo y negativo — con el dato que lo respalda.</div>
        <div class="rp-insight-grid">${insightsHtml}</div>
      </div>

      ${recosSection}

      <div class="rp-footer">
        <span>Datos leídos en vivo del Sheet · ${escapeHtml(new Date(payload.dataAsOf).toLocaleString('es-AR'))}${commentsNote}</span>
        <span>Generado por el Asistente de Growth · Bancor + Bezza</span>
      </div>
    `;

    const content = document.getElementById('report-content');
    content.innerHTML = html;
    document.getElementById('report-loading').style.display = 'none';
    content.style.display = 'block';

    // animaciones
    const cumplimientoTarget = (report.cumplimiento && report.cumplimiento.pctObjetivosCumplidos) || 0;
    const cumplimientoEl = document.getElementById('rp-cumplimiento-num');
    animateCount({
      set textContent(v) { cumplimientoEl.innerHTML = v.replace('%', '') + '<sup>%</sup>'; }
    }, cumplimientoTarget, { suffix: '%', digits: 0 });

    observeSections(content);

    // barras de ritmo por squad: animan su ancho al quedar visibles
    const bars = content.querySelectorAll('.rp-bar-fill');
    setTimeout(() => {
      bars.forEach((b) => { b.style.width = Math.min(100, parseFloat(b.dataset.target) || 0) + '%'; });
    }, 150);
  }

  function renderError(message) {
    document.getElementById('report-loading').style.display = 'none';
    const errEl = document.getElementById('report-error');
    errEl.textContent = message;
    errEl.style.display = 'block';
  }

  async function generateReport(comentariosPO) {
    openOverlay();
    try {
      const body = { comentariosPO: comentariosPO || {} };

      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();

      if (data.error) {
        renderError(data.error);
        return;
      }
      renderReport(data, comentariosPO);
    } catch (err) {
      renderError('No se pudo generar el informe — se cortó la conexión con el servidor. Probá de nuevo en un momento.');
    }
  }

  function wire() {
    const btn = document.getElementById('report-launch-btn');
    if (btn) btn.addEventListener('click', openPoModal);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  window.GA_generateGrowthReport = generateReport;
})();
