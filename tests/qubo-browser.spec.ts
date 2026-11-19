import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, firefox, webkit, type BrowserType } from 'playwright-core';

const baseURL = process.env.QUBO_TEST_URL ?? 'http://127.0.0.1:4173';
const engines: [string, BrowserType][] = [
  ['Chromium', chromium],
  ['Firefox', firefox],
  ['WebKit', webkit],
];

for (const [engineName, engine] of engines) {
  test(`${engineName}: Qubo loads, renders, and accepts mouse input`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.route('https://telegram.org/**', route => route.abort());
      await page.goto(`${baseURL}/qubo/`, { waitUntil: 'domcontentloaded' });
      await page.locator('#play-btn').waitFor({ state: 'visible' });
      await page.locator('#play-btn').click();
      const canvas = page.locator('#stage');
      await canvas.waitFor({ state: 'visible' });
      await page.waitForTimeout(100);
      await canvas.click({ position: { x: 180, y: 210 } });
      await page.waitForTimeout(350);
      const canvasState = await canvas.evaluate((element: HTMLCanvasElement) => {
        const context = element.getContext('2d');
        if (!context) return { width: element.width, height: element.height, pixels: 0 };
        const pixels = context.getImageData(0, 0, element.width, element.height).data;
        let nonTransparent = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) nonTransparent++;
        return { width: element.width, height: element.height, pixels: nonTransparent };
      });
      assert.ok(canvasState.width > 0 && canvasState.height > 0, 'canvas has a drawing surface');
      assert.ok(canvasState.pixels > 100, 'canvas contains rendered game pixels');
      assert.deepEqual(pageErrors, [], 'no uncaught page errors');
    } finally {
      await browser.close();
    }
  });

  test(`${engineName}: Qubo responds in a touch-sized viewport`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: engineName === 'Chromium',
      });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.route('https://telegram.org/**', route => route.abort());
      await page.goto(`${baseURL}/qubo/`, { waitUntil: 'domcontentloaded' });
      await page.locator('#play-btn').waitFor({ state: 'visible' });
      await page.locator('#play-btn').tap();
      const canvas = page.locator('#stage');
      await canvas.waitFor({ state: 'visible' });
      await page.waitForTimeout(100);
      await canvas.tap({ position: { x: 180, y: 210 } });
      await page.waitForTimeout(350);
      const bounds = await canvas.boundingBox();
      assert.ok(bounds && bounds.width > 200 && bounds.height > 200, 'game canvas fits the mobile viewport');
      assert.deepEqual(pageErrors, [], 'no uncaught page errors');
      await context.close();
    } finally {
      await browser.close();
    }
  });

  test(`${engineName}: Telegram WebView diagnostics page reports browser and rendering capabilities`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: engineName === 'Chromium',
      });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(`${baseURL}/tests/telegram-webview-diagnostics.html`, { waitUntil: 'domcontentloaded' });
      await page.locator('#report').waitFor({ state: 'visible' });
      await page.waitForFunction(() => {
        const value = (document.querySelector('#report') as HTMLTextAreaElement | null)?.value;
        return !!value && value.includes('requestAnimationFrameSamples');
      }, { timeout: 10000 });
      const report = JSON.parse(await page.locator('#report').inputValue());
      assert.ok(report.userAgent.length > 0, 'user agent is reported');
      assert.ok(report.rendering.requestAnimationFrameSamples >= 100, 'frame timing samples are collected');
      assert.equal(typeof report.rendering.canvas2DReadback, 'boolean');
      await page.locator('#touch').tap();
      await page.waitForFunction(() => document.querySelector('#touchResult')?.textContent?.includes('received'));
      assert.deepEqual(pageErrors, [], 'no uncaught diagnostics page errors');
      await context.close();
    } finally {
      await browser.close();
    }
  });
}
