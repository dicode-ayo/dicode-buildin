// theme-init.js — sets data-theme on <html> before the stylesheet loads to
// avoid a flash of wrong-theme. Loaded as an external <script src> so the
// daemon's CSP (script-src 'self' …, no 'unsafe-inline') doesn't reject it.
(function () {
  try {
    const stored = localStorage.getItem("dicode-theme");
    const theme = stored === "light" || stored === "dark"
      ? stored
      : (globalThis.matchMedia &&
          globalThis.matchMedia("(prefers-color-scheme: light)").matches)
      ? "light"
      : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme;
  } catch {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
