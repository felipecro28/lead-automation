/*! Scal Page Loaded v1.1
 * Instalação:
 * <script src="https://cdn.sistemascal.com.br/lead-tracker/page-loaded.js" async></script>
 *
 * Opcionais na tag:
 *   data-endpoint="https://..."      outro endereço de proxy
 *   data-selector="#whatsapp-button" seletor do botão principal (padrão: #whatsapp-button, depois qualquer link de WhatsApp)
 *   data-clinic="5585..."            reserva, usada só se não houver botão de WhatsApp na página
 *   data-debug="true"                mostra logs no console
 *
 * Ao carregar a página, procura o botão de WhatsApp, lê o número de destino (phone=...)
 * e envia ao proxy um evento com gatilho "page_loaded", a clínica (número do WhatsApp)
 * e todos os parâmetros da URL. A resposta do proxy fica em window.ScalPage.resposta.
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
    waitMs: 10000,           // tempo máximo esperando o botão aparecer
    timeoutMs: 8000          // tempo máximo esperando a resposta do proxy
  };

  var api = window.ScalPage = { config: cfg, payload: null, resposta: null, status: null };

  function log() {
    if (cfg.debug) console.log.apply(console, ['[Scal]'].concat([].slice.call(arguments)));
  }

  var WA_SELECTOR = 'a[href*="api.whatsapp.com"], a[href*="wa.me/"], a[href*="web.whatsapp.com"], a[href^="whatsapp:"]';

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

  function urlParams() {
    var out = {};
    try {
      new URLSearchParams(location.search).forEach(function (val, key) {
        if (val) out[key] = val.slice(0, 300);
      });
    } catch (e) {}
    return out;
  }

  function buildPayload(button) {
    var href = button ? button.getAttribute('href') : '';
    var params = urlParams();
    var payload = {
      gatilho: 'page_loaded',
      clinica: phoneFromLink(href) || normalizePhone(cfg.fallbackClinic) || normalizePhone(params.utm_unidade),
      whatsapp_destino: phoneFromLink(href),
      whatsapp_numeros_pagina: allWhatsappNumbers().join(','),
      unidade: button ? (button.getAttribute('data-unidade') || '') : '',
      botao_id: button ? (button.id || '') : '',
      botao_texto: button ? (button.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100) : '',
      mensagem_whatsapp: href ? messageFromLink(href) : '',
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

  // Envia com fetch para poder ler a resposta do proxy.
  // Para endereços do ngrok, manda o header que pula a tela de aviso do ngrok gratuito.
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
        return data;
      })
      .catch(function (e) {
        if (timer) clearTimeout(timer);
        log('falha no fetch, tentando sendBeacon', e && e.message);
        try { navigator.sendBeacon && navigator.sendBeacon(cfg.endpoint, new URLSearchParams(payload)); } catch (err) {}
      });
  }

  var sent = false;
  function send(button) {
    if (sent) return;
    sent = true;
    var payload = buildPayload(button);
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
