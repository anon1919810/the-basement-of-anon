/**
 * v0.7 程序合成音效（WebAudio 纯合成，零资源文件）：
 *  - click：按钮点击「咔哒」—— 短促滤波噪声爆点（~30ms）
 *  - panel：面板开合「哗啦」—— 轻柔噪声扫掠（~120ms，低频带通）
 *  - slider：滑块调整「轻响」—— 极短方波 tick（~40ms）
 * 音量小（0.05-0.1）；全局开关存 localStorage「kalt-sound」（'0' = 关，默认开）。
 * AudioContext 惰性创建（首次用户手势时），遵循浏览器自动播放策略。
 */
const SOUND_KEY = 'kalt-sound';

/** 音效开关（默认开；localStorage 'kalt-sound' === '0' 时关） */
export function isSoundOn(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(SOUND_KEY) !== '0';
}

export function setSoundOn(on: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(SOUND_KEY, on ? '1' : '0');
}

export function toggleSound(): boolean {
  const next = !isSoundOn();
  setSoundOn(next);
  return next;
}

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!isSoundOn()) return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    masterGain = ctx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** 噪声缓冲（白噪声，懒生成） */
let noiseBuf: AudioBuffer | null = null;
function getNoise(ac: AudioContext): AudioBuffer {
  if (!noiseBuf || noiseBuf.sampleRate !== ac.sampleRate) {
    const len = Math.floor(ac.sampleRate * 0.25);
    noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

/** 包络：从 peak 快速衰减到 0 */
function envelope(ac: AudioContext, node: AudioNode, peak: number, dur: number, delay = 0): void {
  const g = ac.createGain();
  g.gain.setValueAtTime(0, ac.currentTime + delay);
  g.gain.linearRampToValueAtTime(peak, ac.currentTime + delay + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + delay + dur);
  node.connect(g);
  g.connect(masterGain ?? ac.destination);
}

/** 按钮点击「咔哒」：短促噪声爆点（~30ms，高通） */
export function sfxClick(): void {
  const ac = ensureCtx();
  if (!ac) return;
  const src = ac.createBufferSource();
  src.buffer = getNoise(ac);
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 900;
  hp.Q.value = 0.6;
  src.connect(hp);
  envelope(ac, hp, 0.07, 0.03);
  src.start();
  src.stop(ac.currentTime + 0.06);
}

/** 面板开合「哗啦」：轻柔噪声扫掠（~120ms，低频带通 300→900Hz） */
export function sfxPanel(): void {
  const ac = ensureCtx();
  if (!ac) return;
  const src = ac.createBufferSource();
  src.buffer = getNoise(ac);
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(280, ac.currentTime);
  bp.frequency.exponentialRampToValueAtTime(950, ac.currentTime + 0.12);
  src.connect(bp);
  envelope(ac, bp, 0.05, 0.12);
  src.start();
  src.stop(ac.currentTime + 0.18);
}

/** 滑块调整「轻响」：极短方波 tick（~40ms，~1600Hz） */
let sliderLast = 0;
export function sfxSlider(): void {
  const now = Date.now();
  if (now - sliderLast < 55) return; // 拖拽节流
  sliderLast = now;
  const ac = ensureCtx();
  if (!ac) return;
  const osc = ac.createOscillator();
  osc.type = 'square';
  osc.frequency.value = 1500 + Math.random() * 400;
  osc.detune.value = 0;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2200;
  osc.connect(lp);
  envelope(ac, lp, 0.028, 0.04);
  osc.start();
  osc.stop(ac.currentTime + 0.06);
}
