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
  const dialog = $('leaderboard-dialog') as HTMLDialogElement;
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
  ctx.fillStyle = p.sheet;
  ctx.fillRect(0, 0, W, H);

  // Far clouds drift with the camera, slower than the towers.
  ctx.fillStyle = p.tint;
  for (let i = -1; i < 5; i++) {
    const x = i * 120 - ((world.cam * 0.3) % 120);
    ctx.beginPath();
    ctx.ellipse(x + 60, 120 + (i & 1) * 40, 46, 16, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.save();
  ctx.translate(-world.cam, 0);
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = p.ink;
  ctx.fillStyle = p.sheet;
  // The tower the cube stands on tips over from the middle of its base; the next one stands still.
  world.towers.forEach((t, i) => {
    if (i === 0 && world.phase !== 'wait') return; // once the cube has left, that tower is drawn toppling below
    ctx.save();
    ctx.translate(pivotX(t), H);
    if (i === 0 && world.phase === 'wait') ctx.rotate(rad(world.angle));
    else if (world.phase === 'scroll' && i === world.landed) ctx.rotate(rad(world.angle));
    const len = towerLen(t);
    // Withdraw the standing tower progressively from its base toward its top.
    // By the time the cube is launched, the source tower is almost completely gone.
    const withdrawal = i === 0 && world.phase === 'wait'
      ? len * Math.min(1, Math.max(0, world.angle) / 72)
      : 0;
    drawTower(t.w, len, withdrawal);
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
}

/** A lattice tower standing up from the origin: crossed braces in each square bay. */
function drawTower(w: number, len: number, withdrawn = 0) {
  const bottom = -Math.min(len, Math.max(0, withdrawn));
  const visibleHeight = Math.max(0, len + bottom);
  if (visibleHeight <= 0) return;
  // Clip away the lower section first, so the tower seems to retreat upward.
  const extraBase = withdrawn <= 0 ? 40 : 0;
  ctx.fillRect(-w / 2, -len, w, visibleHeight + extraBase);
  ctx.beginPath();
  ctx.rect(-w / 2, -len, w, visibleHeight + extraBase);
  let flip = false;
  for (let y = -len; y < bottom; y += w * 0.8) {
    const e = Math.min(y + w * 0.8, bottom);
    ctx.moveTo(flip ? w / 2 : -w / 2, y); ctx.lineTo(flip ? -w / 2 : w / 2, e);
    ctx.moveTo(-w / 2, e); ctx.lineTo(w / 2, e);
    flip = !flip;
  }
  ctx.stroke();
}

/** The cube, with a pair of eyes looking ahead. */
function drawCube(x: number, bottom: number, tilt: number) {
  const p = palette;
  ctx.save();
  ctx.translate(x + CUBE / 2, bottom - CUBE / 2); // rotate around the cube's centre
  ctx.rotate(rad(tilt));
  ctx.fillStyle = p.cube;
  ctx.beginPath();
  ctx.rect(-CUBE / 2, -CUBE / 2, CUBE, CUBE);
  ctx.fill();
  ctx.fillStyle = p.paper;
  for (const ex of [CUBE / 2 - 16, CUBE / 2 - 7]) {
    ctx.beginPath();
    ctx.arc(ex, -CUBE / 2 + 11, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
