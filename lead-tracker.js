/*! Lead Tracker WhatsApp v1.0
 * Instalação:
 * <script src="https://cdn.seusistema.com/lead-tracker.js"
 *         data-clinic="ID_DA_CLINICA"
 *         data-endpoint="https://api.seusistema.com/leads"
 *         data-selectors=".btn-agendar, #meu-botao"   (opcional)
 *         data-debug="true"                            (opcional)
 *         async></script>
 */
(function () {
  'use strict';
  if (window.__leadTrackerLoaded) return;
  window.__leadTrackerLoaded = true;

  // ---------- Configuração ----------
  var script = document.currentScript || document.querySelector('script[data-clinic]');
  var ds = (script && script.dataset) || {};
  var cfg = Object.assign({
    clinicId: ds.clinic || '',
    endpoint: ds.endpoint || 'https://20a0-2804-14d-2a73-448f-9153-62e5-a83a-941e.ngrok-free.app',
    selectors: ds.selectors || '',            // seletores extras de botões, por clínica
    allowEmpty: ds.allowEmpty === 'true',     // envia mesmo sem nome/telefone/email?
    debug: ds.debug === 'true',
    dedupeMs: 30000,                          // não reenvia o mesmo lead em 30s
    pendingMs: 15000                          // janela após submit para detectar redirecionamento
  }, window.LeadTrackerConfig || {});

  function log() {
    if (cfg.debug) console.log.apply(console, ['[LeadTracker]'].concat([].slice.call(arguments)));
  }
  if (!cfg.clinicId) { console.warn('[LeadTracker] data-clinic ausente, script desativado'); return; }

  // ---------- Detecção de WhatsApp ----------
  var WA_URL = /(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|^whatsapp:)/i;
  var WA_HINT = /whats|wpp|zap/i;
  var CLICKABLE = 'a,button,input[type=submit],input[type=button],[role=button],[onclick]';

  function waHref(el) {
    var href = el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('formaction') || '';
    if (WA_URL.test(href)) return href;
    var oc = el.getAttribute('onclick') || '';
    var m = oc.match(/(https?:\/\/)?(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)[^'"\s)]*/i);
    return m ? m[0] : '';
  }

  function safeMatches(el, sel) {
    try { return !!sel && el.matches(sel); } catch (e) { return false; }
  }

  function isTrigger(el) {
    if (safeMatches(el, cfg.selectors)) return true;
    if (!safeMatches(el, CLICKABLE)) return false;
    if (waHref(el)) return true;
    var cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
    var hint = [el.id, cls, el.getAttribute('aria-label'), el.title, el.value, (el.textContent || '').slice(0, 80)].join(' ');
    return WA_HINT.test(hint);
  }

  // ---------- Extração dos dados do formulário ----------
  function labelText(el) {
    var t = '';
    try {
      if (el.id) {
        var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l) t += l.textContent;
      }
    } catch (e) {}
    var p = el.closest('label');
    if (p) t += ' ' + p.textContent;
    return t;
  }

  function classify(el) {
    var type = (el.type || '').toLowerCase();
    var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (type === 'email' || ac === 'email') return 'email';
    if (type === 'tel' || ac.indexOf('tel') === 0) return 'phone';
    var hay = [el.name, el.id, el.placeholder, ac, el.getAttribute('aria-label'), labelText(el)].join(' ');
    if (/e-?mail/i.test(hay)) return 'email';
    if (/tel|fone|phone|celular|whats|wpp|mobile/i.test(hay)) return 'phone';
    if (/nome|name/i.test(hay)) return 'name';
    return null;
  }

  function extract(container) {
    var d = { name: '', phone: '', email: '', fields: {} };
    if (!container) return d;
    container.querySelectorAll('input, select, textarea').forEach(function (el, i) {
      var type = (el.type || '').toLowerCase();
      if (['password', 'submit', 'button', 'file', 'image', 'reset'].indexOf(type) > -1) return;
      if ((type === 'checkbox' || type === 'radio') && !el.checked) return;
      var val = (el.value || '').trim();
      if (!val) return;
      d.fields[el.name || el.id || ('campo_' + i)] = val.slice(0, 500);
      if (type === 'hidden') return;
      var kind = classify(el);
      if (kind && !d[kind]) d[kind] = val;
    });
    return d;
  }

  function hasData(d) { return !!(d.name || d.phone || d.email); }

  // Encontra o "formulário" mesmo quando não existe <form> (landing pages com divs)
  function findContainer(el) {
    if (!el || !el.closest) return null;
    var form = el.closest('form');
    if (form) return form;
    var node = el.parentElement;
    for (var i = 0; node && i < 6; i++, node = node.parentElement) {
      if (node.querySelector('input, textarea')) return node;
    }
    return null;
  }

  // Guarda o último formulário que o usuário preencheu (para botões flutuantes fora do form)
  var lastContainer = null;
  document.addEventListener('input', function (e) {
    var c = findContainer(e.target);
    if (c) lastContainer = c;
  }, true);

  // ---------- Atribuição (UTMs persistem entre páginas na sessão) ----------
  var ATTR_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'gbraid', 'wbraid'];
  function attribution() {
    var out = {}, stored = {};
    try { stored = JSON.parse(sessionStorage.getItem('__lt_attr') || '{}'); } catch (e) {}
    var p = new URLSearchParams(location.search);
    ATTR_KEYS.forEach(function (k) { if (p.get(k)) out[k] = p.get(k); });
    out = Object.assign(stored, out);
    try { sessionStorage.setItem('__lt_attr', JSON.stringify(out)); } catch (e) {}
    return out;
  }
  attribution(); // salva já no carregamento

  function waMessage(url) {
    try { return new URL(url, location.href).searchParams.get('text') || ''; } catch (e) { return ''; }
  }

  // ---------- Envio ----------
  var sentAt = {};
  function send(trigger, container, waUrl, manual) {
    var d = manual || extract(container);
    if (!hasData(d) && !cfg.allowEmpty) { log('sem dados de contato, ignorado', trigger); return false; }

    var key = [d.name, d.phone, d.email].join('|');
    var now = Date.now();
    if (sentAt[key] && now - sentAt[key] < cfg.dedupeMs) { log('duplicado, ignorado'); return false; }
    sentAt[key] = now;

    var attr = attribution();
    var payload = {
      clinica: cfg.clinicId,
      nome: d.name || '',
      telefone: (d.phone || '').replace(/\D/g, ''),
      email: d.email || '',
      utm_source: attr.utm_source || '',
      utm_medium: attr.utm_medium || '',
      utm_campaign: attr.utm_campaign || '',
      utm_term: attr.utm_term || '',
      utm_content: attr.utm_content || '',
      gclid: attr.gclid || '',
      fbclid: attr.fbclid || '',
      gatilho: trigger,
      mensagem_whatsapp: waUrl ? waMessage(waUrl) : '',
      pagina: location.href,
      referrer: document.referrer,
      data_hora: new Date().toISOString()
    };
    log('enviando lead', payload);

    // urlencoded: o n8n já entrega como campos em $json.body e não exige preflight CORS.
    // sendBeacon continua o envio mesmo quando a página redireciona pro WhatsApp.
    var body = new URLSearchParams(payload);
    var ok = false;
    try { ok = navigator.sendBeacon && navigator.sendBeacon(cfg.endpoint, body); } catch (e) {}
    if (!ok) {
      try {
        fetch(cfg.endpoint, { method: 'POST', body: body, keepalive: true, mode: 'no-cors' })
          .catch(function () {});
      } catch (e) {}
    }
    return true;
  }

  // ---------- Gatilho 1: clique em qualquer botão/link de WhatsApp ----------
  document.addEventListener('click', function (e) {
    var path = e.composedPath ? e.composedPath() : [e.target];
    for (var i = 0; i < path.length && i < 10; i++) {
      var el = path[i];
      if (!el || el.nodeType !== 1) continue;
      if (isTrigger(el)) {
        var container = findContainer(el) || lastContainer;
        // Se for submit de um form inválido, o navegador vai bloquear: não conta
        if (container && container.tagName === 'FORM' && el.type === 'submit' &&
            container.checkValidity && !container.checkValidity()) return;
        send('whatsapp_click', container, waHref(el));
        return;
      }
    }
  }, true);

  // ---------- Gatilho 2: form enviado que redireciona via JS ----------
  var pending = null;
  document.addEventListener('submit', function (e) {
    var d = extract(e.target);
    if (hasData(d)) { pending = { container: e.target, at: Date.now() }; log('submit pendente'); }
  }, true);

  function flushPending(trigger, url) {
    if (pending && Date.now() - pending.at < cfg.pendingMs) {
      send(trigger, pending.container, url);
      pending = null;
      return true;
    }
    return false;
  }

  // Sites que fazem window.open('https://wa.me/...')
  var nativeOpen = window.open;
  window.open = function (url) {
    try {
      if (url && WA_URL.test(String(url))) {
        if (!flushPending('form_submit_whatsapp', String(url))) send('whatsapp_open', lastContainer, String(url));
      }
    } catch (e) {}
    return nativeOpen.apply(this, arguments);
  };

  // Sites que fazem location.href = 'https://wa.me/...' (não interceptável; pega na saída da página)
  window.addEventListener('pagehide', function () { flushPending('form_submit_leave'); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushPending('form_submit_leave');
  });

  // ---------- API manual (para sites com integração customizada) ----------
  window.LeadTracker = {
    track: function (data) { return send('manual', null, (data && data.whatsappUrl) || '', data || {}); },
    config: cfg
  };

  log('ativo para clínica', cfg.clinicId);
})();
