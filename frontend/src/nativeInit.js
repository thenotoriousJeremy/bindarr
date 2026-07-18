// Native shell setup (Capacitor). On Android the WebView renders edge-to-edge
// under the status bar and does NOT populate env(safe-area-inset-top), so the
// app collided with the status icons. Reserve space for the bar (overlay:false)
// and tint it to match the active theme. No-op on web; iOS uses the CSS
// safe-area insets and ignores the Android-only calls (errors swallowed).
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';

const BG = { dark: '#0a0f1d', light: '#eef2f7', lcars: '#000000' };

function applyStatusBar() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
  StatusBar.setStyle({ style: theme === 'light' ? Style.Light : Style.Dark }).catch(() => {});
  StatusBar.setBackgroundColor({ color: BG[theme] || BG.dark }).catch(() => {});
}

if (Capacitor.isNativePlatform()) {
  applyStatusBar();
  // Re-tint when Settings toggles data-theme on <html>.
  new MutationObserver(applyStatusBar).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}
