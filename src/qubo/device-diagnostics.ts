type TelegramWebAppInfo = {
  platform?: string;
  version?: string;
  isVersionAtLeast?: (version: string) => boolean;
};

type UserAgentDataLike = {
  brands?: Array<{ brand: string; version: string }>;
  mobile?: boolean;
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
};

const $ = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing diagnostics element: ${id}`);
  return element as T;
};

const dialog = $('device-dialog') as HTMLDialogElement;
const reportElement = $('device-report');
const refreshButton = $('device-refresh') as HTMLButtonElement;
const copyButton = $('device-copy') as HTMLButtonElement;
const touchButton = $('device-touch-test') as HTMLButtonElement;
const touchResult = $('device-touch-result');
const openButton = $('device-check-btn') as HTMLButtonElement;

const telegram = (window as Window & {
  Telegram?: { WebApp?: TelegramWebAppInfo };
}).Telegram?.WebApp;

let latestReport = '';

function detectBrand(ua: string): string {
  const patterns: Array<[RegExp, string]> = [
    [/Samsung|SM-[A-Z0-9]+/i, 'Samsung (UA hint)'],
    [/Xiaomi|Redmi|POCO|MiuiBrowser/i, 'Xiaomi / Redmi / POCO (UA hint)'],
    [/HUAWEI|HONOR/i, 'Huawei / Honor (UA hint)'],
    [/Pixel/i, 'Google Pixel (UA hint)'],
    [/OnePlus/i, 'OnePlus (UA hint)'],
    [/OPPO/i, 'OPPO (UA hint)'],
    [/vivo/i, 'vivo (UA hint)'],
    [/Motorola|Moto/i, 'Motorola (UA hint)'],
    [/Realme/i, 'realme (UA hint)'],
  ];
  return patterns.find(([pattern]) => pattern.test(ua))?.[1] ?? 'Not reliably identifiable';
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

async function collectReport() {
  refreshButton.disabled = true;
  reportElement.textContent = 'Collecting browser and device capabilities…';
  const nav = navigator as Navigator & {
    userAgentData?: UserAgentDataLike;
    deviceMemory?: number;
  };
  const uaData = nav.userAgentData;
  let highEntropy: Record<string, unknown> = {};
  if (uaData?.getHighEntropyValues) {
    try {
      highEntropy = await uaData.getHighEntropyValues([
        'architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList',
      ]);
    } catch {
      highEntropy = {};
    }
  }

  const intervals: number[] = [];
  let previous = 0;
  await new Promise<void>((resolve) => {
    const sample = (time: number) => {
      if (previous) intervals.push(time - previous);
      previous = time;
      if (intervals.length >= 119) resolve();
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const context = canvas.getContext('2d');
  let canvas2d = false;
  let canvasReadback = false;
  if (context) {
    context.fillStyle = '#16a085';
    context.fillRect(0, 0, 8, 8);
    canvas2d = true;
    try {
      canvasReadback = context.getImageData(0, 0, 1, 1).data[3] === 255;
    } catch {
      canvasReadback = false;
    }
  }

  const avg = intervals.length
    ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length
    : 0;
  const p95 = percentile(intervals, 0.95);
  const telegramLine = telegram
    ? `Detected · platform: ${telegram.platform ?? 'unknown'} · WebApp API version: ${telegram.version ?? 'unknown'}`
    : 'Not detected (page may be outside Telegram WebApp)';
  const brands = uaData?.brands?.map((item) => `${item.brand} ${item.version}`).join(', ') ?? 'Unavailable';
  const report = {
    collectedAt: new Date().toISOString(),
    device: {
      brandHint: detectBrand(navigator.userAgent),
      model: highEntropy.model || 'Not exposed by this browser',
      platform: uaData?.platform || navigator.platform || 'Unknown',
      platformVersion: highEntropy.platformVersion || 'Not exposed',
      userAgent: navigator.userAgent,
      userAgentBrands: brands,
      mobileHint: uaData?.mobile ?? matchMedia('(pointer: coarse)').matches,
      language: navigator.language,
      hardwareConcurrency: navigator.hardwareConcurrency || 'Unavailable',
      deviceMemoryGB: nav.deviceMemory ?? 'Unavailable',
    },
    telegram: telegramLine,
    display: {
      screen: `${screen.width} × ${screen.height}`,
      viewport: `${innerWidth} × ${innerHeight}`,
      devicePixelRatio: devicePixelRatio,
      colorDepth: screen.colorDepth,
      maxTouchPoints: navigator.maxTouchPoints,
      touchEvents: 'ontouchstart' in window,
      pointerEvents: 'PointerEvent' in window,
    },
    rendering: {
      animationFramesSampled: intervals.length,
      estimatedAverageFPS: avg ? Number((1000 / avg).toFixed(1)) : 'Unavailable',
      averageFrameIntervalMs: Number(avg.toFixed(2)),
      p95FrameIntervalMs: Number(p95.toFixed(2)),
      canvas2d: canvas2d,
      canvasReadback: canvasReadback,
    },
    notes: [
      'Brand/model and OS version are browser-provided hints, not verified hardware identity.',
      'The FPS sample is a short foreground requestAnimationFrame estimate, not a certified screen refresh rate or long-term performance test.',
      'No diagnostic data is uploaded; this report stays in this page unless you copy and share it.',
    ],
  };

  latestReport = JSON.stringify(report, null, 2);
  reportElement.textContent = latestReport;
  refreshButton.disabled = false;
}

function openDiagnostics() {
  if (!dialog.open) dialog.showModal();
  void collectReport();
}

openButton.addEventListener('click', openDiagnostics);
// The diagnostics remain available to the project owner by adding ?device-diagnostics=1.
// No public-facing button is needed.
if (new URLSearchParams(location.search).get('device-diagnostics') === '1') {
  openDiagnostics();
}
$('device-close').addEventListener('click', () => dialog.close());
refreshButton.addEventListener('click', () => void collectReport());

async function copyReport(): Promise<boolean> {
  if (!latestReport) return false;

  // Clipboard API is unavailable in some Telegram WebViews; try the legacy copy path too.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(latestReport);
      return true;
    }
  } catch {
    // Continue to the compatibility fallback below.
  }

  const textarea = document.createElement('textarea');
  textarea.value = latestReport;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}

copyButton.addEventListener('click', async () => {
  const originalText = copyButton.textContent;
  copyButton.disabled = true;
  const copied = await copyReport();
  copyButton.textContent = copied
    ? 'Copied'
    : 'Copy blocked — report selected; press and hold to copy';
  if (!copied) {
    reportElement.focus();
    const range = document.createRange();
    range.selectNodeContents(reportElement);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  copyButton.disabled = false;
  if (copied) {
    window.setTimeout(() => { copyButton.textContent = originalText; }, 1800);
  }
});
touchButton.addEventListener('pointerdown', (event) => {
  touchResult.textContent = `Pointer event: ${event.pointerType} · ${new Date().toLocaleTimeString()}`;
});
touchButton.addEventListener('touchstart', () => {
  touchResult.textContent = `Touch event received · ${new Date().toLocaleTimeString()}`;
}, { passive: true });
touchButton.addEventListener('click', () => {
  touchResult.textContent += ' · Click event received';
});
