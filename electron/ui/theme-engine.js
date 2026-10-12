/**
 * Akki Ai Theme Engine
 *
 * The renderer is a precompiled React bundle (dist/assets/index-*.css + *.js).
 * Its colors are baked into Tailwind utilities (accent #00E5FF cyan, dark
 * surfaces), so theming is done at RUNTIME by injecting an override stylesheet
 * whose text is a token-swapped copy of the compiled CSS.
 *
 * Design:
 *  1. dTheme:  an injected <style data-theme-full> that duplicates the whole
 *              compiled stylesheet with accent/surface tokens swapped.
 *  2. Default: "akki" is the identity theme. Applying it injects ZERO
 *              override CSS, removes the themed sheet, restores any cached
 *              original inline styles and strips the data-theme marker, so the
 *              UI bytes back to the exact stock appearance every time.
 *  3. Lock:    the central node-graph section (Memory / Soul / Skills /
 *              Settings nodes, their connecting lines and glow effects) must
 *              PERMANENTLY keep stock colors in every theme. The script probes
 *              for the graph container at runtime, marks it [data-theme-lock],
 *              and injects a <style data-theme-lock> that re-applies the ORIGINAL
 *              stock declarations for every rule that matches inside the graph.
 *              The Thinking Orb / Orb2 stages are marked [data-theme-orb] and are
 *              exempted from the lock (they follow the theme accent / glow).
 *  4. Titlebar: a palette button is injected into the custom in-SPA titlebar,
 *              anchored to the left edge of the reserved window-control spacer
 *              (right side, vertically centered). A single click opens the
 *              theme popup; selection persists via IPC to userData/theme.json.
 */

const path = require('path');
const fs = require('fs');

// ─────────────────────────────────────────────────────────────────────────────
//  Theme Registry (shared with main process for IPC whitelist validation)
// ─────────────────────────────────────────────────────────────────────────────
const THEME_REGISTRY = [
  { id: 'akki',        name: 'Akki Legacy',       accent: '#00E5FF', accent2: '#0085FF', soft: '#22d3ee', deep: '#030508', panel: '#0b141b' },
  { id: 'violet-void',   name: 'Violet Void',         accent: '#A822FF', accent2: '#D800FF', soft: '#D800FF', deep: '#06020A', panel: '#12061C' },
  { id: 'solar-amber',   name: 'Solar Amber',         accent: '#FF5500', accent2: '#FF9100', soft: '#FF9100', deep: '#0A0401', panel: '#1C0B03' },
  { id: 'electric-cyan', name: 'Electric Cyan',       accent: '#00D2FF', accent2: '#0077FF', soft: '#0077FF', deep: '#020912', panel: '#051424' },
  { id: 'crimson-neon',  name: 'Crimson Neon',        accent: '#FF003C', accent2: '#FF3355', soft: '#FF3355', deep: '#080103', panel: '#1C0308' },
];

const THEME_IDS = THEME_REGISTRY.map((t) => t.id);

// ─────────────────────────────────────────────────────────────────────────────
//  Load the compiled renderer CSS (embedded into the injected script)
// ─────────────────────────────────────────────────────────────────────────────
let _cachedBaseCss = null;

function getBaseCss() {
  if (_cachedBaseCss === null) {
    _cachedBaseCss = '';
    try {
      const assetsDir = path.join(__dirname, '..', '..', 'dist', 'assets');
      const files = fs.readdirSync(assetsDir);
      const cssFile = (files || []).find((f) => f.toLowerCase().endsWith('.css'));
      if (cssFile) {
        _cachedBaseCss = fs.readFileSync(path.join(assetsDir, cssFile), 'utf8') || '';
      }
    } catch (e) {
      // CSS unavailable → engine applies gracefully (no theme sheet = stock UI)
    }
  }
  return _cachedBaseCss;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Build the injected script.
//  The payload (compiled CSS + registry) is embedded as JSON, so the body can
//  be authored as a plain template literal without interpolation or escaping.
// ─────────────────────────────────────────────────────────────────────────────
function buildEngineScript() {
  const payload = JSON.stringify({
    BASE: getBaseCss(),
    THEMES: THEME_REGISTRY.map((t) => ({ id: t.id, name: t.name, accent: t.accent, accent2: t.accent2, soft: t.soft, deep: t.deep, panel: t.panel })),
  });

  const body = `'use strict';
var REG = __AKKI_THEME_DATA__.THEMES;
var BASE = __AKKI_THEME_DATA__.BASE;
var state = { current: 'akki', graph: null, orbs: [], lockFor: '', inlineFor: '' };
var PALS = {};
var IDS = [];
var SRC_TOKENS = ['#00e5ff', '#00E5FF', '#0085ff', '#0085FF', '#22d3ee', '#22D3EE', '#030508', '#0b141b', '#0B141B', '#0c0d10', '#0C0D10', '#0d1117', '#0D1117', '#07090c', '#07090C', '#080d12', '#080D12', '#090f14', '#000000', 'rgb(0 229 255', 'rgb(34 211 238', 'rgb(6 182 212', 'rgb(16 28 38', 'rgb(19, 28, 48', 'rgba(0 229 255', 'rgba(0, 229, 255,', 'rgba(0,229,255,', 'rgba(34,211,238,', 'rgba(255,255,255,0.1'];
var FULL_ID = 'akki-theme-full';
var LOCK_ID = 'akki-theme-lock';
var BTN_ID = 'akki-theme-btn';
var MENU_ID = 'akki-theme-menu';
var PALETTE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a9 9 0 1 1 9-9c0 2-1.5 2.5-3 2.5h-2c-1 0-1.5.5-1.5 1.5 0 .8.3 1.3.3 2A3 3 0 0 1 12 21z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/></svg>';

function hexRgb(h) {
  h = String(h || '').replace('#', '');
  if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
  var n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function buildPalette(t) {
  var rgb = hexRgb(t.accent);
  var rgb2 = hexRgb(t.accent2);
  var soft = hexRgb(t.soft || t.accent2);
  var pairs = [
    ['#00e5ff', t.accent.toLowerCase()], ['#00E5FF', t.accent],
    ['#0085ff', t.accent2.toLowerCase()], ['#0085FF', t.accent2],
    ['#22d3ee', (t.soft || t.accent2).toLowerCase()], ['#22D3EE', t.soft || t.accent2],
    ['rgb(34 211 238', 'rgb(' + soft[0] + ' ' + soft[1] + ' ' + soft[2]],
    ['rgba(34,211,238,', 'rgba(' + soft[0] + ',' + soft[1] + ',' + soft[2] + ','],
    ['rgb(6 182 212', 'rgb(' + soft[0] + ' ' + soft[1] + ' ' + soft[2]],
    ['#030508', t.deep],
    ['#0b141b', t.panel], ['#0B141B', t.panel],
    ['#0c0d10', t.panel], ['#0C0D10', t.panel],
    ['#0d1117', t.panel], ['#0D1117', t.panel],
    ['#07090c', t.panel], ['#07090C', t.panel],
    ['#080d12', t.panel], ['#080D12', t.panel],
    ['#000000', t.deep],
    ['rgb(0 229 255', 'rgb(' + rgb[0] + ' ' + rgb[1] + ' ' + rgb[2]],
    ['rgba(0 229 255', 'rgba(' + rgb[0] + ' ' + rgb[1] + ' ' + rgb[2]],
    ['rgba(0, 229, 255,', 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ','],
    ['rgba(0,229,255,', 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',']
  ];
  var pr = hexRgb(t.panel);
  var chip = [];
  for (var ci = 0; ci < 3; ci++) { chip[ci] = Math.round(pr[ci] * 0.74 + rgb[ci] * 0.26); }
  pairs = pairs.concat([
    ['#090f14', t.panel],
    ['rgb(16 28 38', 'rgb(' + chip[0] + ' ' + chip[1] + ' ' + chip[2]],
    ['rgb(19, 28, 48', 'rgb(' + pr[0] + ' ' + pr[1] + ' ' + pr[2]],
    ['rgba(255,255,255,0.1', 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.16']
  ]);
  if (t.id === 'akki') {
    for (var pi = 0; pi < pairs.length; pi++) { pairs[pi] = [pairs[pi][0], pairs[pi][0]]; }
  }
  return { id: t.id, accent: t.accent, soft: t.soft, deep: t.deep, panel: t.panel, pairs: pairs };
}

(function initPals() {
  for (var i = 0; i < REG.length; i++) {
    IDS.push(REG[i].id);
    PALS[REG[i].id] = buildPalette(REG[i]);
  }
})();

function hasToken(v) {
  for (var i = 0; i < SRC_TOKENS.length; i++) { if (v.indexOf(SRC_TOKENS[i]) > -1) { return true; } }
  return false;
}

function swapText(text, pal) {
  var out = text;
  for (var k = 0; k < pal.pairs.length; k++) {
    var p = pal.pairs[k];
    if (out.indexOf(p[0]) === -1) { continue; }
    out = out.split(p[0]).join(p[1]);
  }
  return out;
}

function setStyle(id, css) {
  var el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

function removeStyle(id) {
  var el = document.getElementById(id);
  if (el && el.parentNode) { el.parentNode.removeChild(el); }
}

function setThemeAttr(id) {
  document.documentElement.setAttribute('data-theme', id);
}

function clearThemeAttr() {
  document.documentElement.removeAttribute('data-theme');
}

// ── Inline style cache (so switching back to Default restores stock exactly) ──
function cacheOrig(el, key, val) {
  var o = el.__akkiOrig;
  if (!o) {
    o = {};
    try { Object.defineProperty(el, '__akkiOrig', { value: o, writable: true, configurable: true }); }
    catch (e) { el.__akkiOrig = o; }
  }
  if (!(key in o)) { o[key] = val; }
}

function isProtected(el) {
  if (!el.closest) { return false; }
  if (!el.closest('[data-theme-lock]')) { return false; }
  if (el.closest('[data-theme-orb]')) { return false; }
  return true;
}

function runInlineSwap() {
  var pal = PALS[state.current];
  if (!pal || !document.body) { return; }
  var els = document.querySelectorAll('*');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (isProtected(el)) { continue; }
    var style = el.style;
    if (style) {
      for (var p = 0; p < style.length; p++) {
        var prop = style[p];
        var v = style.getPropertyValue(prop);
        if (v && hasToken(v)) {
          cacheOrig(el, 'prop:' + prop, v);
          style.setProperty(prop, swapText(v, pal));
        }
      }
    }
    if (el.hasAttribute && el.hasAttribute('stroke')) {
      var sv = el.getAttribute('stroke');
      if (sv && hasToken(sv)) { cacheOrig(el, 'stroke', sv); el.setAttribute('stroke', swapText(sv, pal)); }
    }
    if (el.hasAttribute && el.hasAttribute('fill')) {
      var fv = el.getAttribute('fill');
      if (fv && hasToken(fv)) { cacheOrig(el, 'fill', fv); el.setAttribute('fill', swapText(fv, pal)); }
    }
  }
}

function restoreInlines() {
  var els = document.querySelectorAll('*');
  for (var i = 0; i < els.length; i++) {
    var o = els[i].__akkiOrig;
    if (!o) { continue; }
    for (var k in o) {
      if (k.slice(0, 5) === 'prop:') { try { els[i].style.setProperty(k.slice(5), o[k]); } catch (e) {} }
      else if (k === 'stroke' || k === 'fill') { try { els[i].setAttribute(k, o[k]); } catch (e) {} }
    }
    try { delete els[i].__akkiOrig; } catch (e) { try { els[i].__akkiOrig = null; } catch (e2) {} }
  }
}

// ── Region overrides (START AI forced black + accent frame) ───────────────────
function forceStartAI(id) {
  if (id === 'akki') { return; }
  var pal = PALS[id];
  if (!pal) { return; }
  var accent = pal.accent;
  var all = document.querySelectorAll('button, a, [role="button"], input');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.__akkiStartAI) { continue; }
    var lb = (labelOf(el) || '').trim().toUpperCase();
    if (lb !== 'START AI') { continue; }
    var r = el.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) { continue; }
    try { if (el.closest('[data-theme-lock]')) { continue; } } catch (e) {}
    el.__akkiStartAI = true;
    cacheOrig(el, 'prop:background-color', el.style.getPropertyValue('background-color'));
    cacheOrig(el, 'prop:border-color', el.style.getPropertyValue('border-color'));
    cacheOrig(el, 'prop:border-style', el.style.getPropertyValue('border-style'));
    cacheOrig(el, 'prop:border-width', el.style.getPropertyValue('border-width'));
    cacheOrig(el, 'prop:color', el.style.getPropertyValue('color'));
    cacheOrig(el, 'prop:box-shadow', el.style.getPropertyValue('box-shadow'));
  }
  for (var k = 0; k < all.length; k++) {
    var e2 = all[k];
    if (!e2.__akkiStartAI) { continue; }
    e2.style.backgroundColor = '#000000';
    e2.style.borderColor = accent;
    e2.style.borderStyle = 'solid';
    if (!/px$/.test(e2.style.getPropertyValue('border-width').trim())) {
      e2.style.borderWidth = '1px';
    }
    e2.style.color = '#ffffff';
    e2.style.boxShadow = '0 0 18px ' + accent + '40, inset 0 0 12px ' + accent + '2e';
  }
}

function clearStartAI() {
  var els = document.querySelectorAll('*');
  for (var i = 0; i < els.length; i++) {
    if (els[i].__akkiStartAI) { els[i].__akkiStartAI = false; }
  }
}

// ── Surface recolors (left tasks/notes panel, right chat panel, orb stages) ──
function parseBgAlpha(color) {
  var m = /rgba\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+,\s*([\d.]+)\s*\)/.exec(color || '');
  if (m) { return Math.min(1, parseFloat(m[1])); }
  if ((color || '').indexOf('transparent') > -1) { return 0; }
  return 1;
}

function firstPanelCandidate(anchor, side) {
  var cur = anchor;
  var iw = window.innerWidth;
  var lo = (side === 'left') ? -1 : iw * 0.5;
  var best = null;
  var bestArea = 0;
  for (var i = 0; cur && i < 14; i++) {
    var r = cur.getBoundingClientRect();
    if (r.width > 200 && r.width < iw * 0.48 && r.left > lo && r.top > 40) {
      var s = window.getComputedStyle(cur);
      if (parseBgAlpha(s.backgroundColor) > 0) {
        var area = r.width * r.height;
        if (area > bestArea) { best = cur; bestArea = area; }
      }
    }
    cur = cur.parentElement;
  }
  return best;
}

function findSurfaces() {
  var res = { left: null, right: null };
  var all = document.querySelectorAll('button, a, [role="button"], [tabindex], h2, h3');
  for (var i = 0; i < all.length; i++) {
    var lb = labelOf(all[i]).trim().toLowerCase();
    if (lb !== 'tasks' && lb !== 'notes' && lb !== 'chats' && lb !== 'chat') { continue; }
    var r = all[i].getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) { continue; }
    try { if (all[i].closest('[data-theme-lock]')) { continue; } } catch (e) {}
    if (!res.left && (lb === 'tasks' || lb === 'notes')) { res.left = firstPanelCandidate(all[i], 'left'); }
    if (!res.right && (lb === 'chats' || lb === 'chat')) { res.right = firstPanelCandidate(all[i], 'right'); }
    if (res.left && res.right) { break; }
  }
  return res;
}

function recolorSurfaces(id) {
  if (id === 'akki' || !document.body) { return; }
  var pal = PALS[id] || PALS.akki;
  if (!pal) { return; }
  var surf = findSurfaces();
  var prgb = hexRgb(pal.panel || '#0b141b');
  if (surf.left) {
    var aL = parseBgAlpha(window.getComputedStyle(surf.left).backgroundColor);
    var aLv = (aL >= 0.3) ? aL : 0.85;
    cacheOrig(surf.left, 'prop:background-color', surf.left.style.getPropertyValue('background-color'));
    surf.left.style.setProperty('background-color', 'rgba(' + prgb[0] + ', ' + prgb[1] + ', ' + prgb[2] + ', ' + aLv.toFixed(3) + ')');
  }
  if (surf.right) {
    var aR = parseBgAlpha(window.getComputedStyle(surf.right).backgroundColor);
    var aRv = (aR >= 0.3) ? aR : 0.85;
    cacheOrig(surf.right, 'prop:background-color', surf.right.style.getPropertyValue('background-color'));
    surf.right.style.setProperty('background-color', 'rgba(' + prgb[0] + ', ' + prgb[1] + ', ' + prgb[2] + ', ' + aRv.toFixed(3) + ')');
  }
  if (!state.orbs || state.orbs.length === 0) { try { state.orbs = findOrbStages(); } catch (e) {} }
  for (var i = 0; i < state.orbs.length; i++) {
    var el = state.orbs[i];
    if (!el || !el.style) { continue; }
    cacheOrig(el, 'prop:background', el.style.getPropertyValue('background'));
    el.style.setProperty('background', 'radial-gradient(circle, ' + pal.accent + ' 0%, transparent 70%)');
  }
}

// ── Thinking Orb canvas particles + glow (color-only theme mapping) ───────────
var __canvasHookState = { installed: false, lastFill: '', lastStroke: '', lastStop: '' };

function canvasAccentColor() {
  if (state.current === 'akki') { return null; }
  var pal = PALS[state.current];
  if (!pal || !pal.accent) { return null; }
  return pal.accent;
}

function canvasTranslate(color) {
  if (typeof color !== 'string' || !color) { return null; }
  var acc = canvasAccentColor();
  if (!acc) { return null; }
  var rgb = hexRgb(acc);
  var cn = rgb.join(', ');
  var cnC = rgb.join(',');
  var cnS = rgb.join(' ');
  var out = color;
  var hit = false;
  if (/^#00e5ff$/i.test(out) || /^#0ff$/i.test(out)) { out = acc; hit = true; }
  if (/^#ffd600$/i.test(out)) { out = acc; hit = true; }
  if (/^#fff(fff)?$/i.test(out)) { out = acc; hit = true; }
  if (/#00[eE]5[fF]{2}/g.test(out) && !/^#/.test(out)) { out = out.replace(/#00[eE]5[fF]{2}/g, acc); hit = true; }
  if (/^\s*cyan\s*$/i.test(out)) { out = 'rgb(' + cn + ')'; hit = true; }
  if (out.indexOf('rgba(0, 229, 255,') > -1 || out.indexOf('rgba(0,229,255,') > -1) {
    out = out.split('rgba(0, 229, 255,').join('rgba(' + cn + ',').split('rgba(0,229,255,').join('rgba(' + cnC + ',');
    hit = true;
  }
  if (out.indexOf('rgba(255, 255, 255,') > -1 || out.indexOf('rgba(255,255,255,') > -1) {
    out = out.split('rgba(255, 255, 255,').join('rgba(' + cn + ',').split('rgba(255,255,255,').join('rgba(' + cnC + ',');
    hit = true;
  }
  if (out.indexOf('rgba(0 229 255') > -1 || out.indexOf('rgb(0 229 255') > -1) {
    out = out.split('rgba(0 229 255').join('rgba(' + cnS).split('rgb(0 229 255').join('rgb(' + cnS);
    hit = true;
  }
  if (out.indexOf('rgb(0, 229, 255)') > -1 || out.indexOf('rgb(0,229,255)') > -1) {
    out = out.split('rgb(0, 229, 255)').join('rgb(' + cn + ')').split('rgb(0,229,255)').join('rgb(' + cnC + ')');
    hit = true;
  }
  if (/^\s*rgb(?:\(255, ?255, ?255\)|\(255 255 255\))\s*$/i.test(out)) { out = 'rgb(' + cn + ')'; hit = true; }
  return hit ? out : null;
}

function installCanvasHook() {
  if (__canvasHookState.installed) { return; }
  __canvasHookState.installed = true;
  try {
    if (window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype) {
      var p = window.CanvasRenderingContext2D.prototype;
      try {
        var dFill = Object.getOwnPropertyDescriptor(p, 'fillStyle');
        if (dFill && dFill.set) {
          Object.defineProperty(p, 'fillStyle', {
            configurable: true, enumerable: !!dFill.enumerable,
            get: dFill.get,
            set: function (v) {
              var t = canvasTranslate(v);
              __canvasHookState.lastFill = { color: v, t: t || null };
              return dFill.set.call(this, t || v);
            }
          });
        }
      } catch (e) {}
      try {
        var dStroke = Object.getOwnPropertyDescriptor(p, 'strokeStyle');
        if (dStroke && dStroke.set) {
          Object.defineProperty(p, 'strokeStyle', {
            configurable: true, enumerable: !!dStroke.enumerable,
            get: dStroke.get,
            set: function (v) {
              var t = canvasTranslate(v);
              __canvasHookState.lastStroke = { color: v, t: t || null };
              return dStroke.set.call(this, t || v);
            }
          });
        }
      } catch (e) {}
    }
  } catch (e) {}
  try {
    if (window.CanvasGradient && window.CanvasGradient.prototype) {
      var gp = window.CanvasGradient.prototype;
      var gOrig = gp.addColorStop;
      if (typeof gOrig === 'function') {
        gp.addColorStop = function (offset, color) {
          var t = canvasTranslate(color);
          __canvasHookState.lastStop = { color: color, t: t || null };
          return gOrig.call(this, offset, t || color);
        };
      }
    }
  } catch (e) {}
}

// ── Graph + Orb detection ─────────────────────────────────────────────────────
function ownText(el) {
  var t = '';
  for (var i = 0; i < el.childNodes.length; i++) {
    var n = el.childNodes[i];
    if (n.nodeType === 3) { t += n.nodeValue; }
  }
  return t.trim();
}

function labelOf(el) {
  var t = ownText(el);
  if (t) { return t; }
  for (var i = 0; i < el.children.length; i++) {
    t = ownText(el.children[i]);
    if (t) { return t; }
  }
  return el.textContent || '';
}

function commonAncestor(a, b) {
  var s = new Set();
  var n = a;
  while (n) { s.add(n); n = n.parentElement; }
  n = b;
  while (n) { if (s.has(n)) { return n; } n = n.parentElement; }
  return null;
}

function findGraphRoot() {
  var WANT = ['memory', 'soul', 'skills', 'settings'];
  var found = [];
  var all = document.querySelectorAll('button, a, [role="button"], [tabindex]');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var lb = labelOf(el).toLowerCase();
    if (WANT.indexOf(lb) === -1) { continue; }
    var r = el.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) { continue; }
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    if (Math.abs(cx - window.innerWidth / 2) > window.innerWidth * 0.38) { continue; }
    if (Math.abs(cy - window.innerHeight / 2) > window.innerHeight * 0.45) { continue; }
    found.push(el);
  }
  if (found.length < 3) { return null; }
  var anc = found[0];
  for (var j = 1; j < found.length; j++) {
    anc = commonAncestor(anc, found[j]);
    if (!anc) { return null; }
  }
  if (anc === document.body || anc === document.documentElement) { return null; }
  var b = anc.getBoundingClientRect ? anc.getBoundingClientRect() : null;
  if (b && (b.width >= window.innerWidth * 0.9 || b.height >= window.innerHeight * 0.9)) { return null; }
  return anc;
}

function findOrbStages() {
  var res = [];
  var sweeps = document.querySelectorAll('.scanline, [class*="scanline"]');
  for (var i = 0; i < sweeps.length; i++) {
    var el = sweeps[i];
    var stage = el;
    var a = el;
    for (var k = 0; k < 8 && a; k++) {
      var cs = null;
      try { cs = getComputedStyle(a); } catch (e) {}
      if (cs && cs.backgroundImage && cs.backgroundImage.indexOf('radial') > -1) { stage = a; break; }
      a = a.parentElement;
    }
    if (stage && stage.hasAttribute && !stage.hasAttribute('data-theme-orb') && res.indexOf(stage) < 0) { res.push(stage); }
  }
  var seq = 0;
  var all = document.querySelectorAll('*');
  for (var j = 0; j < all.length; j++) {
    var e2 = all[j];
    if (!e2.getBoundingClientRect) { continue; }
    try { if (e2.closest && e2.closest('[data-theme-lock]')) { continue; } } catch (e) {}
    if (e2.hasAttribute && e2.hasAttribute('data-theme-orb')) { continue; }
    var cs2 = null;
    try { cs2 = getComputedStyle(e2); } catch (e) {}
    if (!cs2 || !cs2.backgroundImage || cs2.backgroundImage.indexOf('radial') < 0) { continue; }
    var r = e2.getBoundingClientRect();
    if (!r || r.width < 70 || r.height < 70) { continue; }
    if (r.top > window.innerHeight * 0.62) { continue; }
    res.push(e2);
    if (++seq > 40) { break; }
  }
  return res;
}

function ensureGraphMarkers() {
  if (!state.graph) { state.graph = findGraphRoot(); }
  if (state.graph && !state.graph.hasAttribute('data-theme-lock')) {
    state.graph.setAttribute('data-theme-lock', '1');
  }
  var live = 0;
  try { live = document.querySelectorAll('[data-theme-orb]').length; } catch (e) {}
  if (live === 0) {
    state.orbs = findOrbStages();
    for (var i = 0; i < state.orbs.length; i++) {
      if (!state.orbs[i].hasAttribute('data-theme-orb')) { state.orbs[i].setAttribute('data-theme-orb', '1'); }
    }
  }
}

function clearMarkers() {
  if (state.graph && state.graph.hasAttribute('data-theme-lock')) { state.graph.removeAttribute('data-theme-lock'); }
  for (var i = 0; i < state.orbs.length; i++) {
    if (state.orbs[i] && state.orbs[i].hasAttribute('data-theme-orb')) { state.orbs[i].removeAttribute('data-theme-orb'); }
  }
}

// ── CSS brace scanner (for the stock lock sheet) ──────────────────────────────
function scanCss(css) {
  var out = [];
  var stack = [];
  var buf = '';
  var i = 0, n = css.length;
  while (i < n) {
    var c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      buf += '/*'; i += 2;
      while (i < n) {
        if (css[i] === '*' && css[i + 1] === '/') { buf += '*/'; i += 2; break; }
        buf += css[i]; i++;
      }
      continue;
    }
    if (c === '{') {
      var head = buf; buf = '';
      var m = /^@([a-z-]+)/i.exec(head.trim());
      var name = m ? m[1].toLowerCase() : '';
      if (name && (name === 'media' || name === 'supports' || name === 'layer' || name === 'container' || name === 'keyframes' || name === '-webkit-keyframes')) {
        stack.push(head.trim().replace(/{\\s*$/, ''));
        i++; continue;
      }
      if (name) {
        var depth = 1; i++;
        while (i < n) {
          var cc = css[i];
          if (cc === '{') { depth++; }
          else if (cc === '}') { depth--; if (depth === 0) { break; } }
          i++;
        }
        i++; continue;
      }
      var body = ''; var d2 = 1; i++;
      while (i < n) {
        var c2 = css[i];
        if (c2 === '{') { d2++; }
        else if (c2 === '}') { d2--; if (d2 === 0) { break; } }
        else if (c2 !== '\\n' && c2 !== '\\r') { body += c2; }
        i++;
      }
      var sel = head.trim();
      if (sel && sel.indexOf(':root') < 0) { out.push({ sel: sel, body: body, wrappers: stack.slice() }); }
      i++;
      continue;
    }
    if (c === '}') { if (stack.length) { stack.pop(); } i++; continue; }
    if (c === ';') { buf = ''; i++; continue; }
    buf += c;
    i++;
  }
  return out;
}

var _PARSED_RULES = null;
function parseRules() {
  if (!_PARSED_RULES) { _PARSED_RULES = scanCss(BASE); }
  return _PARSED_RULES;
}

function buildFullSheet(pal) {
  if (!pal) { return ''; }
  var rules = parseRules();
  var out = '';
  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    var b = swapText(r.body, pal);
    if (b === r.body) { continue; }
    out += wrapRule(r.sel + '{' + b + '}', r.wrappers);
  }
  return out;
}

function splitCommas(sel) {
  var parts = [], depth = 0, cur = '';
  for (var i = 0; i < sel.length; i++) {
    var c = sel[i];
    if (c === '(' || c === '[') { depth++; }
    else if (c === ')' || c === ']') { depth--; }
    else if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function stripTest(p) {
  var test = p;
  var di = test.indexOf('::');
  if (di > -1) { test = test.slice(0, di); }
  var out = '', z = 0;
  for (var k = 0; k < test.length; k++) {
    var ch = test[k];
    if (ch === '(' || ch === '[') { z++; }
    else if (ch === ')' || ch === ']') { z--; }
var isEscaped = (ch === ':' && z === 0 && k > 0 && test.charCodeAt(k - 1) === 92);
    out += (ch === ':' && z === 0 && !isEscaped) ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function lastCompound(p) {
  var depth = 0, last = 0;
  for (var i = 0; i < p.length; i++) {
    var ch = p[i];
    if (ch === '(' || ch === '[') { depth++; }
    else if (ch === ')' || ch === ']') { depth--; }
    else if (depth === 0 && (ch === '>' || ch === '+' || ch === '~')) { last = i + 1; }
  }
  return p.slice(last).trim().replace(/^[>+~\\s]+/, '');
}

function matchInfo(sel, root) {
  var inside = false, selfParts = [];
  var parts = splitCommas(sel);
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (!p) { continue; }
    var test = stripTest(p);
    if (!test) { inside = true; continue; }
    try {
      if (root.querySelectorAll(test).length > 0) { inside = true; }
      if (root.matches(test)) { inside = true; selfParts.push(p); }
    } catch (e) { inside = true; }
  }
  return { inside: inside, selfParts: selfParts };
}

function attachTip(p) {
  var T = ':where(:not([data-theme-orb]), :not([data-theme-orb] *))';
  var di = p.indexOf('::');
  if (di > -1) { return p.slice(0, di) + T + p.slice(di); }
  return p + T;
}

function scopeRule(sel, root) {
  var parts = splitCommas(sel);
  var a = [], b = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (!p) { continue; }
    a.push('[data-theme-lock] ' + attachTip(p));
    var test = stripTest(p);
    var selfMatch = false;
    if (test) { try { selfMatch = root.matches(test); } catch (e) {} }
    if (selfMatch) {
      var comp = lastCompound(p);
      if (comp) { b.push('[data-theme-lock]' + attachTip(comp)); }
    }
  }
  return a.concat(b).join(',');
}

function wrapRule(rule, wrappers) {
  var s = '';
  for (var w = wrappers.length - 1; w >= 0; w--) { s += wrappers[w] + '{'; }
  s += rule;
  for (var w2 = 0; w2 < wrappers.length; w2++) { s += '}'; }
  return s;
}

var LAYOUT_PROPS = {};
[
  'width','height','min-width','max-width','min-height','max-height',
  'margin','margin-top','margin-right','margin-bottom','margin-left',
  'padding','padding-top','padding-right','padding-bottom','padding-left',
  'gap','row-gap','column-gap',
  'position','top','right','bottom','left','inset','inset-block','inset-inline',
  'display','z-index','flex','flex-direction','flex-wrap','flex-flow','flex-basis','flex-grow','flex-shrink','order',
  'grid','grid-template','grid-template-columns','grid-template-rows','grid-template-areas','grid-auto-rows','grid-auto-columns','grid-auto-flow','grid-column','grid-row','grid-area',
  'justify-content','justify-items','justify-self','align-content','align-items','align-self','place-content','place-items','place-self',
  'transform','transform-origin','translate','rotate','scale',
  'transition','transition-property','transition-duration','transition-timing-function','transition-delay',
  'animation','animation-name','animation-duration','animation-timing-function','animation-delay','animation-iteration-count','animation-direction','animation-fill-mode',
  'overflow','overflow-x','overflow-y','float','clear',
  'object-fit','object-position','aspect-ratio','box-sizing','contain','content-visibility','will-change','resize','vertical-align','line-height','font-size','letter-spacing','white-space'
].forEach(function (p) { LAYOUT_PROPS[p] = 1; });

function stripLayoutDecls(body) {
  var keep = [];
  var decls = String(body).split(';');
  for (var i = 0; i < decls.length; i++) {
    var d = decls[i].trim();
    if (!d) { continue; }
    var ci = d.indexOf(':');
    if (ci < 0) { continue; }
    var prop = d.slice(0, ci).trim().toLowerCase();
    if (LAYOUT_PROPS[prop]) { continue; }
    keep.push(d);
  }
  return keep.join(';');
}

function buildLockSheet(root) {
  var rules = scanCss(BASE);
  var out = '';
  for (var i = 0; i < rules.length; i++) {
    try {
      var r = rules[i];
      var info = matchInfo(r.sel, root);
      if (!info.inside) { continue; }
      var scoped = scopeRule(r.sel, root);
      if (!scoped) { continue; }
      var body = stripLayoutDecls(r.body);
      if (!body) { continue; }
      out += wrapRule(scoped + '{' + body + '}', r.wrappers);
    } catch (e) { continue; }
  }
  return out;
}

function ensureLockSheet(id) {
  if (!state.graph || !BASE || state.lockFor === id) { return; }
  var css = buildLockSheet(state.graph);
  if (css) {
    state.lockFor = id;
    setStyle(LOCK_ID, css);
  } else if (state.lockFor) {
    state.lockFor = '';
    removeStyle(LOCK_ID);
  }
}

function ensureInlinePass(id) {
  if (id === 'akki' || !document.body) { return; }
  runInlineSwap();
}

// ── Titlebar controller ───────────────────────────────────────────────────────
function findTitlebarBar() {
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    var rs = null;
    try { rs = getComputedStyle(e); } catch (err) { continue; }
    if (!rs || rs.webkitAppRegion !== 'drag') { continue; }
    var r = e.getBoundingClientRect();
    if (!r || r.height < 34 || r.height > 60 || r.top > 14) { continue; }
    if (r.width < window.innerWidth * 0.7) { continue; }
    return e;
  }
  return null;
}

function currentAccent() {
  var pal = PALS[state.current];
  return pal ? pal.accent : '#00E5FF';
}

function currentAccentAlpha(a) {
  var pal = PALS[state.current];
  var h = pal ? pal.accent : '#00E5FF';
  var rgb = hexRgb(h);
  return 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ', ' + a + ')';
}

function refreshButton() {
  var b = document.getElementById(BTN_ID);
  if (b) {
    b.style.color = currentAccent();
    b.style.background = currentAccentAlpha(0.18);
    b.style.border = '1px solid ' + currentAccentAlpha(0.45);
  }
}

function openMenu(anchor) {
  if (document.getElementById(MENU_ID)) { closeMenu(); return; }
  var accent = currentAccent();
  var menu = document.createElement('div');
  menu.id = MENU_ID;
  menu.style.cssText = 'position:fixed;z-index:999999;min-width:200px;background:#0b141b;border:1px solid ' + accent + '3d;border-radius:10px;padding:6px;box-shadow:0 12px 30px rgba(0,0,0,.55), 0 0 22px ' + accent + '26;-webkit-app-region:no-drag;pointer-events:auto';
  var r = anchor.getBoundingClientRect();
  menu.style.top = (r.bottom + 6) + 'px';
  menu.style.right = (window.innerWidth - r.right) + 'px';
  for (var i = 0; i < REG.length; i++) {
    var t = REG[i];
    var row = document.createElement('button');
    row.type = 'button';
    row.style.cssText = 'display:flex;align-items:center;gap:9px;width:100%;padding:7px 10px;border-radius:7px;background:transparent;border:none;cursor:pointer;color:#fff;font-size:12px;text-align:left';
    row.onmouseenter = function () { this.style.background = 'rgba(255,255,255,.06)'; };
    row.onmouseleave = function () { this.style.background = 'transparent'; };
    var dot = document.createElement('span');
    dot.style.cssText = 'width:12px;height:12px;border-radius:50%;background:' + t.accent + ';flex:0 0 auto;' + (t.id === state.current ? 'box-shadow:0 0 8px ' + t.accent : '');
    var lb = document.createElement('span');
    lb.style.cssText = 'flex:1;color:#fff';
    lb.textContent = t.name;
    row.appendChild(dot);
    row.appendChild(lb);
    if (t.id === state.current) {
      var chk = document.createElement('span');
      chk.textContent = '\u2713';
      chk.style.color = t.accent;
      row.appendChild(chk);
    }
    (function (id) {
      row.onclick = function () { closeMenu(); selectTheme(id); };
    })(t.id);
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
}

function closeMenu() {
  var m = document.getElementById(MENU_ID);
  if (m && m.parentNode) { m.parentNode.removeChild(m); }
}

function buildThemeButton() {
  var b = document.createElement('button');
  b.type = 'button';
  b.id = BTN_ID;
  b.title = 'Theme';
  b.setAttribute('aria-label', 'Theme');
  b.className = 'akki-theme-btn no-drag';
  b.style.webkitAppRegion = 'no-drag';
  b.style.cursor = 'pointer';
  b.style.zIndex = '95';
  b.style.display = 'inline-flex';
  b.style.alignItems = 'center';
  b.style.justifyContent = 'center';
  b.style.width = '32px';
  b.style.height = '32px';
  b.style.borderRadius = '9px';
  b.style.color = currentAccent();
  b.style.background = currentAccentAlpha(0.18);
  b.style.border = '1px solid ' + currentAccentAlpha(0.45);
  b.style.boxShadow = '0 0 14px rgba(0, 0, 0, 0.4)';
  b.innerHTML = PALETTE_SVG;
  b.addEventListener('click', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    try { openMenu(b); } catch (e) {}
  });
  return b;
}

function findWindowControlsSpacer(bar) {
  if (!bar || !bar.children) { return null; }
  var barR = bar.getBoundingClientRect();
  for (var i = bar.children.length - 1; i >= 0; i--) {
    var c = bar.children[i];
    if (c.offsetHeight >= 20) { continue; }
    var w = c.offsetWidth || 0;
    if (w < 110 || w > 220) { continue; }
    var st = (c.getAttribute && c.getAttribute('style')) || '';
    if (!/width\s*:\s*\d+px/i.test(st)) { continue; }
    var r = c.getBoundingClientRect();
    if (Math.abs(barR.right - r.right) < 40) { return c; }
  }
  return null;
}

function wcoRightInset() {
  try {
    var wco = (navigator.windowControlsOverlay && typeof navigator.windowControlsOverlay.getTitlebarAreaRect === 'function')
      ? navigator.windowControlsOverlay.getTitlebarAreaRect()
      : null;
    if (wco && (wco.width || 0) > 0) {
      return Math.max(2, Math.round(window.innerWidth - (wco.x + wco.width) + 160));
    }
  } catch (e) {}
  return null;
}

function ensureTitlebarButton() {
  if (document.getElementById(BTN_ID)) { return true; }
  var bar = findTitlebarBar();
  if (!bar) { return false; }
  var b = buildThemeButton();
  var spacer = findWindowControlsSpacer(bar);
  var rightInset = wcoRightInset();
  b.style.position = 'absolute';
  b.style.top = Math.max(4, Math.round((bar.getBoundingClientRect().height - 32) / 2)) + 'px';
  if (rightInset !== null) {
    b.style.right = rightInset + 'px';
  } else if (spacer) {
    var sr = spacer.getBoundingClientRect();
    b.style.right = Math.max(2, Math.round(window.innerWidth - sr.left + 160)) + 'px';
  } else {
    b.style.right = '158px';
  }
  bar.appendChild(b);
  try { refreshButton(); } catch (e) {}
  return true;
}

// ── Apply / switch / cycle ────────────────────────────────────────────────────
function applyCore(id) {
  state.current = id;
  if (id === 'akki') {
    removeStyle(FULL_ID);
    removeStyle(LOCK_ID);
    clearThemeAttr();
    restoreInlines();
    clearMarkers();
    clearStartAI();
    refreshButton();
    return;
  }
  var pal = PALS[id];
  if (!pal) { pal = PALS.akki; }
  setStyle(FULL_ID, buildFullSheet(pal));
  setThemeAttr(id);
  ensureComponentTasks(id);
  refreshButton();
}

function ensureComponentTasks(id) {
  if (id === 'akki') { try { ensureTitlebarButton(); } catch (e) {} return; }
  try { ensureGraphMarkers(); } catch (e) {}
  try { ensureLockSheet(id); } catch (e) {}
  try { ensureInlinePass(id); } catch (e) {}
  try { forceStartAI(id); } catch (e) {}
  try { recolorSurfaces(id); } catch (e) {}
  try { ensureTitlebarButton(); } catch (e) {}
  try { refreshButton(); } catch (e) {}
}

function selectTheme(id) {
  if (!PALS[id]) { id = 'akki'; }
  if (state.current === id) { applyCore(id); return; }
  try {
    if (window.electronAPI && window.electronAPI.invoke) {
      window.electronAPI.invoke('set-theme', id).catch(function () {});
    }
  } catch (e) {}
  applyCore(id);
}

function startObservers() {
  try {
    var iv = setInterval(function () {
      try { ensureComponentTasks(state.current); } catch (e) {}
    }, 800);
    setTimeout(function () { clearInterval(iv); }, 20000);
  } catch (e) {}
  try {
    var last = 0;
    var mo = new MutationObserver(function () {
      var now = Date.now();
      if (now - last < 300) { return; }
      last = now;
      try { ensureComponentTasks(state.current); } catch (e) {}
    });
    mo.observe(document.body, { childList: true, subtree: true });
  } catch (e) {}
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { try { closeMenu(); } catch (err) {} } });
  document.addEventListener('mousedown', function (e) {
    var m = document.getElementById(MENU_ID);
    if (!m) { return; }
    if (m.contains(e.target)) { return; }
    if (e.target && e.target.id === BTN_ID) { return; }
    try { closeMenu(); } catch (err) {}
  });
}

// ── Splash deferral ───────────────────────────────────────────────────────────
// The React splash/loading screen shares this document and its CSS tokens.
// Applying a non-default theme while it is visible repaints the splash with
// theme colors (e.g. crimson-neon's dark-red surfaces). So the saved theme is
// resolved up-front but only APPLIED after the splash finishes.
//
// Splash-end detection (v3) tracks the intro <video>'s real lifecycle:
//   1. Snapshot the video element(s) present during the first ~5s (the splash
//      video). Videos appearing later (ambient loops etc.) are ignored.
//   2. Done when every snapshot video has ended or left the DOM (2 consecutive
//      confirms), or no video ever appears within 5s (skipped splash), or the
//      main process broadcasts 'force-transition', or a 60s hard cap (last
//      resort only — longer than any plausible intro video).
// NOTE: notifyAppReady() is NOT used — its inline 2s fallback timer fires
// mid-splash and would apply the theme early. Until completion state stays
// 'akki' so the splash renders stock cyan/black.
var SPLASH = { pendingId: null, timer: null, done: false, confirm: 0, startedAt: 0, snapshot: [], listenersBound: false };

function completeSplashTheme() {
  if (SPLASH.done) { return; }
  SPLASH.done = true;
  if (SPLASH.timer) { clearInterval(SPLASH.timer); SPLASH.timer = null; }
  var id = SPLASH.pendingId || 'akki';
  if (!PALS[id]) { id = 'akki'; }
  try { state.current = id; applyCore(id); } catch (e) {}
  try { startObservers(); } catch (e) {}
}

function armSplashListener() {
  if (SPLASH.listenersBound) { return; }
  SPLASH.listenersBound = true;
  try {
    if (window.electronAPI && typeof window.electronAPI.on === 'function') {
      window.electronAPI.on('force-transition', function () { completeSplashTheme(); });
    }
  } catch (e) {}
}

function splashWaitTick() {
  var elapsed = Date.now() - SPLASH.startedAt;
  if (elapsed >= 60000) { completeSplashTheme(); return; }
  var vs;
  try { vs = Array.prototype.slice.call(document.querySelectorAll('video')); } catch (e) { vs = []; }
  if (!SPLASH.snapshot.length) {
    if (vs.length) { SPLASH.snapshot = vs; }
    else if (elapsed >= 5000) { completeSplashTheme(); }
    return;
  }
  var allDone = true;
  for (var i = 0; i < SPLASH.snapshot.length; i++) {
    var v = SPLASH.snapshot[i];
    if (!v.ended && v.isConnected) { allDone = false; break; }
  }
  if (allDone) {
    SPLASH.confirm++;
    if (SPLASH.confirm >= 2) { completeSplashTheme(); }
  } else {
    SPLASH.confirm = 0;
  }
}

function startSplashWait() {
  if (SPLASH.timer || SPLASH.done) { return; }
  SPLASH.startedAt = Date.now();
  SPLASH.confirm = 0;
  SPLASH.snapshot = [];
  SPLASH.timer = setInterval(splashWaitTick, 300);
}

function boot() {
  try { installCanvasHook(); } catch (e) {}
  armSplashListener();
  function holdForSplash(id) {
    if (!PALS[id]) { id = 'akki'; }
    SPLASH.pendingId = id;
    startSplashWait();
  }
  try {
    if (window.electronAPI && window.electronAPI.invoke) {
      window.electronAPI.invoke('get-theme').then(function (id) { holdForSplash(id); })
        .catch(function () { holdForSplash('akki'); });
      setTimeout(function () { if (!SPLASH.pendingId) { holdForSplash('akki'); } }, 3000);
    } else {
      holdForSplash('akki');
    }
  } catch (e) { holdForSplash('akki'); }
}

// Public debug / QA hook
window.__akkiTheme = {
  apply: function (id) { try { selectTheme(id); } catch (e) {} },
  open: function () { try { var b = document.getElementById(BTN_ID); if (b) { openMenu(b); } } catch (e) {} },
  current: function () { return state.current; },
  ids: IDS.slice(),
  force: function (id) {
    try {
      var tid = id || state.current;
      if (tid !== 'akki') {
        ensureGraphMarkers();
        ensureLockSheet(tid);
        ensureInlinePass(tid);
        forceStartAI(tid);
      }
      ensureTitlebarButton();
    } catch (e) {}
  },
  debug: function () {
    var full = document.getElementById(FULL_ID);
    var lockE = document.getElementById(LOCK_ID);
    return {
      baseLen: BASE ? BASE.length : 0,
      parsedRules: parseRules().length,
      fullLen: full ? full.textContent.length : 0,
      lockSheetLen: lockE ? lockE.textContent.length : 0,
      hasFull: !!(full && full.textContent),
      hasLock: !!(lockE && lockE.textContent),
      graph: !!state.graph,
      lockMarked: document.querySelectorAll('[data-theme-lock]').length,
      orbs: state.orbs.length,
      orbMarked: document.querySelectorAll('[data-theme-orb]').length,
      startAI: (function () {
        var all = document.querySelectorAll('button, a, [role="button"]');
        for (var i = 0; i < all.length; i++) {
          if (all[i].__akkiStartAI) {
            return {
              bg: all[i].style.backgroundColor,
              border: all[i].style.borderColor,
              color: all[i].style.color
            };
          }
        }
        return null;
      })(),
      startsAt: (function () {
        var all = document.querySelectorAll('[data-theme-orb], canvas');
        var out = [];
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.tagName === 'CANVAS') { out.push(el.getBoundingClientRect().width + 'x' + el.getBoundingClientRect().height); }
        }
        return out;
      })(),
      canvas: { hook: __canvasHookState.installed, lastFill: __canvasHookState.lastFill, lastStroke: __canvasHookState.lastStroke, lastStop: __canvasHookState.lastStop },
      current: state.current,
      surfaces: (function () {
        try {
          var s = findSurfaces();
          var rec = function (el) {
            if (!el) { return null; }
            var cs = window.getComputedStyle(el);
            var r = el.getBoundingClientRect();
            return { bg: cs.backgroundColor, r: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) } };
          };
          return { left: rec(s.left), right: rec(s.right) };
        } catch (e) { return { err: String(e && e.message) }; }
      })(),
      up_orbs: (function () {
        var o = [];
        for (var i = 0; i < state.orbs.length; i++) {
          var el = state.orbs[i];
          if (!el) { continue; }
          var st = el.style && el.style.background ? el.style.background : window.getComputedStyle(el).background;
          o.push({ bg: String(st).slice(0, 90), inline: !!(el.style && el.style.background) });
        }
        return o;
      })(),
      geo: (function () {
        var out = {};
        var rect = function (el) {
          if (!el) { return null; }
          var r = el.getBoundingClientRect();
          return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
        };
        try { out.graph = rect(state.graph); } catch (e) {}
        try {
          out.locks = [];
          var ls = document.querySelectorAll('[data-theme-lock]');
          for (var i = 0; i < ls.length; i++) { out.locks.push(rect(ls[i])); }
        } catch (e) {}
        try {
          out.orbs = [];
          for (var j = 0; j < state.orbs.length; j++) { out.orbs.push(rect(state.orbs[j])); }
        } catch (e) {}
        try { var s = findSurfaces(); out.surfaceL = rect(s.left); out.surfaceR = rect(s.right); } catch (e) {}
        try { var n = document.querySelector('nav'); out.nav = rect(n); } catch (e) {}
        out.w = window.innerWidth;
        return out;
      })()
    };
  },
  lockBuild: function () {
    var root = document.querySelector('[data-theme-lock]') || state.graph;
    if (!root) { return { root: false }; }
    var res = { root: true, cls: String(root.className).slice(0, 80) };
    try {
      var css = buildLockSheet(root);
      res.len = css.length;
      res.head = css.slice(0, 90);
    } catch (e) { res.err = String(e && e.message); }
    return res;
  }
};

boot();
`;

  return '(function () {\nvar __AKKI_THEME_DATA__ = ' + payload + ';\n' + body + '\n})();';
}

const THEME_ENGINE_SCRIPT = buildEngineScript();

module.exports = { THEME_ENGINE_SCRIPT, THEME_REGISTRY, THEME_IDS };