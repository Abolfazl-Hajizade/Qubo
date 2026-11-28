// Qubo audio engine. No generated broadband noise: each environment is a quiet, tonal soundscape.
type Scene = { name: string; root: number; wave: OscillatorType; intervals: number[]; filter: number; movement: number; pulse: number };
const scenes: Scene[] = [
  { name:'Storm', root:55, wave:'triangle', intervals:[1,1.19,1.5], filter:380, movement:2.1, pulse:.12 },
  { name:'Sunny sky', root:392, wave:'sine', intervals:[1,1.25,1.5], filter:2600, movement:1.2, pulse:.035 },
  { name:'Forest', root:196, wave:'sine', intervals:[1,1.5,2], filter:1500, movement:1.8, pulse:.055 },
  { name:'Sea', root:110, wave:'sine', intervals:[1,1.498,2], filter:900, movement:1.1, pulse:.16 },
  { name:'Desert', root:82.4, wave:'triangle', intervals:[1,1.25,1.414], filter:720, movement:1.5, pulse:.025 },
  { name:'Golden sunset', root:220, wave:'sine', intervals:[1,1.25,1.5], filter:1800, movement:1.4, pulse:.04 },
  { name:'Snowy mountains', root:146.8, wave:'sine', intervals:[1,1.334,2], filter:1150, movement:2.5, pulse:.025 },
  { name:'Volcano', root:49, wave:'triangle', intervals:[1,1.189,1.414], filter:340, movement:1.1, pulse:.2 },
  { name:'Meditation', root:174.6, wave:'sine', intervals:[1,1.5,2], filter:1600, movement:1.7, pulse:.025 },
  { name:'Cyberpunk', root:55, wave:'sawtooth', intervals:[1,1.414,1.782], filter:1050, movement:1.2, pulse:.28 },
  { name:'Cosmic', root:65.4, wave:'sine', intervals:[1,1.25,1.875], filter:650, movement:2.8, pulse:.035 },
  { name:'Spirituality', root:261.6, wave:'sine', intervals:[1,1.333,1.5], filter:2800, movement:1.5, pulse:.02 },
  { name:'Metaphysics', root:73.4, wave:'triangle', intervals:[1,1.414,1.682], filter:780, movement:2.2, pulse:.035 },
  { name:'Philosophy', root:146.8, wave:'sine', intervals:[1,1.25,1.5], filter:1050, movement:2, pulse:.025 },
  { name:'Love', root:261.6, wave:'sine', intervals:[1,1.25,1.5], filter:2300, movement:1.1, pulse:.045 },
  { name:'Solitude', root:98, wave:'triangle', intervals:[1,1.333,1.414], filter:620, movement:2.7, pulse:.02 },
  { name:'Quantum', root:330, wave:'sine', intervals:[1,1.414,1.732], filter:2100, movement:1.3, pulse:.2 },
  { name:'Matrix', root:73.4, wave:'square', intervals:[1,1.5,1.875], filter:1300, movement:.9, pulse:.22 },
  { name:'Cosmology', root:55, wave:'sine', intervals:[1,1.25,1.5], filter:600, movement:3.1, pulse:.025 },
  { name:'Dreams', root:293.7, wave:'sine', intervals:[1,1.333,1.5], filter:2600, movement:2.2, pulse:.035 },
  { name:'Time', root:130.8, wave:'triangle', intervals:[1,1.5,2], filter:900, movement:.8, pulse:.42 },
  { name:'Nature', root:220, wave:'sine', intervals:[1,1.333,1.5], filter:1900, movement:1.6, pulse:.055 },
  { name:'Consciousness', root:164.8, wave:'sine', intervals:[1,1.25,1.414], filter:1550, movement:1.4, pulse:.08 },
  { name:'Freedom', root:246.9, wave:'sine', intervals:[1,1.5,2], filter:2400, movement:1.3, pulse:.045 },
  { name:'Balance', root:196, wave:'sine', intervals:[1,1.25,1.5], filter:1700, movement:1.7, pulse:.025 },
  { name:'Inner power', root:65.4, wave:'triangle', intervals:[1,1.5,1.782], filter:720, movement:1, pulse:.3 },
  { name:'Moonlit night', root:155.6, wave:'sine', intervals:[1,1.333,2], filter:1100, movement:2.4, pulse:.025 },
  { name:'Early dawn', root:220, wave:'sine', intervals:[1,1.25,1.5], filter:1950, movement:1.5, pulse:.035 },
  { name:'Enchanted mushroom grove', root:392, wave:'sine', intervals:[1,1.414,1.782], filter:2700, movement:1.8, pulse:.14 },
  { name:'Overcast rain sky · 840+', root:58.3, wave:'triangle', intervals:[1,1.189,1.498], filter:520, movement:2.4, pulse:.11 },
];

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let sceneBus: GainNode | null = null;
let sceneNodes: AudioNode[] = [];
let enabled = false;
let activeScene = -1;

function getContext(): AudioContext {
  if (!ctx) {
    const AudioContextCtor = window.AudioContext;
    ctx = new AudioContextCtor();
    master = ctx.createGain();
    master.gain.value = .42;
    master.connect(ctx.destination);
  }
  return ctx;
}
function resumeContext() {
  const ac = getContext();
  if (ac.state === 'suspended') void ac.resume();
  return ac;
}
function stopScene() {
  if (!ctx || !sceneBus) return;
  const oldBus = sceneBus;
  const oldNodes = sceneNodes;
  const now = ctx.currentTime;
  oldBus.gain.cancelScheduledValues(now);
  oldBus.gain.setTargetAtTime(0, now, .09);
  sceneBus = null;
  sceneNodes = [];
  activeScene = -1;
  window.setTimeout(() => {
    oldNodes.forEach((node) => {
      if (node instanceof OscillatorNode) { try { node.stop(); } catch { /* already stopped */ } }
      try { node.disconnect(); } catch { /* already disconnected */ }
    });
    try { oldBus.disconnect(); } catch { /* already disconnected */ }
  }, 520);
}
function startScene(index: number) {
  if (!enabled) return;
  const ac = resumeContext();
  const safeIndex = Math.max(0, Math.min(scenes.length - 1, Math.floor(index)));
  if (safeIndex === activeScene) return;
  stopScene();
  const scene = scenes[safeIndex];
  activeScene = safeIndex;
  const bus = ac.createGain();
  bus.gain.setValueAtTime(0, ac.currentTime);
  bus.gain.setTargetAtTime(.12, ac.currentTime, .9);
  bus.connect(master!);
  sceneBus = bus;

  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(scene.filter, ac.currentTime);
  filter.Q.value = .45;
  filter.connect(bus);
  sceneNodes.push(filter);

  scene.intervals.forEach((ratio, i) => {
    const osc = ac.createOscillator();
    const voice = ac.createGain();
    osc.type = i === 0 ? scene.wave : 'sine';
    osc.frequency.value = scene.root * ratio;
    osc.detune.value = i === 1 ? -4 : i === 2 ? 3 : 0;
    voice.gain.value = i === 0 ? .19 : i === 1 ? .075 : .045;
    osc.connect(voice);
    voice.connect(filter);
    osc.start();
    sceneNodes.push(osc, voice);
  });

  // Slow filter breathing makes the environments feel alive without adding hiss or static.
  const lfo = ac.createOscillator();
  const lfoDepth = ac.createGain();
  lfo.frequency.value = scene.movement;
  lfoDepth.gain.value = Math.max(25, scene.filter * .12);
  lfo.connect(lfoDepth);
  lfoDepth.connect(filter.frequency);
  lfo.start();
  sceneNodes.push(lfo, lfoDepth);

  if (scene.pulse > .06) {
    const pulse = ac.createOscillator();
    const depth = ac.createGain();
    pulse.frequency.value = scene.pulse;
    depth.gain.value = .018;
    pulse.connect(depth);
    depth.connect(bus.gain);
    pulse.start();
    sceneNodes.push(pulse, depth);
  }
}
function tone(frequency: number, duration: number, waveform: OscillatorType, volume: number, endFrequency: number, attack = .008) {
  if (!enabled) return;
  const ac = resumeContext();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = waveform;
  osc.frequency.setValueAtTime(frequency, ac.currentTime);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), ac.currentTime + duration);
  gain.gain.setValueAtTime(.0001, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(volume, ac.currentTime + attack);
  gain.gain.exponentialRampToValueAtTime(.0001, ac.currentTime + duration);
  osc.connect(gain);
  gain.connect(master!);
  osc.start();
  osc.stop(ac.currentTime + duration + .02);
  osc.onended = () => { osc.disconnect(); gain.disconnect(); };
}
function cubeSpin() {
  if (!enabled) return;
  tone(620, .34, 'sine', .11, 105, .025);
  tone(930, .22, 'triangle', .035, 310, .018);
}
function cubeImpact() {
  if (!enabled) return;
  tone(118, .22, 'sine', .2, 42, .004);
  tone(410, .055, 'triangle', .045, 150, .002);
}

function bindAudioControls() {
  const toggle = document.getElementById('qubo-sound-toggle') as HTMLButtonElement | null;
  const labToggle = document.getElementById('qubo-sound-lab-toggle') as HTMLButtonElement | null;
  const lab = document.getElementById('qubo-sound-lab') as HTMLElement | null;
  const close = document.getElementById('qubo-sound-lab-close');
  const select = document.getElementById('qubo-sound-stage') as HTMLSelectElement | null;
  const preview = document.getElementById('qubo-sound-stage-play');
  const spin = document.getElementById('qubo-sound-spin-test');
  const hit = document.getElementById('qubo-sound-hit-test');
  if (!toggle || !labToggle || !lab || !select || !preview || !spin || !hit) {
    console.error('Qubo audio controls are missing from the page markup.');
    return;
  }
  scenes.forEach((scene, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = index === 29 ? '840+ · ' + scene.name : scene.name;
    select.append(option);
  });
  const syncToggle = () => {
    toggle.textContent = enabled ? '♫ Sound on' : '♫ Sound off';
    toggle.setAttribute('aria-pressed', String(enabled));
  };
  try { enabled = localStorage.getItem('qubo.sound.enabled') === '1'; } catch { enabled = false; }
  syncToggle();
  toggle.addEventListener('click', () => {
    enabled = !enabled;
    try { localStorage.setItem('qubo.sound.enabled', enabled ? '1' : '0'); } catch { /* storage disabled */ }
    syncToggle();
    if (enabled) {
      if (document.getElementById('game')?.hidden === false) startScene(Number(document.body.dataset.quboBackdrop ?? 0));
    } else stopScene();
  });
  const openLab = (open: boolean) => {
    lab.hidden = !open;
    labToggle.setAttribute('aria-expanded', String(open));
  };
  labToggle.addEventListener('click', () => openLab(Boolean(lab.hidden)));
  close?.addEventListener('click', () => openLab(false));
  preview.addEventListener('click', () => {
    enabled = true;
    try { localStorage.setItem('qubo.sound.enabled', '1'); } catch { /* storage disabled */ }
    syncToggle();
    startScene(Number(select.value));
  });
  spin.addEventListener('click', () => {
    if (!enabled) { enabled = true; syncToggle(); }
    cubeSpin();
  });
  hit.addEventListener('click', () => {
    if (!enabled) { enabled = true; syncToggle(); }
    cubeImpact();
  });
}
bindAudioControls();

export function initQuboAudio() {
  return {
    stage: startScene,
    spin: cubeSpin,
    impact: cubeImpact,
    stop: stopScene,
  };
}
