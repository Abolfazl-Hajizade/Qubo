// Registers the service worker on the web build (the Android app serves every file from the APK) and asks it
// to cache this page's game for offline play first, then the other games in the background.

// First, before anything reads a save: seal localStorage (src/shared/seal.ts).
import './shared/seal';
import { Capacitor } from '@capacitor/core';
import './theme';
import './help';
import { registerSW } from 'virtual:pwa-register';
import { trackPlaytime } from './shared/playtime';

// Every game page counts its own time played, for the stats page (src/shared/playtime.ts).
{
  const parts = location.pathname.slice(import.meta.env.BASE_URL.length).split('/');
  if (parts.length > 1 && parts[0] && parts[0] !== 'howto' && parts[0] !== 'stats' && parts[0] !== 'badges' && parts[0] !== 'leaderboard') trackPlaytime(parts[0]);
}

// Badges are checked on every page, loaded after the page itself (src/shared/badges.ts, celebrate.ts).
addEventListener('load', () => { void import('./shared/celebrate').then((m) => m.startBadges()); }, { once: true });

// Signed in? Keep this device's progress in step with the account (src/shared/sync/engine.ts). Signed out, nothing
// of the sync code is even downloaded.
try {
  if (localStorage.getItem('sync.session')) addEventListener('load', () => { void import('./shared/sync/engine').then((m) => m.initSync());
    void import('./shared/sync/othergame').then((m) => m.initOtherGame());
    void import('./shared/leaderboard/submit').then((m) => m.initLeaderboard());
    void import('./shared/leaderboard/button').then((m) => m.initLeaderboardButton());
  }, { once: true });
} catch { /* storage unavailable */ }

const telegramWebApp = (window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp;
// Telegram Desktop's embedded WebView may not identify itself in the user agent.
// The signed Mini App launch data is a more reliable signal and is present in the URL fragment.
const hasTelegramLaunchData = new URLSearchParams(location.hash.slice(1)).has('tgWebAppData');
const isTelegramWebView = /Telegram/i.test(navigator.userAgent) || !!telegramWebApp?.initData || hasTelegramLaunchData;

if (!Capacitor.isNativePlatform() && 'serviceWorker' in navigator) {
  // Match the mobile Telegram policy on both mobile and desktop: don't let stale PWA caches
  // interfere with repeated Mini App launches.
  if (isTelegramWebView) {
    void navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => { /* service workers may be unavailable in embedded browsers */ });
  } else {
    registerSW({ immediate: true });

    // Game pages live at /<game>/index.html; the home page has no folder.
    const path = location.pathname.slice(import.meta.env.BASE_URL.length).split('/');
    const game = path.length > 1 ? path[0] : undefined;
    // On a metered connection where the player asked to save data, cache only the game they opened.
    const all = !(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;

    navigator.serviceWorker.ready.then((reg) => {
      // Wait for the page to finish loading so background downloads don't compete with it.
      const send = () => reg.active?.postMessage({ type: 'cache-games', game, all });
      if (document.readyState === 'complete') send();
      else addEventListener('load', send, { once: true });
    });
  }
}
