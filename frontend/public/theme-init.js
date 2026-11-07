// Apply the saved theme before first paint, so there is no flash of the wrong one.
//
// A file rather than an inline <script> in index.html because the server's
// Content-Security-Policy only runs scripts from the app's own origin
// (backend/src/server.js), and it would block an inline one -- every visit would
// then open in the dark theme. index.html loads it with a plain blocking
// <script src> in <head>, which is what still makes it run before the page is
// drawn.
(function () {
  try {
    const urlTheme = new URLSearchParams(window.location.search).get('theme');
    document.documentElement.setAttribute('data-theme', urlTheme || localStorage.getItem('theme') || 'dark');
  } catch { /* private mode / storage blocked: stay on dark */ }
})();
