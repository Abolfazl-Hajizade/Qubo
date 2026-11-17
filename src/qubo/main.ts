import { $, Screens, dateFormat, onVisibility } from '../shared/screens';
import { createHistory, loadJSON, saveJSON } from '../shared/store';
import { CUBE, H, W, type World, createWorld, launch, pivotX, step, towerLen } from './engine';

const rad = (d: number) => (d * Math.PI) / 180;

// Qubo: the tower tips over toward the next one; tap at the right moment to throw the cube onto it. Only the best score is saved.

const BEST_KEY = 'qubo.best';
// Runs and history for the stats page, like the other arcade games'. Qubo shows only its best, so nothing here is on screen.
const STATS_KEY = 'qubo.stats';
const PROGRESS_KEY = 'qubo.progress';
const CHECKPOINT_STEP = 30;
const history = createHistory<{ endedAt: number; score: number; best: boolean }>('qubo.history');
const MAX_DT = 1 / 30;
const numberFormat = new Intl.NumberFormat();

let world: World = createWorld();
let raf = 0;
let last = 0;
let paused = false;
let started = false;
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

type TelegramWebApp = { initData: string; ready?: () => void; expand?: () => void };
const telegramWebApp = (window as Window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
telegramWebApp?.ready?.();
telegramWebApp?.expand?.();

$('play-btn').addEventListener('click', start);
$('leaderboard-btn').addEventListener('click', () => screens.records());
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

function start() {
  if (endDialog.open) endDialog.close();
  world = createWorld(Math.random, checkpoint);
  paused = false;
  started = false;
  landingAgeVisual = Infinity;
  takeoffAgeVisual = Infinity;
  backdropIndex = Math.floor(world.score / 30) % 26;
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
  if (!started) { started = true; setStatus(''); last = performance.now(); return; } // the first tap only starts the tower tipping
  launch(world);
  if (world.phase === 'air' || world.phase === 'rescue') {
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
    const previousPhase = world.phase;
    step(world, dt);
    if ((previousPhase === 'air' || previousPhase === 'rescue') && world.phase === 'scroll') landingAgeVisual = 0;
    if (landingAgeVisual < 2) landingAgeVisual += dt;
    if (takeoffAgeVisual < 1) takeoffAgeVisual += dt;
    setScore();
    const reachedCheckpoint = Math.floor(world.score / CHECKPOINT_STEP) * CHECKPOINT_STEP;
    if (reachedCheckpoint > checkpoint) {
      checkpoint = reachedCheckpoint;
      saveJSON(PROGRESS_KEY, checkpoint);
    }
    const nextBackdrop = Math.floor(world.score / 30) % 26;
    if (nextBackdrop !== backdropIndex) {
      previousBackdropIndex = backdropIndex;
      backdropIndex = nextBackdrop;
      backdropTransitionAge = 0;
    }
    if (backdropTransitionAge < 1) backdropTransitionAge = Math.min(1, backdropTransitionAge + dt / 1.1);
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

async function loadLeaderboard() {
  const status = $('records-status');
  const list = $('records-list');
  const me = $('records-me');
  list.replaceChildren();
  me.textContent = '';

  const initData = telegramWebApp?.initData;
  if (!initData) {
    status.textContent = 'Open the game from the Telegram bot to view the global leaderboard.';
    return;
  }

  status.textContent = 'Loading leaderboard...';
  try {
    const response = await fetch('/api/leaderboard', {
      headers: { 'x-telegram-init-data': initData },
    });
    const data = await response.json() as {
      error?: string;
      entries?: LeaderboardEntry[];
      me?: { rank: number; best_score: number } | null;
    };
    if (!response.ok) throw new Error(data.error || 'Could not load leaderboard');
    const entries = data.entries ?? [];
    if (!entries.length) {
      status.textContent = 'No scores yet. Be the first!';
    } else {
      status.textContent = 'Top 50 players';
      for (const entry of entries) {
        const item = document.createElement('li');
        item.textContent = `${entry.display_name} — ${numberFormat.format(entry.best_score)}`;
        if (entry.telegram_user_id && data.me && entry.rank === data.me.rank) item.classList.add('is-me');
        list.append(item);
      }
    }
    me.textContent = data.me
      ? `Your rank: #${data.me.rank}  |  Best: ${numberFormat.format(data.me.best_score)}`
      : 'You have not submitted a score yet.';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Error loading leaderboard';
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
    ['#344b70', '#839bb7', '#d5b98e'], // city
    ['#152b49', '#7199bd', '#e1efff'], // snow
    ['#351b2a', '#a84332', '#f29a50'], // volcano
    ['#171b49', '#654c91', '#e7a8cf'], // meditation
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
  const colors = palettes[index];
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(0.62, colors[1]);
  gradient.addColorStop(1, colors[2]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);

  if (index === 0) {
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
    // Big city: distant skyline, lit windows and a few slow-moving clouds.
    drawClouds(time * 0.45, 'rgba(240,245,255,0.35)');
    for (let i = 0; i < 12; i++) {
      const x = i * 34 - 8;
      const height = 75 + ((i * 47) % 105);
      ctx.fillStyle = i % 2 ? '#53677f' : '#40566f';
      ctx.fillRect(x, 365 - height, 30, height + 55);
      ctx.fillStyle = 'rgba(255,225,150,0.72)';
      for (let wy = 380 - height; wy < 405; wy += 17) {
        for (let wx = x + 7; wx < x + 27; wx += 12) {
          if ((i + wx + wy) % 3 !== 0) ctx.fillRect(wx, wy, 4, 6);
        }
      }
    }
    ctx.fillStyle = '#34485e'; ctx.fillRect(0, 405, W, 15);
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
    // Serene meditation sanctuary with a symbolic seated silhouette and seven chakra lights.
    const halo=ctx.createRadialGradient(180,190,8,180,190,155);halo.addColorStop(0,'rgba(255,220,246,0.48)');halo.addColorStop(1,'rgba(255,220,246,0)');
    ctx.fillStyle=halo;ctx.fillRect(0,20,W,360);ctx.strokeStyle='rgba(246,220,255,0.42)';ctx.lineWidth=2;
    for(let ring=0;ring<4;ring++){ctx.beginPath();ctx.arc(180,190,62+ring*22+Math.sin(time+ring)*2,0,Math.PI*2);ctx.stroke();}
    ctx.fillStyle='#282344';ctx.beginPath();ctx.arc(180,151,18,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.moveTo(165,174);ctx.quadraticCurveTo(145,218,153,255);ctx.quadraticCurveTo(180,274,207,255);ctx.quadraticCurveTo(215,218,195,174);ctx.closePath();ctx.fill();
    ctx.beginPath();ctx.ellipse(180,274,62,17,0,0,Math.PI*2);ctx.fill();
    const chakra=['#ff5268','#ff9a45','#f6d65b','#70d58a','#55d8d8','#659bff','#c18aff'];
    for(let i=0;i<chakra.length;i++){ctx.save();ctx.shadowColor=chakra[i];ctx.shadowBlur=15;ctx.fillStyle=chakra[i];ctx.beginPath();ctx.arc(180,252-i*18,5.5,0,Math.PI*2);ctx.fill();ctx.restore();}
    ctx.fillStyle='rgba(255,226,246,0.8)';for(let i=0;i<24;i++){const x=(i*67+time*(i%2?3:-2)+W*3)%W;const y=65+(i*43)%260;ctx.beginPath();ctx.arc(x,y,1.2+(i%3)*.5,0,Math.PI*2);ctx.fill();}
    ctx.fillStyle='#49385f';ctx.fillRect(0,385,W,35);
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
  ctx.stroke();
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
  ctx.fillStyle = '#05090e';
  ctx.beginPath();
  ctx.rect(-CUBE / 2, -CUBE / 2, CUBE, CUBE);
  ctx.fill();
  ctx.strokeStyle = 'rgba(190, 205, 216, 0.72)';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // White eyes with small dark pupils looking slightly forward.
  ctx.fillStyle = p.paper;
  for (const ex of [CUBE / 2 - 20, CUBE / 2 - 8]) {
    ctx.beginPath();
    ctx.arc(ex, -CUBE / 2 + 12, 5.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#05090e';
  for (const ex of [CUBE / 2 - 18.2, CUBE / 2 - 6.2]) {
    ctx.beginPath();
    ctx.arc(ex, -CUBE / 2 + 12.5, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
