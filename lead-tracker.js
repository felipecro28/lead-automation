/*! Scal Page Loaded v1.4
 * Instalação:
 * <script src="https://cdn.sistemascal.com.br/lead-tracker/page-loaded.js" async></script>
 *
 * Opcionais na tag:
 *   data-endpoint="https://..."      outro endereço de proxy
 *   data-selector="#whatsapp-button" seletor do botão principal
 *   data-clinic="5585..."            reserva, usada só se não houver botão de WhatsApp na página
 *   data-debug="true"                mostra logs no console
 *
 * 1. Ao carregar a página, envia ao proxy o evento "page_loaded" com a clínica
 *    (número do WhatsApp do botão) e todos os parâmetros da URL.
 * 2. O proxy responde { success, protocol_number, hidden_protocol }.
 * 3. O hidden_protocol (caracteres invisíveis) é colocado no início da mensagem
 *    de todos os links de WhatsApp da página, inclusive os criados depois (modais)
 *    e os abertos por window.open.
 * 4. No clique em WhatsApp, envia ao proxy o evento "whatsapp_click" com o
 *    protocol_number e o hidden_protocol.
 */
(function () {
  'use strict';
  if (window.__scalPageLoaded) return;
  window.__scalPageLoaded = true;

  var script = document.currentScript || document.querySelector('script[src*="page-loaded"]');
  var ds = (script && script.dataset) || {};
  var cfg = {
    endpoint: ds.endpoint || 'https://11f4-2804-14d-2a73-448f-bc41-7b89-9ecb-c670.ngrok-free.app',
    selector: ds.selector || '#whatsapp-button',
    fallbackClinic: ds.clinic || '',
    debug: ds.debug === 'true',
    waitMs: 10000,
    timeoutMs: 8000
  };

  var api = window.ScalPage = {
    config: cfg, payload: null, resposta: null, status: null,
    protocolo: '', protocoloOculto: ''
  };

  function log() {
    if (cfg.debug) console.log.apply(console, ['[Scal]'].concat([].slice.call(arguments)));
  }

  var WA_SELECTOR = 'a[href*="api.whatsapp.com"], a[href*="wa.me/"], a[href*="web.whatsapp.com"], a[href^="whatsapp:"]';
  var WA_URL = /(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|^whatsapp:)/i;
  // Caracteres invisíveis usados em protocolos (zero-width space, non-joiner, joiner, word joiner, BOM)
  var INVISIBLE_BLOCK = /[\u200B\u200C\u200D\u2060\uFEFF]+/g;
  var PROTOCOL_LABEL = 'Protocolo de atendimento: ';
  // Linha de protocolo injetada pelo script (para não duplicar ao reaplicar)
  var PROTOCOL_LINE = /^Protocolo de atendimento:[^\n]*\n/;

  // Remove o que o script injetou: a linha do protocolo visível e os caracteres invisíveis
  function cleanMessage(text) {
    return String(text || '').replace(INVISIBLE_BLOCK, '').replace(PROTOCOL_LINE, '');
  }

  function normalizePhone(v) {
    var d = String(v || '').replace(/\D/g, '');
    if (d.length === 10 || d.length === 11) d = '55' + d;
    return d;
  }

  function phoneFromLink(href) {
    if (!href) return '';
    try {
      var u = new URL(href, location.href);
      var p = u.searchParams.get('phone');
      if (p) return normalizePhone(p);
      if (/wa\.me$/i.test(u.hostname)) return normalizePhone(u.pathname);
    } catch (e) {}
    var m = String(href).match(/phone=([\d+\s-]+)/i) || String(href).match(/wa\.me\/(\d+)/i);
    return m ? normalizePhone(m[1]) : '';
  }

  function messageFromLink(href) {
    try { return new URL(href, location.href).searchParams.get('text') || ''; } catch (e) { return ''; }
  }

  function findButton() {
    var el = null;
    try { el = document.querySelector(cfg.selector); } catch (e) {}
    if (el && phoneFromLink(el.getAttribute('href'))) return el;
    return document.querySelector(WA_SELECTOR);
  }

  function allWhatsappNumbers() {
    var seen = {};
    document.querySelectorAll(WA_SELECTOR).forEach(function (a) {
      var p = phoneFromLink(a.getAttribute('href'));
      if (p) seen[p] = true;
    });
    return Object.keys(seen);
  }

  // Parâmetros da URL: mantém o primeiro valor e ignora textos não substituídos como {CampaignName}
  function urlParams() {
    var out = {};
    try {
      new URLSearchParams(location.search).forEach(function (val, key) {
        if (!val || /^\{[^}]*\}$/.test(val)) return;
        if (!(key in out)) out[key] = val.slice(0, 300);
      });
    } catch (e) {}
    return out;
  }

  // ---------- Protocolo ----------
  // A mensagem fica assim:
  //   Protocolo de atendimento: GAAB7H
  //   <protocolo invisível>Olá! Vim pelo site...
  // O protocolo visível é a garantia: se o WhatsApp descartar os invisíveis,
  // o número continua legível no texto.
  function buildMessage(original) {
    var rest = cleanMessage(original) || 'Olá!';
    return PROTOCOL_LABEL + api.protocolo + '\n' + api.protocoloOculto + rest;
  }

  // Monta a URL com encodeURIComponent (espaço vira %20, e não +, que alguns aparelhos mostram literalmente)
  function withText(url, text) {
    var u = new URL(url, location.href);
    var parts = [];
    u.searchParams.forEach(function (val, key) {
      if (key !== 'text') parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(val));
    });
    parts.push('text=' + encodeURIComponent(text));
    return u.origin === 'null' || u.protocol === 'whatsapp:'
      ? u.protocol + '//' + u.host + u.pathname + '?' + parts.join('&')
      : u.origin + u.pathname + '?' + parts.join('&') + u.hash;
  }

  function injectHidden(url) {
    if (!api.protocolo || !url || !WA_URL.test(url)) return url;
    try {
      var current = new URL(url, location.href).searchParams.get('text') || '';
      var novo = buildMessage(current);
      if (current === novo) return url;   // já está aplicado
      return withText(url, novo);
    } catch (e) {
      return url;
    }
  }

  function applyToLink(a) {
    var href = a.getAttribute('href');
    if (!href || !WA_URL.test(href)) return;
    var novo = injectHidden(href);
    if (novo !== href) a.setAttribute('href', novo);
  }

  function applyToAllLinks() {
    var n = 0;
    document.querySelectorAll(WA_SELECTOR).forEach(function (a) { applyToLink(a); n++; });
    log('protocolo oculto aplicado em', n, 'link(s) de WhatsApp');
  }

  // Links criados ou alterados depois (ex.: modal que monta o link ao escolher a unidade)
  function watchLinks() {
    var obs = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.type === 'attributes' && m.target.matches && m.target.matches(WA_SELECTOR)) {
          applyToLink(m.target);
        }
        if (m.type === 'childList') {
          m.addedNodes.forEach(function (node) {
            if (node.nodeType !== 1) return;
            if (node.matches && node.matches(WA_SELECTOR)) applyToLink(node);
            if (node.querySelectorAll) node.querySelectorAll(WA_SELECTOR).forEach(applyToLink);
          });
        }
      });
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  }

  // ---------- Clique no WhatsApp ----------
  // Aplica o protocolo no link (caso o site tenha trocado no último instante)
  // e envia o evento "whatsapp_click" ao proxy.
  var lastClickAt = 0;

  function sendClick(el, url) {
    var now = Date.now();
    if (now - lastClickAt < 1500) return;   // evita duplicar clique + window.open do mesmo gesto
    lastClickAt = now;
    var payload = buildPayload('whatsapp_click', el, url);
    log('enviando whatsapp_click', payload);
    postClick(payload);
  }

  document.addEventListener('click', function (e) {
    var path = e.composedPath ? e.composedPath() : [e.target];
    for (var i = 0; i < path.length && i < 10; i++) {
      var el = path[i];
      if (el && el.nodeType === 1 && el.tagName === 'A' && el.matches(WA_SELECTOR)) {
        applyToLink(el);
        sendClick(el, el.getAttribute('href'));
        return;
      }
    }
  }, true);

  // Sites que abrem o WhatsApp com window.open (botões sem link direto)
  var nativeOpen = window.open;
  window.open = function (url) {
    var args = [].slice.call(arguments);
    try {
      if (url && WA_URL.test(String(url))) {
        args[0] = injectHidden(String(url));
        sendClick(null, args[0]);
      }
    } catch (e) {}
    return nativeOpen.apply(this, args);
  };

  // Aceita a resposta em formatos diferentes que o n8n pode devolver:
  // { ... }, [ { ... } ], { json: { ... } }, { body: { ... } } ou { data: { ... } }
  function unwrap(data) {
    for (var i = 0; i < 4 && data; i++) {
      if (Array.isArray(data)) { data = data[0]; continue; }
      if (typeof data === 'object' && !data.hidden_protocol) {
        var inner = data.json || data.body || data.data;
        if (inner && typeof inner === 'object') { data = inner; continue; }
      }
      break;
    }
    return data;
  }

  function handleResponse(data) {
    data = unwrap(data);
    if (!data || typeof data !== 'object') { log('resposta do proxy não é JSON:', data); return; }
    if (data.hidden_protocol) api.protocoloOculto = String(data.hidden_protocol);
    if (data.protocol_number) {
      api.protocolo = String(data.protocol_number);
      log('protocolo recebido', api.protocolo, '(oculto com', api.protocoloOculto.length, 'caracteres)');
      applyToAllLinks();
      watchLinks();
    } else {
      log('resposta sem protocol_number; links mantidos como estão');
    }
  }

  // ---------- Envio do page_loaded ----------
  function buildPayload(gatilho, button, hrefOverride) {
    var href = hrefOverride || (button ? button.getAttribute('href') : '');
    var params = urlParams();
    var payload = {
      gatilho: gatilho,
      protocol_number: api.protocolo,
      hidden_protocol: api.protocoloOculto,
      clinica: phoneFromLink(href) || normalizePhone(cfg.fallbackClinic) || normalizePhone(params.utm_unidade),
      whatsapp_destino: phoneFromLink(href),
      whatsapp_numeros_pagina: allWhatsappNumbers().join(','),
      unidade: button ? (button.getAttribute('data-unidade') || '') : '',
      botao_id: button ? (button.id || '') : '',
      botao_texto: button ? (button.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100) : '',
      mensagem_whatsapp: href ? cleanMessage(messageFromLink(href)) : '',
      pagina: location.href,
      titulo: document.title,
      referrer: document.referrer,
      data_hora: new Date().toISOString()
    };
    Object.keys(params).forEach(function (k) {
      if (!(k in payload)) payload[k] = params[k];
    });
    return payload;
  }

  function post(payload) {
    var headers = {};
    if (/ngrok/i.test(cfg.endpoint)) headers['ngrok-skip-browser-warning'] = 'true';

    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, cfg.timeoutMs) : null;

    return fetch(cfg.endpoint, {
      method: 'POST',
      headers: headers,
      body: new URLSearchParams(payload),
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (r) {
        api.status = r.status;
        return r.text();
      })
      .then(function (text) {
        if (timer) clearTimeout(timer);
        var data = text;
        try { data = JSON.parse(text); } catch (e) {}
        api.resposta = data;
        log('proxy respondeu', api.status, data);
        handleResponse(data);
        return data;
      })
      .catch(function (e) {
        if (timer) clearTimeout(timer);
        log('falha ao falar com o proxy', e && e.message);
      });
  }

  // Envio do clique: fetch com keepalive (continua mesmo se a página sair);
  // se o navegador recusar, usa sendBeacon.
  function postClick(payload) {
    var body = new URLSearchParams(payload);
    var headers = {};
    if (/ngrok/i.test(cfg.endpoint)) headers['ngrok-skip-browser-warning'] = 'true';
    try {
      fetch(cfg.endpoint, { method: 'POST', headers: headers, body: body, keepalive: true })
        .then(function (r) { log('proxy respondeu ao clique', r.status); })
        .catch(function () {
          try { navigator.sendBeacon && navigator.sendBeacon(cfg.endpoint, new URLSearchParams(payload)); } catch (e) {}
        });
    } catch (e) {
      try { navigator.sendBeacon && navigator.sendBeacon(cfg.endpoint, body); } catch (err) {}
    }
  }

  var sent = false;
  function send(button) {
    if (sent) return;
    sent = true;
    var payload = buildPayload('page_loaded', button);
    delete payload.protocol_number;   // ainda não existe protocolo no carregamento
    delete payload.hidden_protocol;
    api.payload = payload;
    if (!payload.clinica) log('nenhum botão de WhatsApp encontrado; enviando sem clínica');
    log('enviando page_loaded', payload);
    post(payload);
  }

  function start() {
    var button = findButton();
    if (button) { send(button); return; }

    log('botão de WhatsApp ainda não encontrado, aguardando...');
    var observer = new MutationObserver(function () {
      var b = findButton();
      if (b) { observer.disconnect(); clearTimeout(timer); send(b); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    var timer = setTimeout(function () { observer.disconnect(); send(null); }, cfg.waitMs);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
