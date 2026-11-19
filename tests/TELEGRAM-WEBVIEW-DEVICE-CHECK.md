# Telegram Android WebView device check

This is a **manual real-device diagnostic**, separate from the game runtime. It does not modify Qubo gameplay and does not prove that every phone from a manufacturer behaves the same way.

## Run it on a phone

1. On a trusted private Wi-Fi network, start the repository's Vite development server on a computer:
   `npm ci`
   `npm run dev -- --host 0.0.0.0 --port 4173`
2. Find that computer's LAN IPv4 address (for example, `192.168.1.20`).
3. On the Android phone, open a message to yourself in Telegram and open:
   `http://COMPUTER-LAN-IP:4173/tests/telegram-webview-diagnostics.html`
4. Make sure the page opened **inside Telegram**, not Chrome. Wait for the report, tap the touch-test button, then use **Copy report**.
5. Save the report with the phone brand/model, Android version, Telegram version, and date. Repeat for each phone.
6. Stop the Vite server when finished (Ctrl+C).

Only do this on a trusted network: the Vite development server exposes the local project files to devices that can reach that computer. Do not expose it to the public internet.

## What the report tells us

- User agent and detectable Android / Chromium / AppleWebKit version strings.
- Screen and viewport dimensions, device pixel ratio, touch and pointer event support.
- Hardware concurrency and device-memory hints when the browser exposes them.
- A short requestAnimationFrame interval sample, average interval, p50 and p95.
- Canvas 2D rendering/readback support and whether the touch-test button received events.

## Important limitations

- Android does not reliably expose the OEM or exact phone model to a web page. Record the brand/model and Android version separately.
- The Chromium token in the user agent is a useful clue, not a guaranteed exact Android System WebView package version.
- requestAnimationFrame timing is a short sample under current conditions, not a certified display refresh-rate measurement or a long-session performance test.
- This page is not Telegram's internal diagnostic API. It only measures the WebView environment in which it is opened.
- Browser automation in CI cannot emulate Samsung, Xiaomi, Huawei firmware, thermal throttling, GPU drivers, or every Telegram build. Real-device reports are needed for those comparisons.
- This page is not part of the game's normal entry point and no production/preview deployment is created by this test change.
