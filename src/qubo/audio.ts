type SoundScene = { name: string; base: number; color: OscillatorType; filter: number; noise: number; pulse?: number };
const scenes: SoundScene[] = [
  { name: 'Storm', base: 48, color: 'sawtooth', filter: 420, noise: .16 },
  { name: 'Sunny sky', base: 392, color: 'sine', filter: 2400, noise: .025 },
  { name: 'Forest', base: 196, color: 'triangle', filter: 1100, noise: .07 },
  { name: 'Sea', base: 110, color: 'sine', filter: 650, noise: .14, pulse: .16 },
  { name: 'Desert', base: 82, color: 'triangle', filter: 520, noise: .12 },
  { name: 'Golden sunset', base: 220, color: 'sine', filter: 1500, noise: .035 },
  { name: 'Snowy mountains', base: 140, color: 'sine', filter: 850, noise: .15 },
  { name: 'Volcano', base: 42, color: 'sawtooth', filter: 180, noise: .2, pulse: .22 },
  { name: 'Meditation', base: 174.6, color: 'sine', filter: 1300, noise: .018 },
  { name: 'Cyberpunk', base: 55, color: 'square', filter: 900, noise: .04, pulse: .3 },
  { name: 'Cosmic', base: 65, color: 'sine', filter: 380, noise: .045 },
  { name: 'Spirituality', base: 261.6, color: 'sine', filter: 3000, noise: .012 },
  { name: 'Metaphysics', base: 73, color: 'triangle', filter: 700, noise: .035 },
  { name: 'Philosophy', base: 146.8, color: 'sine', filter: 950, noise: .012 },
  { name: 'Love', base: 261.6, color: 'sine', filter: 2100, noise: .018 },
  { name: 'Solitude', base: 98, color: 'triangle', filter: 420, noise: .085 },
  { name: 'Quantum', base: 330, color: 'sine', filter: 1800, noise: .025, pulse: .22 },
  { name: 'Matrix', base: 73, color: 'square', filter: 1200, noise: .055, pulse: .18 },
  { name: 'Cosmology', base: 55, color: 'sine', filter: 500, noise: .05 },
  { name: 'Dreams', base: 293.7, color: 'sine', filter: 2400, noise: .025 },
  { name: 'Time', base: 130.8, color: 'triangle', filter: 800, noise: .02, pulse: .5 },
  { name: 'Nature', base: 220, color: 'sine', filter: 1800, noise: .045 },
  { name: 'Consciousness', base: 164.8, color: 'sine', filter: 1400, noise: .025, pulse: .12 },
  { name: 'Freedom', base: 246.9, color: 'sine', filter: 2200, noise: .07 },
  { name: 'Balance', base: 196, color: 'sine', filter: 1600, noise: .025 },
  { name: 'Inner power', base: 65.4, color: 'triangle', filter: 600, noise: .045, pulse: .35 },
  { name: 'Moonlit night', base: 155.6, color: 'sine', filter: 950, noise: .04 },
  { name: 'Early dawn', base: 220, color: 'sine', filter: 1800, noise: .03 },
  { name: 'Enchanted mushroom grove', base: 392, color: 'sine', filter: 2600, noise: .035, pulse: .16 },
  { name: 'Overcast rain sky · 840+', base: 58.3, color: 'triangle', filter: 560, noise: .19 },
];

let context: AudioContext | null = null;
let master: GainNode | null = null;
let ambience: GainNode | null = null;
let noiseSource: AudioBufferSourceNode | null = null;
let sceneNodes: AudioNode[] = [];
let enabled = true;
let currentScene = -1;

function audioContext(): AudioContext {
  if (!context) {
    context = new AudioContext();
    master = context.createGain();
    master.gain.value = .62;
    master.connect(context.destination);
  }
  return context;
}

function stopScene() {
  if (!context || !ambience) return;
  const now = context.currentTime;
  ambience.gain.cancelScheduledValues(now);
  ambience.gain.setTargetAtTime(0, now, .12);
  const oldNodes = [...sceneNodes];
  const oldNoise = noiseSource;
  const oldBus = ambience;
  sceneNodes = [];
  noiseSource = null;
  currentScene = -1;
  window.setTimeout(() => {
    oldNodes.forEach((node) => { try { if (node instanceof OscillatorNode) node.stop(); } catch { /* already stopped */ } });
    try { oldNoise?.stop(); } catch { /* already stopped */ }
    oldBus?.disconnect();
  }, 650);
  ambience = null;
}

function startAmbience(index: number) {
  if (!enabled || index === currentScene) return;
  const ac = audioContext();
  if (ac.state === 'suspended') void ac.resume();
  stopScene();
  const scene = scenes[Math.max(0, Math.min(scenes.length - 1, index))];
  currentScene = index;
  const bus = ac.createGain();
  bus.gain.value = 0;
  bus.connect(master!);
  bus.gain.setTargetAtTime(.22, ac.currentTime, .8);
  ambience = bus;
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = scene.filter;
  filter.Q.value = .65;
  filter.connect(bus);
  const tones = [scene.base, scene.base * 1.498, scene.base * 2.003];
  tones.forEach((frequency, i) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = i === 0 ? scene.color : 'sine';
    osc.frequency.value = frequency;
    osc.detune.value = i === 1 ? -7 : i === 2 ? 5 : 0;
    gain.gain.value = i === 0 ? .12 : .035 / i;
    osc.connect(gain); gain.connect(filter); osc.start();
    sceneNodes.push(osc, gain);
  });
  const length = ac.sampleRate * 3;
  const buffer = ac.createBuffer(1, length, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (index === 0 || index === 29 ? .75 : .45);
  const noise = ac.createBufferSource();
  const noiseFilter = ac.createBiquadFilter();
  const noiseGain = ac.createGain();
  noise.buffer = buffer; noise.loop = true;
  noiseFilter.type = 'lowpass'; noiseFilter.frequency.value = scene.filter;
  noiseGain.gain.value = scene.noise;
  noise.connect(noiseFilter); noiseFilter.connect(noiseGain); noiseGain.connect(bus); noise.start();
  noiseSource = noise;
  sceneNodes.push(noiseFilter, noiseGain);
  if (scene.pulse) {
    const lfo = ac.createOscillator();
    const depth = ac.createGain();
    lfo.frequency.value = scene.pulse;
    depth.gain.value = .035;
    lfo.connect(depth); depth.connect(bus.gain); lfo.start();
    sceneNodes.push(lfo, depth);
  }
}

function playTone(frequency: number, duration: number, type: OscillatorType, volume: number, endFrequency?: number) {
  if (!enabled) return;
  const ac = audioContext();
  if (ac.state === 'suspended') void ac.resume();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type; osc.frequency.setValueAtTime(frequency, ac.currentTime);
  if (endFrequency) osc.frequency.exponentialRampToValueAtTime(endFrequency, ac.currentTime + duration);
  gain.gain.setValueAtTime(volume, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(.0001, ac.currentTime + duration);
  osc.connect(gain); gain.connect(master!); osc.start(); osc.stop(ac.currentTime + duration);
}

function cubeSpin() {
  if (!enabled) return;
  playTone(680, .16, 'sine', .09, 190);
  playTone(1100, .1, 'triangle', .025, 420);
}

function cubeImpact() {
  if (!enabled) return;
  playTone(145, .13, 'triangle', .16, 58);
  playTone(520, .045, 'sine', .045, 180);
}

export function initQuboAudio() {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '♫ Sound on';
  button.setAttribute('aria-label', 'Toggle game sounds');
  button.style.cssText = 'position:fixed;z-index:30;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));border:1px solid #ffffff35;border-radius:999px;padding:9px 13px;background:#101923dd;color:#f4f7fb;font:600 12px system-ui;backdrop-filter:blur(8px);cursor:pointer';
  button.addEventListener('click', () => {
    enabled = !enabled;
    button.textContent = enabled ? '♫ Sound on' : '♫ Sound off';
    if (!enabled) stopScene();
    else if (currentScene < 0) startAmbience(Number(document.body.dataset.quboBackdrop ?? 0));
  });
  document.body.append(button);
  return {
    stage: startAmbience,
    spin: cubeSpin,
    impact: cubeImpact,
    stop: stopScene,
  };
}
