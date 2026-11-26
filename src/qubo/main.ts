import { $, Screens, onVisibility } from '../shared/screens';
import { createHistory, loadJSON, saveJSON } from '../shared/store';
import { CUBE, H, W, type World, createWorld, launch, pivotX, step, towerLen } from './engine';
import { createLaunchInputBuffer } from './launch-input';

const rad = (d: number) => (d * Math.PI) / 180;

// Qubo: the tower tips over toward the next one; tap at the right moment to throw the cube onto it. Only the best score is saved.

const BEST_KEY = 'qubo.best';
// Runs and history for the stats page, like the other arcade games'. Qubo shows only its best, so nothing here is on screen.
const STATS_KEY = 'qubo.stats';
const PROGRESS_KEY = 'qubo.progress';
const CHECKPOINT_STEP = 30;
const history = createHistory<{ endedAt: number; score: number; best: boolean }>('qubo.history');
const MAX_FRAME_DELTA = 0.1;
const INPUT_BUFFER_MS = 102; // experimental timing adjustment for variable-timestep physics
const RESCUE_INPUT_BUFFER_MS = 702; // experimental timing adjustment for variable-timestep physics
// Keep Qubo's displayed numbers and dates English, regardless of the Telegram/WebView locale.
const numberFormat = new Intl.NumberFormat('en-US', { numberingSystem: 'latn' });
const dateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', numberingSystem: 'latn',
});

let world: World = createWorld();
let raf = 0;
let last = 0;
let paused = false;
let started = false;
let pendingLaunchUntil = 0;
let checkpointSyncQueue: Promise<boolean> = Promise.resolve(true);
const rescueLaunchBuffer = createLaunchInputBuffer();
// Presentation-only squash/stretch timers; game physics and collision bounds stay untouched.
let landingAgeVisual = Infinity;
let takeoffAgeVisual = Infinity;
// Twenty-six animated environments rotate every thirty points; the short blend is visual-only.
let backdropIndex = 0;
let previousBackdropIndex = 0;
let backdropTransitionAge = 1;
let best = loadJSON<number>(BEST_KEY, 0);
const savedProgress = loadJSON<unknown>(PROGRESS_KEY, null);
let checkpoint = typeof savedProgress === 'number' && Number.isFinite(savedProgress)
  ? Math.max(0, Math.floor(savedProgress / CHECKPOINT_STEP) * CHECKPOINT_STEP)
  : Math.max(0, Math.floor(best / CHECKPOINT_STEP) * CHECKPOINT_STEP);
if (typeof savedProgress !== 'number' && checkpoint > 0) saveJSON(PROGRESS_KEY, checkpoint);

const canvas = $<HTMLCanvasElement>('stage');
const ctx = canvas.getContext('2d')!;
const frame = canvas.parentElement!;
const endDialog = $<HTMLDialogElement>('end-dialog');

const screens = new Screens({ leaveGame: stopLoop, renderHome, renderHistory, renderRecords: loadLeaderboard });

type TelegramWebApp = { initData: string; viewportHeight?: number; viewportStableHeight?: number; ready?: () => void; expand?: () => void; disableVerticalSwipes?: () => void; enableVerticalSwipes?: () => void; onEvent?: (eventType: 'viewportChanged', handler: (event: { isStateStable?: boolean }) => void) => void; offEvent?: (eventType: 'viewportChanged', handler: (event: { isStateStable?: boolean }) => void) => void };
const telegramWebApp = (window as Window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
telegramWebApp?.ready?.();
telegramWebApp?.expand?.();
telegramWebApp?.disableVerticalSwipes?.();

// Use Telegram's own viewport events inside Mini Apps so the chat follows the
// actual WebView area when the Android keyboard opens or closes.
function updateChatViewportHeight() {
  const telegramHeight = telegramWebApp?.viewportHeight;
  const height = typeof telegramHeight === 'number' && telegramHeight > 0
    ? telegramHeight
    : window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--chat-viewport-height', `${Math.round(height)}px`);
}
updateChatViewportHeight();
if (telegramWebApp?.onEvent) {
  telegramWebApp.onEvent('viewportChanged', updateChatViewportHeight);
} else {
  window.addEventListener('resize', updateChatViewportHeight);
  window.visualViewport?.addEventListener('resize', updateChatViewportHeight);
}
// Preview-only query flag: starts at stage 840 without touching Telegram progress or stats.
// Isolated stage-840 preview: do not sync checkpoints, record starts, or submit scores.
const stage840Preview = new URLSearchParams(location.search).get('preview') === '840';
let checkpointSyncReady = stage840Preview || !telegramWebApp?.initData;
let checkpointInitialization: Promise<boolean> = Promise.resolve(true);
let waitingForCheckpointSync = false;
let checkpointSyncFailed = false;

// Apply the same no-Service-Worker policy used on Telegram mobile to Telegram Desktop too.
// Desktop's WebView user agent is not always branded, but Mini App launch data is in the URL fragment.
const hasTelegramLaunchData = new URLSearchParams(location.hash.slice(1)).has('tgWebAppData');
const isTelegramWebView = /Telegram/i.test(navigator.userAgent) || !!telegramWebApp?.initData || hasTelegramLaunchData;
if (isTelegramWebView && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations()
    .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
    .catch(() => { /* service workers may be unavailable in embedded browsers */ });
}
resetSaberLocalHistory();
checkpointInitialization = stage840Preview ? Promise.resolve(true) : syncCheckpoint();

function resetSaberLocalHistory() {
  // One-time local cleanup for Saber only; Telegram's signed initData identifies the account.
  try {
    const params = new URLSearchParams(telegramWebApp?.initData ?? '');
    const user = JSON.parse(params.get('user') ?? 'null') as { id?: number } | null;
    if (user?.id !== 7431567147) return;

    const marker = 'qubo.saber-history-reset.20261119.v2';
    if (localStorage.getItem(marker)) return;

    const entries = history.load();
    const kept = entries.filter((entry) =>
      entry && Number.isFinite(entry.endedAt) && Number.isFinite(entry.score) && entry.score <= 54,
    );
    const removed = entries.length - kept.length;
    if (removed > 0) saveJSON('qubo.history', kept);

    const stats = loadJSON<{ runs?: number; best?: number }>(STATS_KEY, {});
    stats.runs = Math.max(0, (stats.runs ?? entries.length) - removed);
    stats.best = 54;
    saveJSON(STATS_KEY, stats);

    best = 54;
    checkpoint = 30;
    saveJSON(BEST_KEY, 54);
    saveJSON(PROGRESS_KEY, 30);
    localStorage.setItem(marker, '1');
  } catch {
    // A blocked local store or unavailable Telegram identity must not interrupt the game.
  }
}

$('play-btn').addEventListener('click', start);
$('guide-btn').addEventListener('click', () => ($('guide-dialog') as HTMLDialogElement).showModal());
$('guide-close-btn').addEventListener('click', () => ($('guide-dialog') as HTMLDialogElement).close());
$('guide-back-btn').addEventListener('click', () => ($('guide-dialog') as HTMLDialogElement).close());
$('leaderboard-btn').addEventListener('click', () => screens.records());
$('chat-btn').addEventListener('click', openChat);
$('chat-close-btn').addEventListener('click', () => ($('chat-dialog') as HTMLDialogElement).close());
$('chat-dialog').addEventListener('close', () => {
  stopChatPolling();
  stopChatPresence(true);
  void refreshChatUnread();
});
window.addEventListener('pagehide', () => stopChatPresence(true));
$('chat-form').addEventListener('submit', sendChatMessage);

startUnreadChatPolling();
window.addEventListener('pageshow', () => { void refreshChatUnread(); });

$('end-again').addEventListener('click', () => { endDialog.close(); start(); });
$('end-menu').addEventListener('click', () => { endDialog.close(); screens.home(); });

for (const el of [frame, $('hold-btn')]) {
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); down(); });
}
// Space starts a game from the menu, and plays again from the end dialog.
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (endDialog.open) { e.preventDefault(); endDialog.close(); start(); }
  else if (screens.is('home') && !document.querySelector('dialog[open]')) { e.preventDefault(); start(); }
});
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || !screens.is('game') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w') { e.preventDefault(); if (!e.repeat) down(); }
});
onVisibility(pause, () => {});
document.addEventListener('guide:open', pause);
new ResizeObserver(resize).observe(frame);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { palette = readPalette(); draw(); });

repairTemporaryTestHistory();
renderHome();
if (telegramWebApp?.initData) {
  void checkpointInitialization.then((synced) => {
    if (synced && Math.max(best, checkpoint) < CHECKPOINT_STEP) showStageOneCheckpointNotice();
  });
} else if (Math.max(best, checkpoint) < CHECKPOINT_STEP) {
  showStageOneCheckpointNotice();
}

function showStageOneCheckpointNotice() {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-labelledby', 'qubo-stage-one-notice-title');
  dialog.style.cssText = 'border:0;padding:0;background:transparent;max-width:min( calc(100vw - 32px), 420px );width:100%;color:inherit;';
  const style = document.createElement('style');
  style.textContent = 'dialog.qubo-stage-one-notice::backdrop{background:rgba(5,10,18,.72);backdrop-filter:blur(4px)}';
  dialog.className = 'qubo-stage-one-notice';
  const panel = document.createElement('div');
  panel.dir = 'rtl';
  panel.style.cssText = 'box-sizing:border-box;padding:26px 22px;border:1px solid rgba(255,255,255,.14);border-radius:20px;background:#111b2a;color:#f4f7fb;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.4);font-family:inherit;';
  const title = document.createElement('h2');
  title.id = 'qubo-stage-one-notice-title';
  title.textContent = 'پیام مدیر';
  title.style.cssText = 'margin:0 0 14px;font-size:20px;font-weight:800;';
  const message = document.createElement('p');
  message.textContent = 'کسانی که توی مرحلهٔ اول به امتیاز ۱۵ برسند، بازی بعدی از امتیاز ۱۵ براشون شروع میشه.';
  message.style.cssText = 'margin:0 0 22px;font-size:15px;line-height:2;color:#e4eaf2;';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'متوجه شدم';
  close.style.cssText = 'min-width:132px;border:0;border-radius:12px;padding:11px 22px;background:#72d6a0;color:#10251b;font:inherit;font-weight:800;cursor:pointer;';
  close.addEventListener('click', () => dialog.close());
  panel.append(title, message, close);
  dialog.append(panel);
  document.head.append(style);
  document.body.append(dialog);
  dialog.addEventListener('close', () => { dialog.remove(); style.remove(); }, { once: true });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.showModal();
}

function renderHome() {
  $('home-best').textContent = best ? `Best ${numberFormat.format(best)}` : '';
}

function repairTemporaryTestHistory() {
  const marker = 'qubo.history.repair.20261118';
  try {
    if (localStorage.getItem(marker)) return;
    const from = Date.parse('2026-11-18T02:16:00Z');
    const to = Date.parse('2026-11-18T02:26:00Z');
    const entries = history.load();
    const cleaned = entries.filter((entry) =>
      !(entry && entry.score >= 30 && Number.isFinite(entry.endedAt)
        && entry.endedAt >= from && entry.endedAt <= to),
    );
    if (cleaned.length !== entries.length) {
      saveJSON('qubo.history', cleaned);
      const stats = loadJSON<{ runs?: number; best?: number }>(STATS_KEY, {});
      stats.runs = Math.max(0, (stats.runs ?? 0) - (entries.length - cleaned.length));
      if ((stats.best ?? 0) > 28) stats.best = 28;
      saveJSON(STATS_KEY, stats);
    }
    localStorage.setItem(marker, '1');
  } catch {
    // A blocked local store must never interrupt the game.
  }
}

function renderHistory() {
  // Ignore malformed/legacy local records so one bad item cannot break the whole History screen.
  const entries = history.load().filter((entry) =>
    !!entry && Number.isFinite(entry.endedAt) && Number.isFinite(entry.score),
  );
  const list = $('history-list');
  $('history-empty').hidden = entries.length > 0;
  list.replaceChildren(...entries.map((entry) => {
    const item = document.createElement('li');
    const top = document.createElement('div');
    top.className = 'qubo-history-top';
    const score = document.createElement('b');
    score.textContent = `${numberFormat.format(entry.score)} ${entry.score === 1 ? 'tower' : 'towers'}`;
    const date = document.createElement('time');
    date.dateTime = new Date(entry.endedAt).toISOString();
    date.textContent = dateFormat.format(new Date(entry.endedAt));
    top.append(score, date);
    item.append(top);
    if (entry.best) {
      const badge = document.createElement('span');
      badge.className = 'qubo-history-best';
      badge.textContent = 'New best';
      item.append(badge);
    }
    return item;
  }));
}

// Give the 30–60 world a gradual night → dawn → daylight progression.
function backdropForScore(score: number) {
  if (score >= 840) return 29;
  if (score >= 800) return 28;
  const worldIndex = Math.floor(score / 30) % 26;
  if (score >= 30 && score < 40) return 26;
  if (score >= 40 && score < 50) return 27;
  if (score >= 50 && score < 60) return 1;
  return worldIndex;
}

function start() {
  if (telegramWebApp?.initData && !checkpointSyncReady && !checkpointSyncFailed) {
    if (!waitingForCheckpointSync) {
      waitingForCheckpointSync = true;
      setStatus('Syncing progress...', 'Checking your saved checkpoint before starting');
      void checkpointInitialization.then((ok) => { waitingForCheckpointSync = false; checkpointSyncFailed = !ok; start(); });
    }
    return;
  }
  if (endDialog.open) endDialog.close();
  world = createWorld(Math.random, stage840Preview ? 840 : Math.max(checkpoint, checkpoint < CHECKPOINT_STEP && best >= 15 ? 15 : 0));
  paused = false;
  started = false;
  pendingLaunchUntil = 0;
  rescueLaunchBuffer.clear();
  landingAgeVisual = Infinity;
  takeoffAgeVisual = Infinity;
  backdropIndex = backdropForScore(world.score);
  previousBackdropIndex = backdropIndex;
  backdropTransitionAge = 1;
  screens.show('game');
  $('best').textContent = String(best);
  setScore();
  setStatus('Tap to start', 'Time the tap: throw the cube while the tower leans, before it falls');
  resize();
  cancelAnimationFrame(raf);
  last = performance.now();
  raf = requestAnimationFrame(loop);
}

function down() {
  if (paused) { paused = false; setStatus(''); last = performance.now(); return; }
  if (!started) { started = true; setStatus(''); last = performance.now(); if (!stage840Preview) void recordGameStart(); return; } // the first tap only starts the tower tipping
  if (world.phase === 'air') {
    // A tap in the final moments before touchdown belongs to the landing,
    // even if this device dispatches it just before the collision frame.
    pendingLaunchUntil = performance.now() + INPUT_BUFFER_MS;
    return;
  }
  if (world.phase === 'rescue') {
    // Preserve a quick second tap until the recovery arc has landed on the same platform.
    // This is input-only; it does not alter the rescue trajectory or physics.
    rescueLaunchBuffer.queue(performance.now(), RESCUE_INPUT_BUFFER_MS, { skipRearCornerHop: true });
    return;
  }
  tryLaunch();
}

function tryLaunch(options?: { skipRearCornerHop?: boolean }) {
  launch(world, options);
  if (world.phase === 'air' || world.phase === 'rescue') {
    pendingLaunchUntil = 0;
    takeoffAgeVisual = 0;
    landingAgeVisual = Infinity;
  }
}

function pause() {
  if (!screens.is('game') || world.over || paused || !started) return;
  paused = true;
  setStatus('Paused', 'Tap to carry on');
}

function stopLoop() { cancelAnimationFrame(raf); raf = 0; }

function finish() {
  const isBest = world.score > best;
  if (isBest) { best = world.score; saveJSON(BEST_KEY, best); }
  const stats = loadJSON<{ runs?: number; best?: number }>(STATS_KEY, {});
  saveJSON(STATS_KEY, { runs: (stats.runs ?? 0) + 1, best });
  history.add({ endedAt: Date.now(), score: world.score, best: isBest && world.score > 0 });
  if (world.score > 0 && !stage840Preview) void submitScoreAfterCheckpoints(world.score);
  $('best').textContent = String(best);
  $('end-summary').textContent = `${numberFormat.format(world.score)} ${world.score === 1 ? 'tower' : 'towers'} crossed`
    + (isBest && world.score > 0 ? '. A new best!' : `. Your best is ${numberFormat.format(best)}.`);
  setTimeout(() => { if (world.over && screens.is('game')) { endDialog.showModal(); $('end-again').focus(); } }, 450);
}

function setScore() { $('score').textContent = numberFormat.format(world.score); }
function setStatus(title: string, hint = '') {
  $('status').innerHTML = title ? `${title}${hint ? `<small>${hint}</small>` : ''}` : '';
}

function loop(now: number) {
  // Experimental variable-timestep physics: advance once per animation frame.
  // The simulation delta follows the actual frame interval instead of a fixed 60 Hz step.
  const frameDelta = Math.min(MAX_FRAME_DELTA, Math.max(0, (now - last) / 1000));
  last = now;
  if (started && !paused) {
    const was = world.over;
    const simulatedDelta = frameDelta;
    if (frameDelta > 0 && !world.over) {
      const previousPhase = world.phase;
      step(world, frameDelta);
      if (pendingLaunchUntil) {
        if (now > pendingLaunchUntil) pendingLaunchUntil = 0;
        else if (world.phase === 'scroll' || (world.phase === 'drop' && world.rescueAvailable)) tryLaunch();
      }
      if (rescueLaunchBuffer.isReady(now, world.phase)) {
        tryLaunch(rescueLaunchBuffer.getLaunchOptions());
        if (world.phase === 'air' || world.phase === 'rescue') rescueLaunchBuffer.clear();
      }
      if ((previousPhase === 'air' || previousPhase === 'rescue') && world.phase === 'scroll') landingAgeVisual = 0;
      if (landingAgeVisual < 2) landingAgeVisual += frameDelta;
      if (takeoffAgeVisual < 1) takeoffAgeVisual += frameDelta;
    }
    setScore();
    const reachedCheckpoint = Math.floor(world.score / CHECKPOINT_STEP) * CHECKPOINT_STEP;
    if (reachedCheckpoint > checkpoint) {
      checkpoint = reachedCheckpoint;
      saveJSON(PROGRESS_KEY, checkpoint);
      void saveRemoteCheckpoint(checkpoint);
    }
    const nextBackdrop = backdropForScore(world.score);
    if (nextBackdrop !== backdropIndex) {
      previousBackdropIndex = backdropIndex;
      backdropIndex = nextBackdrop;
      backdropTransitionAge = 0;
    }
    if (backdropTransitionAge < 1) backdropTransitionAge = Math.min(1, backdropTransitionAge + simulatedDelta / 1.1);
    if (world.over && !was) finish();
  }
  // Render on every animation frame; physics now advances at the same cadence.
  draw();
  raf = requestAnimationFrame(loop);
}

async function recordGameStart() {
  const initData = telegramWebApp?.initData;
  if (!initData) return;
  try {
    await fetch('/api/game-stats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData }),
    });
  } catch {
    // Counting is best-effort and must never interrupt a game.
  }
}

function saveRemoteCheckpoint(value: number): Promise<boolean> {
  const initData = telegramWebApp?.initData;
  if (!initData) return Promise.resolve(true);
  if (!checkpointSyncReady) return Promise.resolve(false);
  // Serialize milestone writes so 60 can never reach the server before 30.
  checkpointSyncQueue = checkpointSyncQueue.then(async (previousOk) => {
    if (!previousOk) return false;
    try {
      const response = await fetch('/api/checkpoint', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initData, checkpoint: value }),
      });
      if (!response.ok) {
        if (response.status === 403) setStatus('Account blocked', 'This account cannot submit game progress.');
        return false;
      }
      const data = await response.json() as { ok?: boolean; checkpoint?: number };
      return data.ok === true && (data.checkpoint ?? value) >= value;
    } catch {
      // Do not send later milestones or a score after a failed checkpoint sync.
      return false;
    }
  });
  return checkpointSyncQueue;
}

async function submitScoreAfterCheckpoints(score: number) {
  if ((telegramWebApp?.initData && !checkpointSyncReady) || !await checkpointSyncQueue) return;
  const scoreCheckpoint = Math.floor(score / CHECKPOINT_STEP) * CHECKPOINT_STEP;
  if (scoreCheckpoint !== checkpoint) return;
  await submitScore(score);
}

async function syncCheckpoint(): Promise<boolean> {
  const initData = telegramWebApp?.initData;
  if (!initData) return true;
  try {
    const response = await fetch('/api/checkpoint', {
      headers: { 'x-telegram-init-data': initData },
    });
    if (!response.ok) return false;
    const data = await response.json() as { checkpoint?: number; hasCheckpoint?: boolean };
    const remote = Number.isSafeInteger(data.checkpoint) && (data.checkpoint ?? -1) >= 0
      ? Math.floor((data.checkpoint ?? 0) / CHECKPOINT_STEP) * CHECKPOINT_STEP
      : 0;
    // The server is authoritative. Unverified local-only progress is never uploaded as a checkpoint.
    if (checkpoint !== remote) {
      checkpoint = remote;
      saveJSON(PROGRESS_KEY, checkpoint);
    }
    checkpointSyncReady = true;
    // Restore the account's verified best score after the temporary test run.
    const boardResponse = await fetch('/api/leaderboard', {
      headers: { 'x-telegram-init-data': initData },
    });
    if (boardResponse.ok) {
      const board = await boardResponse.json() as { me?: { best_score?: number } | null };
      if (board.me?.best_score === 28 && best > 28) {
        best = 28;
        saveJSON(BEST_KEY, best);
        const stats = loadJSON<{ runs?: number; best?: number }>(STATS_KEY, {});
        if ((stats.best ?? 0) > 28) {
          stats.best = 28;
          saveJSON(STATS_KEY, stats);
        }
        renderHome();
      }
    }
    return true;
  } catch {
    // Keep playing offline, but never submit progress that could be mistaken for a sequence violation.
    return false;
  }
}

async function submitScore(score: number) {
  const initData = telegramWebApp?.initData;
  if (!initData) return;
  try {
    await fetch('/api/leaderboard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData, score }),
    });
  } catch {
    // A failed network request must not interrupt the game.
  }
}

async function loadLeaderboard() {
  document.getElementById('records-private-games')?.remove();
  const list = $('records-list');
  list.replaceChildren();
  $('records-me').textContent = '';
  const initData = telegramWebApp?.initData;
  if (!initData) {
    $('records-status').textContent = 'Global records are not available yet. Player scores are being saved for a future release.';
    return;
  }
  $('records-status').textContent = 'Connecting to the global network...';
  try {
    const response = await fetch('/api/leaderboard', {
      headers: { 'x-telegram-init-data': initData },
    });
    const data = await response.json() as {
      hidden?: boolean;
      message?: string;
      entries?: Array<{ rank: number; display_name: string; best_score: number; telegram_user_id: string }>;
      me?: { rank: number; best_score: number } | null;
      error?: string;
    };
    if (!response.ok) throw new Error(data.error || 'Unable to load global records.');
    if (data.hidden) {
      $('records-status').textContent = data.message
        || 'Global records are not available yet. Player scores are being saved for a future release.';
      return;
    }
    const entries = data.entries ?? [];
    if (!entries.length) {
      $('records-status').textContent = 'No records have been registered yet.';
    } else {
      $('records-status').textContent = 'TOP PLAYERS';
      for (const entry of entries) {
        const item = document.createElement('li');
        item.dataset.rank = String(entry.rank);
        const player = document.createElement('span');
        player.className = 'records-player';
        player.textContent = entry.display_name;
        const score = document.createElement('strong');
        score.className = 'records-score';
        score.textContent = numberFormat.format(entry.best_score);
        item.append(player, score);
        if (data.me && entry.rank === data.me.rank) item.classList.add('is-me');
        list.append(item);
      }
    }
    if (data.me) $('records-me').textContent =
      `YOUR RANK: #${data.me.rank} · BEST SCORE: ${numberFormat.format(data.me.best_score)}`;
  } catch (error) {
    $('records-status').textContent = error instanceof Error ? error.message : 'Unable to load global records.';
  }
  // Private game counts are requested only by the admin.
  if (isChatAdmin()) void loadPrivateGameStats(initData, $('records-me'));
}

async function loadPrivateGameStats(initData: string, anchor: HTMLElement) {
  document.getElementById('records-private-games')?.remove();
  try {
    const response = await fetch('/api/game-stats', {
      headers: { 'x-telegram-init-data': initData },
    });
    if (response.status === 403 || !response.ok) return;
    const data = await response.json() as {
      players?: Array<{
        telegram_user_id: string;
        display_name: string;
        game_count: number;
        increased: boolean;
      }>;
    };

    const section = document.createElement('section');
    section.id = 'records-private-games';
    const heading = document.createElement('h2');
    heading.className = 'section-label';
    heading.textContent = 'PRIVATE // GAMES PLAYED';
    const list = document.createElement('ol');
    list.className = 'records-list records-private-list';
    for (const player of data.players ?? []) {
      const item = document.createElement('li');
      const count = Number(player.game_count);
      const label = document.createElement('span');
      label.className = 'records-private-player';
      label.textContent = player.display_name;
      const number = document.createElement('strong');
      number.className = 'records-private-count';
      number.textContent = numberFormat.format(count);
      // Only the admin sees green for an increased count; every other eligible player sees red.
      number.classList.toggle('is-increased', isChatAdmin() && player.increased);
      item.append(label, number);
      list.append(item);
    }
    section.append(heading, list);
    anchor.insertAdjacentElement('afterend', section);
  } catch {
    // Private statistics are optional and never affect the leaderboard.
  }
}

type ChatMessage = { id: number; display_name: string; message: string; created_at: string; is_own: boolean | number; reply_to_id?: number | null; reply_to_display_name?: string | null; reply_to_message?: string | null };
let chatReplyTarget: ChatMessage | null = null;
function getChatLocalStorageKeys() {
  try {
    const params = new URLSearchParams(telegramWebApp?.initData ?? '');
    const user = JSON.parse(params.get('user') ?? 'null') as { id?: number } | null;
    const accountId = String(user?.id ?? 'unknown');
    return {
      messages: `qubo.global-chat.messages.${accountId}`,
      deleted: `qubo.global-chat.deleted.${accountId}`,
    };
  } catch {
    return { messages: 'qubo.global-chat.messages.unknown', deleted: 'qubo.global-chat.deleted.unknown' };
  }
}
function loadLocalChatMessages(): ChatMessage[] {
  try {
    const value = JSON.parse(localStorage.getItem(getChatLocalStorageKeys().messages) ?? '[]') as ChatMessage[];
    return Array.isArray(value) ? value.filter((message) =>
      message && Number.isSafeInteger(message.id) && typeof message.message === 'string'
      && typeof message.display_name === 'string' && typeof message.created_at === 'string',
    ) : [];
  } catch { return []; }
}
function loadLocalDeletedChatIds(): number[] {
  try {
    const value = JSON.parse(localStorage.getItem(getChatLocalStorageKeys().deleted) ?? '[]') as number[];
    return Array.isArray(value) ? value.filter((id) => Number.isSafeInteger(id) && id > 0) : [];
  } catch { return []; }
}
function syncLocalChatHistory(serverMessages: ChatMessage[], serverDeletedIds: number[]): ChatMessage[] {
  const keys = getChatLocalStorageKeys();
  const deletedIds = new Set([...loadLocalDeletedChatIds(), ...serverDeletedIds]);
  const messages = new Map<number, ChatMessage>();
  for (const message of [...loadLocalChatMessages(), ...serverMessages]) {
    if (!deletedIds.has(message.id)) messages.set(message.id, message);
  }
  const merged = [...messages.values()].sort((a, b) => a.id - b.id);
  try {
    localStorage.setItem(keys.deleted, JSON.stringify([...deletedIds]));
    localStorage.setItem(keys.messages, JSON.stringify(merged));
  } catch {
    // Keep the live chat usable if local storage is full or unavailable.
  }
  return merged;
}

const CHAT_ADMIN_ID = '7431567147';
function isChatAdmin() {
  try {
    const params = new URLSearchParams(telegramWebApp?.initData ?? '');
    const user = JSON.parse(params.get('user') ?? 'null') as { id?: number } | null;
    return String(user?.id ?? '') === CHAT_ADMIN_ID;
  } catch {
    return false;
  }
}
let chatPollTimer: number | undefined;
let chatPresenceActive = false;
let chatPresenceHeartbeatTimer: number | undefined;
let unreadPollTimer: number | undefined;
let chatLoading = false;
function getChatPresenceSessionId(): string {
  const key = 'qubo.global-chat.presence-session';
  try {
    const saved = sessionStorage.getItem(key);
    if (saved && /^[a-f0-9-]{16,64}$/i.test(saved)) return saved;
    const created = crypto.randomUUID();
    sessionStorage.setItem(key, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}
const chatPresenceSessionId = getChatPresenceSessionId();
async function sendChatPresence(action: 'presence_enter' | 'presence_heartbeat' | 'presence_leave', keepalive = false) {
  const initData = telegramWebApp?.initData;
  if (!initData) return;
  try {
    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData, action, sessionId: chatPresenceSessionId }),
      keepalive,
    });
  } catch {
    // The server-side 90-second expiry clears abandoned sessions if a leave request cannot arrive.
  }
}
function stopChatPresence(sendLeave: boolean) {
  if (chatPresenceHeartbeatTimer !== undefined) window.clearInterval(chatPresenceHeartbeatTimer);
  chatPresenceHeartbeatTimer = undefined;
  if (chatPresenceActive && sendLeave) void sendChatPresence('presence_leave', true);
  chatPresenceActive = false;
}
function startChatPresence() {
  if (chatPresenceActive) return;
  chatPresenceActive = true;
  void sendChatPresence('presence_enter');
  chatPresenceHeartbeatTimer = window.setInterval(() => {
    if (chatPresenceActive) void sendChatPresence('presence_heartbeat');
  }, 15_000);
}
function getChatNameColor(name: string): string {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index += 1) {
    hash = Math.imul(hash ^ name.charCodeAt(index), 16777619);
  }
  return `hsl(${(hash >>> 0) % 360} 82% 70%)`;
}

function renderChatPresence(users: Array<{ telegram_user_id: string; display_name: string }>) {
  const container = $('chat-presence');
  container.replaceChildren();
  const label = document.createElement('span');
  label.className = 'chat-presence-count';
  label.textContent = `${users.length} online`;
  container.append(label);
  for (const user of users) {
    const item = document.createElement('span');
    item.className = 'chat-presence-user';
    const dot = document.createElement('i');
    dot.className = 'chat-presence-dot';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = user.display_name;
    name.style.color = getChatNameColor(user.display_name);
    item.append(dot, name);
    container.append(item);
  }
}
let unreadRefreshInFlight = false;
const CHAT_LAST_READ_KEY = 'qubo.global-chat.last-read';

function getLastReadChatId(): number | null {
  try {
    const raw = localStorage.getItem(CHAT_LAST_READ_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch { return null; }
}

function setLastReadChatId(id: number) {
  if (!Number.isSafeInteger(id) || id < 0) return;
  try { localStorage.setItem(CHAT_LAST_READ_KEY, String(id)); } catch { /* Storage may be unavailable. */ }
}

function updateChatUnreadBadge(count: number) {
  const badge = $('chat-unread-badge');
  badge.hidden = count <= 0;
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.setAttribute('aria-label', count > 0 ? `${count} پیام خوانده‌نشده` : 'پیام جدیدی نیست');
}

async function refreshChatUnread() {
  const dialog = $('chat-dialog') as HTMLDialogElement;
  const initData = telegramWebApp?.initData;
  if (!initData || dialog.open || !screens.is('home') || unreadRefreshInFlight) return;
  unreadRefreshInFlight = true;
  try {
    const lastRead = getLastReadChatId();
    const response = await fetch(`/api/chat?unread_after=${encodeURIComponent(String(lastRead ?? 0))}`, {
      headers: { 'x-telegram-init-data': initData },
    });
    const data = await response.json() as { latest_id?: number; unread_count?: number; eligible?: boolean };
    if (!response.ok || !Number.isSafeInteger(data.latest_id)) return;
    // Ignore a response if another action marked newer messages as read while this request was in flight.
    if (getLastReadChatId() !== lastRead) return;
    // On a player's first visit, establish a baseline instead of showing the entire chat history as new.
    if (lastRead === null) {
      setLastReadChatId(data.latest_id!);
      updateChatUnreadBadge(0);
      return;
    }
    updateChatUnreadBadge(data.unread_count ?? 0);
  } catch {
    // The badge is best-effort; a temporary network issue must not interrupt the game.
  } finally {
    unreadRefreshInFlight = false;
  }
}

function startUnreadChatPolling() {
  if (unreadPollTimer !== undefined) window.clearInterval(unreadPollTimer);
  void refreshChatUnread();
  unreadPollTimer = window.setInterval(() => { void refreshChatUnread(); }, 3_000);
}

function markChatMessagesRead(messages: ChatMessage[]) {
  const latestId = messages.reduce((latest, message) => Math.max(latest, message.id), getLastReadChatId() ?? 0);
  setLastReadChatId(latestId);
  updateChatUnreadBadge(0);
}

function openChat() {
  const dialog = $('chat-dialog') as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
  stopChatPolling();
  stopChatPresence(false);
  $('chat-presence').replaceChildren();
  $('chat-locked').hidden = true;
  $('chat-content').hidden = true;
  $('chat-status').textContent = 'در حال اتصال به چت...';
  // Contact the server only while the chat dialog is open.
  void refreshChat();
}

function stopChatPolling() {
  if (chatPollTimer !== undefined) window.clearInterval(chatPollTimer);
  chatPollTimer = undefined;
}

async function refreshChat() {
  const dialog = $('chat-dialog') as HTMLDialogElement;
  if (!dialog.open || chatLoading) return;
  const initData = telegramWebApp?.initData;
  if (!initData) {
    showChatHidden('چت جهانی فعلاً مخفی است؛ پیام‌ها و اطلاعات در دیتابیس ذخیره می‌شوند و بعداً قابل مشاهده خواهند بود.');
    return;
  }
  chatLoading = true;
  try {
    const response = await fetch('/api/chat', {
      headers: { 'x-telegram-init-data': initData },
    });
    const data = await response.json() as {
      hidden?: boolean;
      message?: string;
      eligible?: boolean;
      best_score?: number;
      required_score?: number;
      messages?: ChatMessage[];
      deleted_ids?: number[];
      online_users?: Array<{ telegram_user_id: string; display_name: string }>;
      error?: string;
    };
    if (!dialog.open) return;
    if (response.status === 403 && data.eligible === false) {
      showChatHidden(`برای مشاهده و ارسال پیام در چت جهانی، حداقل امتیاز لازم ۳۵ است. امتیاز فعلی شما: ${numberFormat.format(data.best_score ?? 0)}`);
      $('chat-required-score').textContent = `امتیاز لازم: ۳۵ · امتیاز فعلی: ${numberFormat.format(data.best_score ?? 0)}`;
      return;
    }
    if (!response.ok) throw new Error(data.error || 'دریافت چت ناموفق بود.');
    if (data.hidden) {
      showChatHidden(data.message || 'چت جهانی فعلاً مخفی است؛ اطلاعات بعداً قابل مشاهده خواهد بود.');
      return;
    }
    $('chat-locked').hidden = true;
    $('chat-content').hidden = false;
    const form = $('chat-form') as HTMLFormElement;
    form.hidden = false;
    form.style.display = '';
    const chatMessages = syncLocalChatHistory(data.messages ?? [], data.deleted_ids ?? []);
    const chatMessageSignature = JSON.stringify(chatMessages.map(({ id, message, display_name, is_own, created_at, reply_to_id, reply_to_display_name, reply_to_message }) => (
      [id, message, display_name, is_own, created_at, reply_to_id, reply_to_display_name, reply_to_message]
    )));
    const messageList = $('chat-messages');
    if (messageList.dataset.renderedMessages !== chatMessageSignature) {
      renderChatMessages(chatMessages);
      messageList.dataset.renderedMessages = chatMessageSignature;
    }
    markChatMessagesRead(chatMessages);
    renderChatPresence(data.online_users ?? []);
    startChatPresence();
    $('chat-status').textContent = 'چت هر ۲ ثانیه به‌روزرسانی می‌شود.';
    stopChatPolling();
    chatPollTimer = window.setInterval(() => { void refreshChat(); }, 2_000);
  } catch (error) {
    $('chat-content').hidden = false;
    $('chat-locked').hidden = true;
    $('chat-status').textContent = error instanceof Error ? error.message : 'دریافت چت ناموفق بود.';
  } finally {
    chatLoading = false;
  }
}

function setChatReplyTarget(message: ChatMessage | null) {
  chatReplyTarget = message;
  const preview = $('chat-reply-preview');
  preview.replaceChildren();
  preview.hidden = !message;
  if (!message) return;
  const label = document.createElement('span');
  label.className = 'chat-reply-preview-text';
  label.textContent = `Replying to ${message.display_name}: ${message.message}`;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'chat-reply-cancel';
  cancel.textContent = '×';
  cancel.setAttribute('aria-label', 'Cancel reply');
  cancel.addEventListener('click', () => setChatReplyTarget(null));
  preview.append(label, cancel);
  ($('chat-input') as HTMLInputElement).focus();
}

function renderChatMessages(messages: ChatMessage[]) {
  const list = $('chat-messages');
  const previousScrollTop = list.scrollTop;
  const wasAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  list.replaceChildren();

  // Show the conversation's starting date once, above the messages.
  const firstMessageDate = messages
    .map((message) => new Date(message.created_at))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())[0];
  if (firstMessageDate) {
    const dateRow = document.createElement('li');
    dateRow.className = 'chat-start-date';
    dateRow.textContent = `شروع گفتگو: ${new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
    }).format(firstMessageDate)}`;
    list.append(dateRow);
  }

  for (const message of messages) {
    const item = document.createElement('li');
    item.className = message.is_own ? 'chat-message is-own' : 'chat-message';
    const top = document.createElement('div');
    top.className = 'chat-message-top';
    const name = document.createElement('strong');
    name.textContent = message.display_name;
    name.style.color = getChatNameColor(message.display_name);
    name.style.textShadow = 'none';
    // Hide the sender name on the current user's own messages; keep names for everyone else.
    if (message.is_own) top.classList.add('chat-message-top-own');
    else top.append(name);
    if (message.reply_to_message && message.reply_to_display_name) {
      const quote = document.createElement('button');
      quote.type = 'button';
      quote.className = 'chat-reply-quote';
      quote.textContent = `↪ ${message.reply_to_display_name}: ${message.reply_to_message}`;
      quote.addEventListener('click', () => {
        if (message.reply_to_id === null || message.reply_to_id === undefined) return;
        const original = list.querySelector<HTMLElement>(`[data-message-id="${message.reply_to_id}"]`);
        original?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      item.append(quote);
    }
    const body = document.createElement('p');
    body.textContent = message.message;
    item.append(top, body);
    const reply = document.createElement('button');
    reply.type = 'button';
    reply.className = 'chat-reply-btn';
    reply.textContent = 'Reply';
    reply.addEventListener('click', () => setChatReplyTarget(message));
    item.append(reply);
    item.dataset.messageId = String(message.id);
    if (isChatAdmin()) {
      const actions = document.createElement('div');
      actions.className = 'chat-message-actions';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chat-delete-btn';
      remove.textContent = 'حذف پیام';
      remove.addEventListener('click', () => { void deleteChatMessage(message.id, remove); });
      actions.append(remove);
      item.append(actions);

      // Reveal the delete action only after a deliberate long-press (or right-click).
      let holdTimer = 0;
      let longPressTriggered = false;
      const cancelHold = () => {
        if (holdTimer) window.clearTimeout(holdTimer);
        holdTimer = 0;
      };
      item.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        cancelHold();
        holdTimer = window.setTimeout(() => {
          item.classList.add('is-delete-menu-open');
          longPressTriggered = true;
          holdTimer = 0;
        }, 550);
      });
      for (const eventName of ['pointerup', 'pointerleave', 'pointercancel']) {
        item.addEventListener(eventName, cancelHold);
      }
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        item.classList.add('is-delete-menu-open');
      });
      item.addEventListener('click', (event) => {
        if (event.target === remove) return;
        if (longPressTriggered) {
          longPressTriggered = false;
          return;
        }
        if (item.classList.contains('is-delete-menu-open')) item.classList.remove('is-delete-menu-open');
      });
    }
    list.append(item);
  }
  list.scrollTop = wasAtBottom ? list.scrollHeight : previousScrollTop;
}

async function deleteChatMessage(messageId: number, button: HTMLButtonElement) {
  const initData = telegramWebApp?.initData;
  if (!initData || !isChatAdmin() || !Number.isSafeInteger(messageId) || messageId <= 0) return;
  if (!window.confirm('این پیام برای همه حذف شود؟')) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/chat?id=${encodeURIComponent(String(messageId))}`, {
      method: 'DELETE',
      headers: { 'x-telegram-init-data': initData },
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) throw new Error(data.error || 'حذف پیام ناموفق بود.');
    await refreshChat();
  } catch (error) {
    button.disabled = false;
    $('chat-status').textContent = error instanceof Error ? error.message : 'حذف پیام ناموفق بود.';
  }
}

function showChatHidden(message: string) {
  $('chat-content').hidden = true;
  $('chat-locked').hidden = false;
  const heading = $('chat-locked').querySelector('h3');
  const description = $('chat-locked').querySelector('p');
  const note = $('chat-locked').querySelector('strong');
  if (heading) heading.textContent = 'دسترسی محدود به چت جهانی';
  if (description) description.textContent = message;
  if (note) note.textContent = 'برای مشاهده و ارسال پیام، امتیاز ۳۵ یا بالاتر لازم است.';
  $('chat-required-score').textContent = '';
  stopChatPolling();
  stopChatPresence(true);
}

async function sendChatMessage(event: SubmitEvent) {
  event.preventDefault();
  const input = $('chat-input') as HTMLInputElement;
  const message = input.value.trim();
  const initData = telegramWebApp?.initData;
  const replyTarget = chatReplyTarget;
  if (!message || !initData) return;
  const button = $('chat-send-btn') as HTMLButtonElement;
  button.disabled = true;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData, message, ...(replyTarget ? { replyToId: replyTarget.id } : {}) }),
    });
    const data = await response.json() as { error?: string; eligible?: boolean; best_score?: number };
    if (response.status === 403 && data.eligible === false) {
      $('chat-content').hidden = true;
      $('chat-locked').hidden = false;
      $('chat-required-score').textContent = `امتیاز جهانی فعلی شما: ${numberFormat.format(data.best_score ?? 0)} · امتیاز لازم: ۳۵`;
      stopChatPolling();
      return;
    }
    if (!response.ok) throw new Error(data.error || 'ارسال پیام ناموفق بود.');
    input.value = '';
    setChatReplyTarget(null);
    await refreshChat();
    input.focus();
  } catch (error) {
    $('chat-status').textContent = error instanceof Error ? error.message : 'ارسال پیام ناموفق بود.';
  } finally {
    button.disabled = false;
  }
}

// ---------- Drawing ----------

interface Palette { cube: string; sheet: string; tint: string; ink: string; paper: string }
function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return { cube: v('--c'), sheet: v('--sheet'), tint: v('--tint'), ink: v('--ink'), paper: v('--paper') };
}
let palette = readPalette();

function resize() {
  // Use the device's native pixel ratio; do not apply game-specific render scaling.
  const dpr = window.devicePixelRatio || 1;
  const width = frame.clientWidth;
  if (!width) return;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round((width * H / W) * dpr);
  draw();
}

function draw() {
  if (!canvas.width) return;
  const p = palette;
  const s = canvas.width / W;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  // Leave the canvas transparent so the page background remains visible.
  ctx.clearRect(0, 0, W, H);
  drawWeatherBackground();

  ctx.save();
  ctx.translate(-world.cam, 0);
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#080d12';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
  ctx.shadowBlur = 3;
  ctx.fillStyle = p.sheet;
  // The tower the cube stands on tips over from the middle of its base; the next one stands still.
  world.towers.forEach((t, i) => {
    // Keep every generated tower rendered in every phase. Hiding distant towers
    // during recovery hops made the front columns flicker as the phase changed.
    if (i === 0 && world.phase !== 'wait') return; // the previous tower continues out of frame in world.fallen
    ctx.save();
    ctx.translate(pivotX(t), H);
    if (i === 0 && world.phase === 'wait') ctx.rotate(rad(world.angle));
    else if ((world.phase === 'scroll' || world.phase === 'rescue' || (world.phase === 'drop' && (world.rescueAvailable || world.rescueInPlace))) && i === world.landed) ctx.rotate(rad(world.angle));
    const len = towerLen(t);
    // Keep the tower whole: the advancing camera pulls it diagonally out
    // through the rear edge instead of erasing it vertically from its base.
    drawTower(t.w, len);
    ctx.restore();
  });

  for (const f of world.fallen) {
    ctx.save();
    ctx.translate(f.pivot, H);
    ctx.rotate(rad(f.angle));
    drawTower(f.w, f.len);
    ctx.restore();
  }

  const isSupported = world.phase === 'wait' || world.phase === 'scroll' || world.phase === 'rescue';
  // Airborne stretch follows vertical speed. Landing gets a brief, damped squash and rebound.
  // These transforms are render-only: positions, hitboxes, timing and difficulty are unchanged.
  const impact = landingAgeVisual < 0.48
    ? Math.exp(-15 * landingAgeVisual) * Math.sin(25 * landingAgeVisual)
    : 0;
  const takeoff = takeoffAgeVisual < 0.16 ? Math.sin(Math.PI * takeoffAgeVisual / 0.16) : 0;
  const rising = (world.phase === 'air' || world.phase === 'rescue')
    ? Math.max(-1, Math.min(1, -world.vy / 950))
    : 0;
  const scaleX = 1 + impact * 0.17 - takeoff * 0.07 - rising * 0.035;
  const scaleY = 1 - impact * 0.2 + takeoff * 0.12 + rising * 0.09;
  drawCube(world.cubeX, world.cubeY, world.cubeAngle, isSupported ? world.angle : 0, scaleX, scaleY);
  ctx.restore();

  // A single understated ground line remains beneath the towers.
  ctx.strokeStyle = p.tint;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, H - 1);
  ctx.lineTo(W, H - 1);
  ctx.stroke();
}

/** Twenty-six animated worlds, changing every thirty points with a soft crossfade. */
function drawWeatherBackground() {
  const time = performance.now() / 1000;
  // Keep the page area behind the score/header in sync with the active canvas world.
  document.body.dataset.quboBackdrop = String(backdropIndex);
  if (backdropTransitionAge >= 1) {
    drawBackdrop(backdropIndex, time);
    return;
  }
  ctx.save();
  ctx.globalAlpha = 1 - backdropTransitionAge;
  drawBackdrop(previousBackdropIndex, time);
  ctx.globalAlpha = backdropTransitionAge;
  drawBackdrop(backdropIndex, time);
  ctx.restore();
}

function drawBackdrop(index: number, time: number) {
  const gradient = ctx.createLinearGradient(0, 0, 0, H);
  const palettes = [
    ['#101923', '#27333d', '#46515a'], // storm
    ['#70c8f4', '#d8f1ff', '#f5d98b'], // sunny
    ['#174c49', '#68a77a', '#b5c88b'], // forest
    ['#087da8', '#61c5d2', '#d4f0d8'], // sea
    ['#e99b52', '#f5d18a', '#b96e42'], // desert
    ['#26395f', '#f0a77d', '#f8d9a0'], // golden sunset (stage 150)
    ['#152b49', '#7199bd', '#e1efff'], // snow
    ['#351b2a', '#a84332', '#f29a50'], // volcano
    ['#d68c72', '#e8b49a', '#f3d5ae'], // Tehran at golden hour
    ['#100f35', '#34316f', '#e04d9c'], // cyberpunk
    ['#080d2b', '#29265d', '#66518f'], // cosmic
    ['#17152f', '#554b85', '#b9a4d8'], // spirituality
    ['#17152f', '#554b85', '#b9a4d8'], // metaphysics
    ['#72634e', '#b7a184', '#e1cba6'], // philosophy
    ['#381b3b', '#a34c78', '#f2a5b8'], // love
    ['#10172d', '#343958', '#8b8cab'], // solitude
    ['#071d3d', '#126d9b', '#a3eaff'], // quantum
    ['#031d19', '#07543e', '#1ab56b'], // matrix
    ['#080d2b', '#383b83', '#d2a8f2'], // cosmology
    ['#333052', '#777ba7', '#d8d9f4'], // dreams
    ['#111b38', '#45466e', '#d7b77e'], // time
    ['#164c45', '#4f9b80', '#b2d8a1'], // nature
    ['#101e40', '#3e6598', '#b5d9f4'], // consciousness
    ['#25334a', '#778ba0', '#e9c994'], // freedom
    ['#193b58', '#746a83', '#d8c6a1'], // balance
    ['#211b46', '#67539a', '#f0c78d'], // inner power
  ];
  const colors = index === 26 ? ['#071426', '#101f3c', '#263b59']
    : index === 27 ? ['#26395f', '#f0a77d', '#f8d9a0']
      : index === 28 ? ['#090b28', '#211747', '#092c3c']
        : index === 29 ? ['#68727b', '#929ba2', '#c1c6c9']
          : palettes[index];
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(0.62, colors[1]);
  gradient.addColorStop(1, colors[2]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);

  if (index === 26) {
    // Moonlit night sky for the first half of the 30–60 world.
    const glow = ctx.createRadialGradient(278, 86, 8, 278, 86, 78);
    glow.addColorStop(0, 'rgba(190, 220, 255, 0.2)');
    glow.addColorStop(1, 'rgba(130, 175, 235, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(190, 0, 170, 190);

    ctx.save();
    ctx.shadowColor = 'rgba(224, 239, 255, 0.85)';
    ctx.shadowBlur = 22;
    ctx.fillStyle = '#f4f0d6';
    ctx.beginPath();
    ctx.arc(278, 86, 27, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(291, 75, 25, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    for (let i = 0; i < 76; i++) {
      const x = (i * 47.3 + (i % 6) * 17) % W;
      const y = (i * 71.9 + (i % 5) * 13) % 300;
      const twinkle = 0.42 + 0.48 * (0.5 + 0.5 * Math.sin(time * (1.1 + (i % 4) * 0.35) + i));
      const radius = i % 9 === 0 ? 1.8 : 0.8 + (i % 3) * 0.35;
      ctx.globalAlpha = twinkle;
      ctx.fillStyle = i % 7 === 0 ? '#c8e3ff' : '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      if (i % 9 === 0) {
        ctx.strokeStyle = 'rgba(225, 239, 255, 0.62)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y);
        ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(13, 28, 49, 0.36)';
    ctx.beginPath();
    ctx.moveTo(0, 365);
    ctx.quadraticCurveTo(88, 330, 176, 365);
    ctx.quadraticCurveTo(270, 337, W, 365);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fill();
  } else if (index === 27) {
    // Early dawn: the horizon begins to glow as the last cool night tones fade.
    const sunrise = ctx.createRadialGradient(180, 258, 8, 180, 258, 205);
    sunrise.addColorStop(0, 'rgba(255, 239, 190, 0.92)');
    sunrise.addColorStop(0.28, 'rgba(255, 190, 137, 0.48)');
    sunrise.addColorStop(1, 'rgba(255, 170, 130, 0)');
    ctx.fillStyle = sunrise;
    ctx.fillRect(0, 80, W, 300);

    ctx.save();
    ctx.shadowColor = 'rgba(255, 231, 185, 0.72)';
    ctx.shadowBlur = 20;
    ctx.fillStyle = '#fff0c6';
    ctx.beginPath();
    ctx.arc(180, 258, 23, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Soft clouds catch the first warm light.
    for (let i = 0; i < 5; i++) {
      const x = (i * 91 + 22) % (W + 70) - 25;
      const y = 145 + (i % 3) * 34;
      ctx.fillStyle = i % 2 ? 'rgba(255, 221, 194, 0.28)' : 'rgba(255, 239, 218, 0.34)';
      ctx.beginPath();
      ctx.ellipse(x, y, 38 + (i % 2) * 12, 7 + (i % 3), 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Distant hills silhouette, softened by the sunrise.
    ctx.fillStyle = 'rgba(91, 104, 133, 0.24)';
    ctx.beginPath();
    ctx.moveTo(0, 345);
    ctx.quadraticCurveTo(75, 309, 150, 344);
    ctx.quadraticCurveTo(240, 313, W, 346);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fill();
  } else if (index === 28) {
    // Fixed enchanted bioluminescent mushroom grove for the endless 800+ world.
    const haze = ctx.createRadialGradient(180, 230, 18, 180, 230, 245);
    haze.addColorStop(0, 'rgba(80, 255, 220, 0.18)');
    haze.addColorStop(0.48, 'rgba(174, 75, 255, 0.12)');
    haze.addColorStop(1, 'rgba(5, 8, 28, 0)');
    ctx.fillStyle = haze; ctx.fillRect(0, 0, W, H);
    const colors = ['#ff6bd6', '#7c8cff', '#50f4dc', '#d18cff', '#ff9bce', '#73d7ff', '#b5ff78'];
    for (let i = 0; i < 9; i++) {
      const x = i * 49 - 22, base = 355 + (i % 3) * 17, stem = 58 + (i % 4) * 16, capY = base - stem;
      const color = colors[i % colors.length];
      ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 18;
      ctx.fillStyle = 'rgba(20, 17, 53, 0.92)'; ctx.fillRect(x - 5, capY, 10, stem);
      ctx.fillStyle = color; ctx.beginPath();
      ctx.ellipse(x, capY, 22 + (i % 3) * 5, 10 + (i % 2) * 3, 0, Math.PI, Math.PI * 2);
      ctx.quadraticCurveTo(x + 18, capY + 12, x, capY + 8);
      ctx.quadraticCurveTo(x - 18, capY + 12, x - 22, capY); ctx.fill();
      ctx.globalAlpha = 0.8; ctx.fillStyle = '#fff4ff';
      for (let dot = 0; dot < 4; dot++) { ctx.beginPath(); ctx.arc(x - 12 + dot * 8, capY - 3 - (dot % 2) * 3, 1.5, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    for (let layer = 0; layer < 3; layer++) {
      ctx.fillStyle = ['rgba(24,35,83,.62)','rgba(22,57,79,.72)','rgba(12,34,54,.9)'][layer];
      ctx.beginPath(); ctx.moveTo(0,350+layer*18);
      for(let x=0;x<=W;x+=12){const y=342+layer*19+Math.sin(x*.018+time*(.18+layer*.08))*(9+layer*4);ctx.lineTo(x,y);}
      ctx.lineTo(W,H);ctx.lineTo(0,H);ctx.closePath();ctx.fill();
    }
    for(let i=0;i<34;i++){
      const x=(i*83.7+Math.sin(time*.32+i)*15+W)%W, y=(i*47.3-time*(8+i%4)+470)%390;
      const color=['#71fff0','#ff8de1','#c4a0ff','#d9ff8c'][i%4];
      ctx.globalAlpha=.35+.35*(.5+.5*Math.sin(time*1.4+i));ctx.fillStyle=color;ctx.shadowColor=color;ctx.shadowBlur=8;
      ctx.beginPath();ctx.arc(x,y,1.2+(i%3)*.45,0,Math.PI*2);ctx.fill();
    }
    ctx.globalAlpha=1;ctx.shadowBlur=0;
  } else if (index === 29) {
    // Stage 840+: a moving overcast sky with layered, soft grey storm clouds.
    const haze = ctx.createLinearGradient(0, 0, 0, H);
    haze.addColorStop(0, 'rgba(35, 42, 48, .18)');
    haze.addColorStop(.55, 'rgba(218, 222, 224, .12)');
    haze.addColorStop(1, 'rgba(55, 62, 68, .24)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, W, H);

    const cloudLayer = (count: number, speed: number, yBase: number, scale: number, color: string, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      for (let i = 0; i < count; i++) {
        const span = W + 190;
        const x = ((i * (W / count) + time * speed) % span) - 95;
        const y = yBase + Math.sin(time * .22 + i * 1.7) * 7 + (i % 3) * 13;
        const w = (48 + (i % 4) * 17) * scale;
        const h = (19 + (i % 3) * 7) * scale;
        const cloud = ctx.createRadialGradient(x, y, 3, x, y, w);
        cloud.addColorStop(0, color);
        cloud.addColorStop(.68, color);
        cloud.addColorStop(1, 'rgba(75, 82, 88, 0)');
        ctx.fillStyle = cloud;
        ctx.beginPath();
        ctx.ellipse(x, y, w, h, 0, 0, Math.PI * 2);
        ctx.ellipse(x - w * .34, y + h * .12, w * .58, h * .78, 0, 0, Math.PI * 2);
        ctx.ellipse(x + w * .3, y + h * .08, w * .62, h * .86, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    };
    cloudLayer(7, 5.5, 72, 1.05, 'rgba(238, 241, 242, .92)', .88);
    cloudLayer(8, -8, 165, 1.28, 'rgba(117, 126, 133, .94)', .82);
    cloudLayer(9, 11, 275, 1.48, 'rgba(77, 85, 92, .96)', .92);

    // Subtle drifting rain haze; no lightning or bright colors.
    ctx.save();
    ctx.strokeStyle = 'rgba(238, 242, 244, .16)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 34; i++) {
      const x = (i * 47.3 + time * (9 + i % 4)) % W;
      const y = (i * 71.9 + time * (24 + i % 3) + H) % H;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 2, y + 8 + (i % 3) * 2);
      ctx.stroke();
    }
    ctx.restore();
  } else if (index === 0) {
    // Original Qubo storm atmosphere is preserved as the opening world.
    ctx.save();
    for (let i = 0; i < 9; i++) {
      const x = ((i * 71 + time * (3 + (i % 3) * 1.4)) % (W + 180)) - 90;
      const y = 20 + (i % 4) * 43;
      const width = 72 + (i % 3) * 22;
      const cloud = ctx.createRadialGradient(x, y, 4, x, y, width);
      cloud.addColorStop(0, i % 2 ? 'rgba(10, 17, 25, 0.96)' : 'rgba(24, 34, 43, 0.96)');
      cloud.addColorStop(0.62, 'rgba(31, 43, 53, 0.82)');
      cloud.addColorStop(1, 'rgba(35, 48, 58, 0)');
      ctx.fillStyle = cloud;
      ctx.beginPath();
      ctx.ellipse(x, y, width, 30 + (i % 2) * 12, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const cycle = time % 26.5;
    const flash = cycle < 0.11 ? 0.24 : cycle > 0.24 && cycle < 0.31 ? 0.13 : 0;
    if (flash > 0) {
      ctx.fillStyle = `rgba(196, 218, 232, ${flash})`;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(225, 238, 248, 0.9)';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(180, 215, 245, 0.95)';
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.moveTo(238, 18); ctx.lineTo(218, 54); ctx.lineTo(231, 54); ctx.lineTo(205, 96);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(190, 211, 224, 0.38)';
    ctx.lineWidth = 0.9;
    for (let i = 0; i < 82; i++) {
      const x = (i * 39.7 + (i % 7) * 11) % W;
      const y = ((i * 53.9 + time * (65 + (i % 5) * 8)) % (H + 30)) - 15;
      const length = 9 + (i % 4) * 2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 4, y + length); ctx.stroke();
    }
    ctx.restore();
  } else if (index === 1) {
    // Sunny open sky: a glowing sun and gently drifting soft clouds.
    ctx.fillStyle = 'rgba(255, 232, 135, 0.95)';
    ctx.beginPath(); ctx.arc(278, 72, 27, 0, Math.PI * 2); ctx.fill();
    drawClouds(time, 'rgba(255,255,255,0.78)');
    ctx.fillStyle = 'rgba(94, 157, 105, 0.48)';
    ctx.beginPath(); ctx.moveTo(0, 330); ctx.quadraticCurveTo(95, 270, 190, 330); ctx.quadraticCurveTo(285, 275, 360, 326); ctx.lineTo(360, 420); ctx.lineTo(0, 420); ctx.fill();
  } else if (index === 2) {
    // Forest: layered evergreen silhouettes sway slightly in the breeze.
    drawClouds(time * 0.35, 'rgba(224,245,221,0.2)');
    for (let layer = 0; layer < 3; layer++) {
      ctx.fillStyle = ['#376d56', '#285b49', '#19483e'][layer];
      for (let i = -1; i < 10; i++) {
        const x = i * 48 + layer * 17 + Math.sin(time * 0.7 + i) * 2;
        const base = 350 + layer * 20;
        const h = 92 + ((i * 17 + 180) % 5) * 13;
        ctx.beginPath();
        ctx.moveTo(x, base); ctx.lineTo(x + 24, base - h); ctx.lineTo(x + 48, base); ctx.closePath(); ctx.fill();
      }
    }
    ctx.fillStyle = '#234d3b'; ctx.fillRect(0, 385, W, 35);
  } else if (index === 3) {
    // Sea: a bright horizon, distant islands and continuously rolling waves.
    ctx.fillStyle = 'rgba(255,238,171,0.9)';
    ctx.beginPath(); ctx.arc( 286, 82, 23, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#397f82';
    ctx.beginPath(); ctx.moveTo(0, 292); ctx.quadraticCurveTo(65, 265, 128, 294); ctx.quadraticCurveTo(180, 312, 235, 282); ctx.lineTo(235, 340); ctx.lineTo(0, 340); ctx.fill();
    for (let row = 0; row < 5; row++) {
      ctx.strokeStyle = row % 2 ? 'rgba(226,250,245,0.55)' : 'rgba(10,112,151,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 8) {
        const y = 315 + row * 19 + Math.sin(x * 0.035 + time * (1.4 + row * 0.13)) * (4 + row);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  } else if (index === 4) {
    // Desert: warm dunes slide slowly past one another under a hazy sun.
    ctx.fillStyle = 'rgba(255,244,190,0.9)';
    ctx.beginPath(); ctx.arc(278, 78, 30, 0, Math.PI * 2); ctx.fill();
    for (let layer = 0; layer < 3; layer++) {
      ctx.fillStyle = ['#e8b66f', '#d99a58', '#bd7949'][layer];
      const shift = (time * (5 + layer * 3)) % 180;
      ctx.beginPath(); ctx.moveTo(-180 - shift, 355 + layer * 17);
      for (let x = -180; x <= W + 180; x += 12) {
        const y = 335 + layer * 22 + Math.sin((x + shift) * 0.012 + layer) * (17 + layer * 3);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W + 180, H); ctx.lineTo(-180 - shift, H); ctx.closePath(); ctx.fill();
    }
    for (let i = 0; i < 22; i++) {
      const x = (i * 67 + time * (8 + i % 3) * (i % 2 ? 1 : -1) + W * 3) % W;
      const y = 230 + (i * 31) % 120;
      ctx.fillStyle = 'rgba(255,246,210,0.5)';
      ctx.fillRect(x, y, 2, 2);
    }
  } else if (index === 5) {
    // Golden sunset: keep the stage-150 scene identical to the gallery's world 28.
    const sun = ctx.createRadialGradient(180, 215, 5, 180, 215, 105);
    sun.addColorStop(0, 'rgba(255, 239, 190, .95)');
    sun.addColorStop(.35, 'rgba(255, 190, 139, .5)');
    sun.addColorStop(1, 'rgba(255, 165, 120, 0)');
    ctx.fillStyle = sun;
    ctx.fillRect(55, 90, 250, 250);

    ctx.fillStyle = '#b66f70';
    ctx.beginPath();
    ctx.moveTo(0, 300);
    ctx.lineTo(55, 265);
    ctx.lineTo(115, 285);
    ctx.lineTo(180, 245);
    ctx.lineTo(245, 282);
    ctx.lineTo(305, 255);
    ctx.lineTo(360, 290);
    ctx.lineTo(360, 420);
    ctx.lineTo(0, 420);
    ctx.fill();

    ctx.fillStyle = '#76556a';
    ctx.beginPath();
    ctx.moveTo(0, 340);
    ctx.lineTo(80, 305);
    ctx.lineTo(145, 335);
    ctx.lineTo(220, 292);
    ctx.lineTo(290, 330);
    ctx.lineTo(360, 300);
    ctx.lineTo(360, 420);
    ctx.lineTo(0, 420);
    ctx.fill();

    ctx.fillStyle = '#4b465d';
    ctx.fillRect(0, 370, 360, 50);
    for (let x = 0; x < 360; x += 18) {
      ctx.fillStyle = 'rgba(255, 232, 190, .18)';
      ctx.fillRect(x, 375 + (x % 3) * 5, 8, 2);
    }
  } else if (index === 6) {
    // Snowy mountains: layered alpine peaks and gently falling snow.
    ctx.fillStyle = 'rgba(255,255,255,0.72)'; ctx.beginPath(); ctx.arc(278,72,22,0,Math.PI*2); ctx.fill();
    for (let layer=0; layer<3; layer++) {
      const base=310+layer*35; ctx.fillStyle=['#6689a8','#456887','#294b6b'][layer];
      ctx.beginPath(); ctx.moveTo(0,base);
      for(let x=0;x<=W;x+=45){const peak=base-75-((Math.floor(x/45)*37+layer*19)%90);ctx.lineTo(x+22,peak);ctx.lineTo(x+45,base);}
      ctx.lineTo(W,H);ctx.lineTo(0,H);ctx.closePath();ctx.fill();
    }
    ctx.fillStyle='rgba(245,250,255,0.9)';
    for(let i=0;i<65;i++){const x=(i*53+Math.sin(time+i)*8)%W;const y=(i*71+time*(15+i%4)*2)%H;ctx.beginPath();ctx.arc(x,y,1+i%2,0,Math.PI*2);ctx.fill();}
  } else if (index === 7) {
    // Volcanic land: glowing crater, lava streams and drifting embers.
    const glow=ctx.createRadialGradient(180,250,8,180,250,170);glow.addColorStop(0,'rgba(255,126,42,0.38)');glow.addColorStop(1,'rgba(255,70,25,0)');
    ctx.fillStyle=glow;ctx.fillRect(0,100,W,320);ctx.fillStyle='#382b38';
    ctx.beginPath();ctx.moveTo(0,355);ctx.lineTo(75,305);ctx.lineTo(142,185);ctx.lineTo(174,220);ctx.lineTo(206,190);ctx.lineTo(285,330);ctx.lineTo(W,360);ctx.lineTo(W,H);ctx.lineTo(0,H);ctx.closePath();ctx.fill();
    ctx.strokeStyle='#ff8b3d';ctx.lineWidth=7;ctx.shadowColor='#ff542b';ctx.shadowBlur=18;ctx.beginPath();ctx.moveTo(174,218);ctx.quadraticCurveTo(160,285,118,355);ctx.moveTo(204,225);ctx.quadraticCurveTo(232,290,260,370);ctx.stroke();ctx.shadowBlur=0;
    ctx.fillStyle='#ffb45e';for(let i=0;i<28;i++){const x=(i*47+Math.sin(time*1.3+i)*15)%W;const y=160+((i*61-time*(12+i%4)*5+1800)%230);ctx.globalAlpha=.45+(i%4)*.13;ctx.beginPath();ctx.arc(x,y,1+i%3,0,Math.PI*2);ctx.fill();}ctx.globalAlpha=1;
  } else if (index === 8) {
    // Tehran at golden hour: Alborz foothills, Milad Tower, Azadi Tower and a dense city skyline.
    const haze=ctx.createRadialGradient(180,205,12,180,205,220);
    haze.addColorStop(0,'rgba(255,218,166,0.32)');haze.addColorStop(1,'rgba(255,190,145,0)');
    ctx.fillStyle=haze;ctx.fillRect(0,70,W,H-70);
    // Alborz mountain range in the distance.
    ctx.fillStyle='#887b83';ctx.beginPath();ctx.moveTo(0,282);
    ctx.lineTo(34,220);ctx.lineTo(55,244);ctx.lineTo(91,178);ctx.lineTo(119,225);
    ctx.lineTo(151,190);ctx.lineTo(184,242);ctx.lineTo(224,183);ctx.lineTo(251,222);
    ctx.lineTo(286,170);ctx.lineTo(316,226);ctx.lineTo(342,198);ctx.lineTo(360,232);
    ctx.lineTo(360,350);ctx.lineTo(0,350);ctx.closePath();ctx.fill();
    ctx.fillStyle='rgba(255,231,215,0.7)';ctx.beginPath();ctx.moveTo(77,203);ctx.lineTo(91,178);ctx.lineTo(105,203);ctx.lineTo(96,198);ctx.lineTo(90,188);ctx.lineTo(84,199);ctx.closePath();ctx.fill();
    ctx.fillStyle='#b17d75';ctx.beginPath();ctx.moveTo(0,275);ctx.lineTo(50,242);ctx.lineTo(94,266);ctx.lineTo(145,230);ctx.lineTo(195,267);ctx.lineTo(248,228);ctx.lineTo(302,263);ctx.lineTo(360,235);ctx.lineTo(360,370);ctx.lineTo(0,370);ctx.closePath();ctx.fill();
    // Distant apartment blocks and warm windows.
    for(let i=0;i<22;i++){const x=i*17-5;const h=34+((i*29)%65);ctx.fillStyle=i%3?'#665d68':'#79636a';ctx.fillRect(x,350-h,14,h+30);
      ctx.fillStyle='rgba(255,219,154,0.72)';for(let wy=360-h;wy<375;wy+=12)if((i+wy)%3!==0)ctx.fillRect(x+4,wy,3,5);}
    // Milad Tower, with its distinctive mast and broad observation pod.
    ctx.save();ctx.strokeStyle='#514b5b';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(272,351);ctx.lineTo(276,150);ctx.stroke();
    ctx.fillStyle='#514b5b';ctx.beginPath();ctx.moveTo(263,224);ctx.lineTo(289,224);ctx.lineTo(284,235);ctx.lineTo(268,235);ctx.closePath();ctx.fill();
    ctx.fillRect(271,236,10,5);ctx.beginPath();ctx.moveTo(272,150);ctx.lineTo(276,139);ctx.lineTo(279,150);ctx.fill();ctx.restore();
    // Azadi Tower silhouette in the foreground.
    ctx.fillStyle='#e4d0b2';ctx.beginPath();ctx.moveTo(48,370);ctx.lineTo(57,315);ctx.quadraticCurveTo(72,298,87,315);ctx.lineTo(96,370);ctx.closePath();ctx.fill();
    ctx.fillStyle='#8b6c70';ctx.beginPath();ctx.moveTo(61,321);ctx.quadraticCurveTo(72,306,83,321);ctx.lineTo(80,333);ctx.lineTo(64,333);ctx.closePath();ctx.fill();
    ctx.fillStyle='#d9c2a7';ctx.fillRect(69,333,7,37);
    // City foreground and a few moving traffic lights.
    ctx.fillStyle='#403d50';ctx.fillRect(0,370,W,50);
    for(let i=0;i<28;i++){const x=(i*41+time*(i%2?5:-3)+W*4)%W;ctx.globalAlpha=.5+.3*Math.sin(time*2+i);ctx.fillStyle=i%2?'#ffd58c':'#ff9b78';ctx.fillRect(x,393+(i%3)*7,3,1.5);}
    ctx.globalAlpha=1;
  } else if (index === 9) {
    // Cyberpunk skyline with neon architecture and animated light trails.
    for(let i=0;i<13;i++){const x=i*30-5,height=95+((i*43)%155);ctx.fillStyle=i%2?'#171a46':'#24204f';ctx.fillRect(x,360-height,26,height+60);ctx.fillStyle=i%3?'rgba(73,224,255,0.78)':'rgba(255,82,184,0.8)';for(let y=375-height;y<395;y+=18){if((i+y)%3)ctx.fillRect(x+6,y,3,7);}}
    ctx.save();ctx.shadowBlur=13;for(let i=0;i<5;i++){const y=115+i*43+Math.sin(time*1.2+i)*5;ctx.strokeStyle=i%2?'rgba(70,225,255,0.7)':'rgba(255,76,190,0.72)';ctx.shadowColor=ctx.strokeStyle;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}ctx.restore();ctx.fillStyle='#101333';ctx.fillRect(0,405,W,15);
  } else if (index === 10) {
    // Cosmic space: a soft nebula, stars and a ringed distant planet.
    const nebula=ctx.createRadialGradient(115,185,5,115,185,170);nebula.addColorStop(0,'rgba(176,94,220,0.34)');nebula.addColorStop(1,'rgba(76,65,160,0)');
    ctx.fillStyle=nebula;ctx.fillRect(0,0,W,H);ctx.save();ctx.translate(270,112);ctx.rotate(-.24);ctx.strokeStyle='rgba(219,196,255,0.8)';ctx.lineWidth=5;ctx.beginPath();ctx.ellipse(0,0,53,16,0,0,Math.PI*2);ctx.stroke();
    const planet=ctx.createRadialGradient(-12,-14,3,0,0,31);planet.addColorStop(0,'#e4c8ff');planet.addColorStop(1,'#6755a8');ctx.fillStyle=planet;ctx.beginPath();ctx.arc(0,0,29,0,Math.PI*2);ctx.fill();ctx.restore();
    for(let i=0;i<90;i++){const x=(i*47.3+(i%5)*13)%W,y=(i*83.7)%H;ctx.globalAlpha=.45+.45*Math.sin(time*(1+i%3)+i);ctx.fillStyle='#fff4ff';ctx.beginPath();ctx.arc(x,y,.7+(i%3)*.45,0,Math.PI*2);ctx.fill();}ctx.globalAlpha=1;
  } else {
    drawNewWorld(index, time);
  }

  const shade = ctx.createLinearGradient(0, H * 0.58, 0, H);
  shade.addColorStop(0, 'rgba(15,25,35,0)');
  shade.addColorStop(1, 'rgba(15,25,35,0.18)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, W, H);
}


function drawNewWorld(index: number, time: number) {
  const stars=(n:number)=>{for(let i=0;i<n;i++){ctx.globalAlpha=.5+.4*Math.sin(time+i);ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(i*53%W,(i*79+Math.sin(time+i)*5)%300,1+i%2,0,Math.PI*2);ctx.fill();}ctx.globalAlpha=1;};
  if(index===11){const g=ctx.createRadialGradient(180,205,5,180,205,150);g.addColorStop(0,'rgba(255,225,250,.55)');g.addColorStop(1,'rgba(90,60,160,0)');ctx.fillStyle=g;ctx.fillRect(20,35,320,340);ctx.strokeStyle='rgba(250,225,255,.55)';ctx.lineWidth=2;for(let r=0;r<4;r++){ctx.beginPath();ctx.arc(180,205,55+r*23+Math.sin(time+r)*2,0,Math.PI*2);ctx.stroke();}ctx.fillStyle='#292344';ctx.beginPath();ctx.arc(180,150,17,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.moveTo(165,173);ctx.quadraticCurveTo(140,230,153,265);ctx.quadraticCurveTo(180,280,207,265);ctx.quadraticCurveTo(220,230,195,173);ctx.fill();ctx.beginPath();ctx.ellipse(180,278,60,15,0,0,Math.PI*2);ctx.fill();['#ff5c70','#ffad50','#f5df65','#75e39c','#69dfea','#72a5ff','#d0a0ff'].forEach((c,i)=>{ctx.fillStyle=c;ctx.shadowColor=c;ctx.shadowBlur=14;ctx.beginPath();ctx.arc(180,255-i*17,5,0,Math.PI*2);ctx.fill();});ctx.shadowBlur=0;stars(25);}
  else if(index===12){ctx.strokeStyle='#d7baff';ctx.lineWidth=3;for(let i=0;i<5;i++){ctx.beginPath();ctx.ellipse(180,205,45+i*17,90+i*17,Math.sin(time*.3)*.04,0,Math.PI*2);ctx.stroke();}ctx.fillStyle='#30264e';[25,85,250,310].forEach(x=>ctx.fillRect(x,150,18,270));stars(30);}
  else if(index===13){ctx.fillStyle='#d0bda0';for(let i=0;i<5;i++){const x=20+i*75;ctx.fillRect(x,180,14,240);ctx.fillRect(x-8,175,30,9);}ctx.beginPath();ctx.arc(180,220,20,0,Math.PI*2);ctx.fill();ctx.fillRect(162,240,36,70);ctx.beginPath();ctx.ellipse(180,310,42,13,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='rgba(255,230,180,.7)';ctx.beginPath();ctx.arc(285,80,25,0,Math.PI*2);ctx.fill();}
  else if(index===14){ctx.fillStyle='rgba(255,110,165,.35)';ctx.beginPath();ctx.arc(180,150,120,0,Math.PI*2);ctx.fill();ctx.fillStyle='#ffb5d0';ctx.font='bold 120px serif';ctx.textAlign='center';ctx.fillText('♥',180,180);ctx.fillStyle='#211d3d';[148,211].forEach((x,i)=>{ctx.beginPath();ctx.arc(x,260-i*5,16,0,Math.PI*2);ctx.fill();ctx.fillRect(x-14,276-i*5,28,80);});stars(35);}
  else if(index===15){ctx.fillStyle='#e7e1ff';ctx.beginPath();ctx.arc(270,95,40,0,Math.PI*2);ctx.fill();ctx.fillStyle='#252744';ctx.beginPath();ctx.moveTo(0,350);ctx.lineTo(85,260);ctx.lineTo(145,330);ctx.lineTo(225,235);ctx.lineTo(360,355);ctx.lineTo(360,420);ctx.lineTo(0,420);ctx.fill();ctx.fillStyle='#11172c';ctx.beginPath();ctx.arc(180,303,8,0,Math.PI*2);ctx.fill();ctx.fillRect(175,311,10,48);stars(55);}
  else if(index===16){ctx.save();ctx.translate(180,205);for(let i=0;i<3;i++){ctx.save();ctx.rotate(time*.25+i*Math.PI/3);ctx.strokeStyle=['#75edff','#d5a6ff','#8dffce'][i];ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(0,0,105,37,0,0,Math.PI*2);ctx.stroke();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(105,0,5,0,Math.PI*2);ctx.fill();ctx.restore();}ctx.fillStyle='#ffe8a6';ctx.shadowColor='#7ceaff';ctx.shadowBlur=20;ctx.beginPath();ctx.arc(0,0,14,0,Math.PI*2);ctx.fill();ctx.restore();stars(50);}
  else if(index===17){ctx.strokeStyle='rgba(80,255,145,.4)';for(let x=10;x<W;x+=24){ctx.beginPath();ctx.moveTo(180,160);ctx.lineTo(x,410);ctx.stroke();}ctx.fillStyle='#70ff9b';ctx.font='13px monospace';for(let i=0;i<18;i++)ctx.fillText('0101',(i*29)%W,(i*37+time*35)%390);ctx.fillStyle='#071c1b';ctx.fillRect(145,190,70,180);ctx.fillStyle='#c4ffd5';ctx.beginPath();ctx.arc(180,180,13,0,Math.PI*2);ctx.fill();}
  else if(index===18){const g=ctx.createRadialGradient(180,205,3,180,205,155);g.addColorStop(0,'#fff2cb');g.addColorStop(.2,'#f3a8ed');g.addColorStop(.6,'rgba(103,115,231,.5)');g.addColorStop(1,'rgba(20,25,75,0)');ctx.fillStyle=g;ctx.fillRect(0,35,W,340);ctx.save();ctx.translate(180,205);ctx.rotate(time*.03);for(let a=0;a<2;a++){ctx.strokeStyle=a?'#b4c3ff':'#ffb4e6';ctx.lineWidth=7;ctx.beginPath();for(let t=0;t<Math.PI*4;t+=.08){const r=4+t*8,x=Math.cos(t+a*Math.PI)*r,y=Math.sin(t+a*Math.PI)*r*.48;if(!t)ctx.moveTo(x,y);else ctx.lineTo(x,y);}ctx.stroke();}ctx.restore();stars(85);}
  else if(index===19){for(let i=0;i<6;i++){const y=350-i*35;ctx.fillStyle='rgba(220,220,255,.5)';ctx.fillRect(95+i*10,y,170-i*20,12);ctx.beginPath();ctx.ellipse(180,y,90-i*9,15,0,0,Math.PI*2);ctx.fill();}ctx.strokeStyle='#ffe6ff';ctx.lineWidth=5;ctx.beginPath();ctx.arc(180,155,57,Math.PI,0);ctx.lineTo(237,300);ctx.lineTo(123,300);ctx.closePath();ctx.stroke();stars(35);}
  else if(index===20){ctx.strokeStyle='#f5d9a5';ctx.lineWidth=7;ctx.beginPath();ctx.moveTo(135,95);ctx.lineTo(225,95);ctx.lineTo(185,205);ctx.lineTo(225,315);ctx.lineTo(135,315);ctx.lineTo(175,205);ctx.closePath();ctx.stroke();ctx.fillStyle='#ffdc96';ctx.beginPath();ctx.moveTo(145,108);ctx.lineTo(215,108);ctx.lineTo(180,190);ctx.closePath();ctx.fill();ctx.beginPath();ctx.moveTo(180,220);ctx.lineTo(215,302);ctx.lineTo(145,302);ctx.closePath();ctx.fill();stars(55);}
  else if(index===21){ctx.fillStyle='#2d665b';ctx.beginPath();ctx.moveTo(0,210);ctx.lineTo(70,95);ctx.lineTo(140,215);ctx.lineTo(225,70);ctx.lineTo(360,225);ctx.lineTo(360,420);ctx.lineTo(0,420);ctx.fill();ctx.fillStyle='#a0ebf0';ctx.fillRect(145,155,70,185);ctx.strokeStyle='#efffff';for(let i=0;i<7;i++){ctx.beginPath();ctx.moveTo(145+i*10,180);ctx.lineTo(145+i*10+Math.sin(time*2+i)*4,330);ctx.stroke();}for(let i=0;i<9;i++){ctx.fillStyle=i%2?'#174c3d':'#28634a';ctx.beginPath();ctx.moveTo(i*43,375);ctx.lineTo(i*43+21,260-i%3*22);ctx.lineTo(i*43+42,375);ctx.fill();}}
  else if(index===22){const pts=[];for(let i=0;i<18;i++)pts.push({x:65+i*71%230,y:85+i*47%235});ctx.strokeStyle='rgba(160,220,255,.6)';for(let i=0;i<pts.length;i++)for(let j=i+1;j<pts.length;j++)if(Math.hypot(pts[i].x-pts[j].x,pts[i].y-pts[j].y)<95){ctx.beginPath();ctx.moveTo(pts[i].x,pts[i].y);ctx.lineTo(pts[j].x,pts[j].y);ctx.stroke();}pts.forEach((p,i)=>{ctx.fillStyle=i%3?'#9feaff':'#e2b9ff';ctx.beginPath();ctx.arc(p.x,p.y,4,0,Math.PI*2);ctx.fill();});stars(25);}
  else if(index===23){ctx.fillStyle='#53677d';ctx.beginPath();ctx.moveTo(0,390);ctx.lineTo(180,155);ctx.lineTo(360,390);ctx.lineTo(360,420);ctx.lineTo(0,420);ctx.fill();ctx.fillStyle='#17243a';ctx.beginPath();ctx.arc(180,190,10,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#17243a';ctx.lineWidth=8;ctx.beginPath();ctx.moveTo(180,202);ctx.lineTo(180,270);ctx.moveTo(180,215);ctx.lineTo(140,180);ctx.moveTo(180,215);ctx.lineTo(220,180);ctx.stroke();stars(30);}
  else if(index===24){ctx.save();ctx.translate(180,205);ctx.rotate(time*.12);ctx.fillStyle='#f5e9c8';ctx.beginPath();ctx.arc(0,0,83,0,Math.PI*2);ctx.fill();ctx.fillStyle='#203b59';ctx.beginPath();ctx.arc(0,0,83,-Math.PI/2,Math.PI/2);ctx.fill();ctx.arc(0,-41,41,Math.PI/2,-Math.PI/2,true);ctx.arc(0,41,41,-Math.PI/2,Math.PI/2,true);ctx.fill();ctx.fillStyle='#203b59';ctx.beginPath();ctx.arc(0,-41,12,0,Math.PI*2);ctx.fill();ctx.fillStyle='#f5e9c8';ctx.beginPath();ctx.arc(0,41,12,0,Math.PI*2);ctx.fill();ctx.restore();stars(30);}
  else {const g=ctx.createRadialGradient(180,210,12,180,210,150);g.addColorStop(0,'rgba(255,226,160,.65)');g.addColorStop(.45,'rgba(174,117,255,.28)');g.addColorStop(1,'rgba(90,70,160,0)');ctx.fillStyle=g;ctx.fillRect(20,40,320,340);for(let r=0;r<4;r++){ctx.strokeStyle='rgba(255,220,170,'+(.3-r*.05)+')';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(180,215,65+r*20,95+r*20,0,0,Math.PI*2);ctx.stroke();}ctx.fillStyle='#292344';ctx.beginPath();ctx.arc(180,150,17,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.moveTo(165,173);ctx.quadraticCurveTo(140,230,153,265);ctx.quadraticCurveTo(180,280,207,265);ctx.quadraticCurveTo(220,230,195,173);ctx.fill();ctx.beginPath();ctx.ellipse(180,278,60,15,0,0,Math.PI*2);ctx.fill();['#ff5c70','#ffad50','#f5df65','#75e39c','#69dfea','#72a5ff','#d0a0ff'].forEach((c,i)=>{ctx.fillStyle=c;ctx.shadowColor=c;ctx.shadowBlur=14;ctx.beginPath();ctx.arc(180,255-i*17,5,0,Math.PI*2);ctx.fill();});ctx.shadowBlur=0;stars(25);}
}

function drawClouds(time: number, color: string) {
  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < 5; i++) {
    const x = ((i * 91 + time * (5 + i)) % (W + 120)) - 60;
    const y = 58 + (i % 3) * 46;
    ctx.beginPath();
    ctx.ellipse(x, y, 30, 11, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 18, y - 7, 23, 15, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 37, y, 27, 10, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** A lattice tower standing up from the origin: crossed braces in each square bay. */
function drawTower(w: number, len: number) {
  ctx.beginPath();
  ctx.rect(-w / 2, -len, w, len + 40);
  let flip = false;
  for (let y = -len; y < 0; y += w * 0.8) {
    const e = Math.min(y + w * 0.8, 0);
    ctx.moveTo(flip ? w / 2 : -w / 2, y); ctx.lineTo(flip ? -w / 2 : w / 2, e);
    ctx.moveTo(-w / 2, e); ctx.lineTo(w / 2, e);
    flip = !flip;
  }
  ctx.lineWidth = 7;
  if (world.score >= 800) {
    ctx.strokeStyle = '#050505';
    ctx.shadowBlur = 0;
  }
  ctx.stroke();
}

// A distinct outline color for each environment, blended with the same visual transition as the backdrop.
const cubeOutlineColors = ["#70d7ff","#ffd166","#8ee6a1","#55d9e8","#f4b56b","#8bb8ff","#d8efff","#ff784e","#ffd27a","#55eaff","#b99aff","#ff9fcf","#c7a7ff","#f1d6a4","#ff8fb4","#b6c9ff","#79f1e1","#79ffad","#e5a8ff","#c8d9ff","#ffe1a0","#83e5c4","#a6dfff","#d6e1f0","#f5e9c8","#ffd18a"];
function currentCubeOutlineColor() {
  if (world.score >= 800) return '#ff8fcf';
  const original = [190, 205, 216];
  const colorAt = (index: number) => index === 0
    ? original
    : index === 26
      ? [20, 86, 160]
      : index === 27
        ? [255, 139, 120]
        : index === 29
          ? [255, 255, 255]
          : [1, 3, 5].map((i) => Number.parseInt((cubeOutlineColors[index] ?? cubeOutlineColors[0]).slice(i, i + 2), 16));
  if (previousBackdropIndex === 0 && backdropIndex === 0) return 'rgba(190, 205, 216, 0.72)';
  const from = colorAt(previousBackdropIndex);
  const to = colorAt(backdropIndex);
  const t = backdropTransitionAge * backdropTransitionAge * (3 - 2 * backdropTransitionAge);
  const channel = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${channel(from[0], to[0])}, ${channel(from[1], to[1])}, ${channel(from[2], to[2])})`;
}

/** The cube, with a pair of eyes looking ahead. */
function drawCube(x: number, bottom: number, tilt: number, supportAngle = 0, scaleX = 1, scaleY = 1) {
  const p = palette;
  const surfaceGap = 2.5; // keep the cube's lower edge visually distinct from the tower top
  ctx.save();
  ctx.translate(
    x + CUBE / 2 + surfaceGap * Math.sin(rad(supportAngle)),
    bottom - CUBE / 2 - surfaceGap * Math.cos(rad(supportAngle)),
  );
  ctx.rotate(rad(tilt));
  // Scale around the cube centre; keep all physics coordinates independent from this effect.
  ctx.scale(scaleX, scaleY);
  const endlessWorld = world.score >= 800;
  const rainbowEra = world.score >= 840;
  if (rainbowEra) {
    ctx.fillStyle = '#05090e';
  } else if (endlessWorld) {
    const rainbowCube = ctx.createLinearGradient(-CUBE / 2, -CUBE / 2, CUBE / 2, CUBE / 2);
    ['#ff3158', '#ff9c35', '#ffe45c', '#54e879', '#36d9ff', '#5478ff', '#c66bff'].forEach((color, i, colors) => {
      rainbowCube.addColorStop(i / (colors.length - 1), color);
    });
    ctx.fillStyle = rainbowCube;
  } else {
    ctx.fillStyle = '#05090e';
  }
  ctx.beginPath();
  ctx.rect(-CUBE / 2, -CUBE / 2, CUBE, CUBE);
  ctx.fill();
  if (rainbowEra) {
    const rainbowOutline = ctx.createLinearGradient(-CUBE / 2, -CUBE / 2, CUBE / 2, CUBE / 2);
    const colors = ['#ff3158', '#ff9c35', '#ffe45c', '#54e879', '#36d9ff', '#5478ff', '#c66bff'];
    colors.forEach((color, i) => rainbowOutline.addColorStop(i / (colors.length - 1), color));
    ctx.strokeStyle = rainbowOutline;
  } else {
    ctx.strokeStyle = endlessWorld ? '#ff8fcf' : currentCubeOutlineColor();
  }
  ctx.lineWidth = 1.8;
  ctx.stroke();
  // White eyes from stage 840; keep the blue eye palette for stages 800–839.
  ctx.fillStyle = rainbowEra ? '#ffffff' : endlessWorld ? '#36a9ff' : p.paper;
  for (const ex of [CUBE / 2 - 20, CUBE / 2 - 8]) {
    ctx.beginPath();
    ctx.arc(ex, -CUBE / 2 + 12, 5.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = rainbowEra ? '#05090e' : endlessWorld ? '#eaf8ff' : '#05090e';
  for (const ex of [CUBE / 2 - 18.2, CUBE / 2 - 6.2]) {
    ctx.beginPath();
    ctx.arc(ex, -CUBE / 2 + 12.5, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
