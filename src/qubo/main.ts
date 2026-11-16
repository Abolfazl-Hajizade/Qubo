import { $, Screens, onVisibility } from '../shared/screens';
import { createHistory, loadJSON, saveJSON } from '../shared/store';
import { CUBE, H, W, type World, createWorld, launch, pivotX, step, towerLen } from './engine';

const rad = (d: number) => (d * Math.PI) / 180;

// Qubo: the tower tips over toward the next one; tap at the right moment to throw the cube onto it. Only the best score is saved.

const BEST_KEY = 'qubo.best';
// Runs and history for the stats page, like the other arcade games'. Qubo shows only its best, so nothing here is on screen.
const STATS_KEY = 'qubo.stats';
const history = createHistory<{ endedAt: number; score: number; best: boolean }>('qubo.history');
const MAX_DT = 1 / 30;
const numberFormat = new Intl.NumberFormat();

let world: World = createWorld();
let raf = 0;
let last = 0;
let paused = false;
let started = false;
let best = loadJSON<number>(BEST_KEY, 0);

const canvas = $<HTMLCanvasElement>('stage');
const ctx = canvas.getContext('2d')!;
const frame = canvas.parentElement!;
const endDialog = $<HTMLDialogElement>('end-dialog');

const screens = new Screens({ leaveGame: stopLoop, renderHome });

type TelegramWebApp = { initData: string; ready?: () => void; expand?: () => void };
const telegramWebApp = (window as Window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
telegramWebApp?.ready?.();
telegramWebApp?.expand?.();

$('play-btn').addEventListener('click', start);
$('leaderboard-btn').addEventListener('click', openLeaderboard);
$('leaderboard-close').addEventListener('click', () => $<HTMLDialogElement>('leaderboard-dialog').close());
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

renderHome();

function renderHome() {
  $('home-best').textContent = best ? `Best ${numberFormat.format(best)}` : '';
}

function start() {
  if (endDialog.open) endDialog.close();
  world = createWorld();
  paused = false;
  started = false;
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
  if (!started) { started = true; setStatus(''); last = performance.now(); return; } // the first tap only starts the tower tipping
  launch(world);
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
  if (world.score > 0) void submitScore(world.score);
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
  const dt = Math.min(MAX_DT, (now - last) / 1000);
  last = now;
  if (started && !paused) {
    const was = world.over;
    step(world, dt);
    setScore();
    if (world.over && !was) finish();
  }
  draw();
  raf = requestAnimationFrame(loop);
}

interface LeaderboardEntry {
  rank: number;
  display_name: string;
  best_score: number;
  telegram_user_id: string;
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

async function openLeaderboard() {
  const dialog = $<HTMLDialogElement>('leaderboard-dialog');
  const status = $('leaderboard-status');
  const list = $('leaderboard-list');
  const me = $('leaderboard-me');
  list.replaceChildren();
  me.textContent = '';
  dialog.showModal();

  const initData = telegramWebApp?.initData;
  if (!initData) {
    status.textContent = 'برای دیدن رکوردهای جهانی، بازی را از داخل ربات تلگرام باز کن.';
    return;
  }

  status.textContent = 'در حال دریافت رکوردها...';
  try {
    const response = await fetch('/api/leaderboard', {
      headers: { 'x-telegram-init-data': initData },
    });
    const data = await response.json() as {
      error?: string;
      entries?: LeaderboardEntry[];
      me?: { rank: number; best_score: number } | null;
    };
    if (!response.ok) throw new Error(data.error || 'دریافت رکوردها ناموفق بود');
    const entries = data.entries ?? [];
    if (!entries.length) {
      status.textContent = 'هنوز رکوردی ثبت نشده؛ اولین نفر باش!';
    } else {
      status.textContent = '۵۰ رکورد برتر بازیکنان';
      for (const entry of entries) {
        const item = document.createElement('li');
        item.textContent = `#${entry.rank}  ${entry.display_name} — ${numberFormat.format(entry.best_score)}`;
        if (entry.telegram_user_id && data.me && entry.rank === data.me.rank) item.classList.add('is-me');
        list.append(item);
      }
    }
    me.textContent = data.me
      ? `رتبه تو: #${data.me.rank}  |  رکورد: ${numberFormat.format(data.me.best_score)}`
      : 'هنوز رکوردی برای تو ثبت نشده است.';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'خطا در دریافت رکوردها';
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
    // Keep the current tower and its next destination visible; reveal one extra tower in flight.
    if (i >= 2 && world.phase !== 'air' && world.phase !== 'drop' && !((world.phase === 'scroll' || world.phase === 'rescue') && i <= world.landed + 1)) return;
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

  drawCube(world.cubeX, world.cubeY, world.cubeAngle);
  ctx.restore();

  // A single understated ground line remains beneath the towers.
  ctx.strokeStyle = p.tint;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, H - 1);
  ctx.lineTo(W, H - 1);
  ctx.stroke();
}

/** Ominous storm sky: layered charcoal clouds, slanting rain and distant lightning. */
function drawWeatherBackground() {
  const time = performance.now() / 1000;
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#101923');
  sky.addColorStop(0.48, '#27333d');
  sky.addColorStop(1, '#46515a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Heavy storm-cloud layers drift slowly across the sky.
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
  ctx.restore();

  // A brief, irregular lightning glow lights the clouds from far away.
  const cycle = time % 11.5;
  const flash = cycle < 0.11 ? 0.24 : cycle > 0.24 && cycle < 0.31 ? 0.13 : 0;
  if (flash > 0) {
    ctx.fillStyle = `rgba(196, 218, 232, ${flash})`;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.strokeStyle = 'rgba(225, 238, 248, 0.9)';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(180, 215, 245, 0.95)';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.moveTo(238, 18);
    ctx.lineTo(218, 54);
    ctx.lineTo(231, 54);
    ctx.lineTo(205, 96);
    ctx.stroke();
    ctx.restore();
  }

  // Dense, fine rain; the movement stays subtle enough not to hide the towers.
  ctx.save();
  ctx.strokeStyle = 'rgba(190, 211, 224, 0.38)';
  ctx.lineWidth = 0.9;
  for (let i = 0; i < 82; i++) {
    const x = (i * 39.7 + (i % 7) * 11) % W;
    const y = ((i * 53.9 + time * (65 + (i % 5) * 8)) % (H + 30)) - 15;
    const length = 9 + (i % 4) * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 4, y + length);
    ctx.stroke();
  }
  ctx.restore();

  // Darken the lower edge for a colder, more threatening atmosphere.
  const vignette = ctx.createLinearGradient(0, H * 0.55, 0, H);
  vignette.addColorStop(0, 'rgba(8, 14, 20, 0)');
  vignette.addColorStop(1, 'rgba(8, 14, 20, 0.28)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);
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
  ctx.lineWidth = 5.5;
  ctx.stroke();
}

/** The cube, with a pair of eyes looking ahead. */
function drawCube(x: number, bottom: number, tilt: number) {
  const p = palette;
  ctx.save();
  ctx.translate(x + CUBE / 2, bottom - CUBE / 2); // rotate around the cube's centre
  ctx.rotate(rad(tilt));
  ctx.fillStyle = '#05090e';
  ctx.beginPath();
  ctx.rect(-CUBE / 2, -CUBE / 2, CUBE, CUBE);
  ctx.fill();
  ctx.strokeStyle = 'rgba(190, 205, 216, 0.72)';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.fillStyle = p.paper;
  for (const ex of [CUBE / 2 - 19, CUBE / 2 - 7]) {
    ctx.beginPath();
    ctx.arc(ex, -CUBE / 2 + 12, 5.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
