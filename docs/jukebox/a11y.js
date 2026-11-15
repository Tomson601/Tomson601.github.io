/* Accessibility settings for JukeBox: reduce motion, background intensity, high contrast,
 * larger text and mono sound. Stored in localStorage, applied as classes on <html>, and
 * readable by the other scripts through window.A11Y. Loaded in <head> so the classes are
 * in place before the first paint. */
(() => {
  "use strict";
  const KEY = "jukebox.a11y";
  const S = {
    calm: matchMedia("(prefers-reduced-motion: reduce)").matches,
    bg: "full",          // "full" | "soft" | "off"
    contrast: matchMedia("(prefers-contrast: more)").matches,
    large: false,
    mono: false,
  };
  try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch {}
  const listeners = [];

  function apply() {
    const c = document.documentElement.classList;
    c.toggle("a11y-calm", !!S.calm);
    c.toggle("a11y-contrast", !!S.contrast);
    c.toggle("a11y-large", !!S.large);
    c.toggle("a11y-bg-soft", S.bg === "soft");
    c.toggle("a11y-bg-off", S.bg === "off");
  }

  // reflect the settings into the panel's controls
  function sync() {
    document.querySelectorAll("[data-a11y]").forEach((el) => {
      const k = el.dataset.a11y;
      if (el.type === "checkbox") el.checked = !!S[k];
      else el.setAttribute("aria-checked", String(S[k] === el.dataset.value));
    });
  }

  function set(k, v) {
    if (S[k] === v) return;
    S[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {}
    apply();
    sync();
    listeners.forEach((fn) => fn(k, v));
  }

  apply();

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-a11y]").forEach((el) => {
      if (el.type === "checkbox") el.addEventListener("change", () => set(el.dataset.a11y, el.checked));
      else el.addEventListener("click", () => set(el.dataset.a11y, el.dataset.value));
    });
    const dlg = document.getElementById("a11y");
    const open = () => { sync(); if (!dlg.open) dlg.showModal(); };
    document.getElementById("btn-a11y")?.addEventListener("click", open);
    document.getElementById("a11y-close")?.addEventListener("click", () => dlg.close());
    dlg?.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    sync();
    window.A11Y.open = open;
  });

  // Arrow keys move between the options of any radio group (presets, beats, tempos, segments)
  document.addEventListener("keydown", (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: "first", End: "last" }[e.key];
    const group = dir && e.target.closest?.('[role="radiogroup"]');
    if (!group || e.ctrlKey || e.metaKey || e.altKey) return;
    const radios = [...group.querySelectorAll('[role="radio"]')].filter((r) => !r.disabled && r.offsetParent !== null);
    let i = radios.indexOf(e.target.closest('[role="radio"]'));
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    i = dir === "first" ? 0 : dir === "last" ? radios.length - 1 : (i + dir + radios.length) % radios.length;
    radios[i].focus();
    radios[i].click();
  }, true);

  window.A11Y = {
    get: (k) => S[k],
    set,
    onChange: (fn) => listeners.push(fn),
    open: () => {},
  };
})();
