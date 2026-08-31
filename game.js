'use strict';

/* ================================================================
   音乐跳动 · 游戏主逻辑（纯 JavaScript，无第三方库）
   需求依据：CLAUDE.md 产品设计文档

   时间同步说明（音游的灵魂）：
     整个游戏只有「一个时钟」——AudioContext.currentTime。
     歌内时间 songTime = currentTime - songStart，节拍点、障碍、
     音乐全部按预计算的节拍时间表工作，保证音画严格同步。

   结构：
     1. 配置常量（所有可调数值集中在这里）
     2. 节拍时间表（三阶段 BPM 120/128/136）
     3. 关卡生成（每一拍安排什么：节拍点 / 障碍）
     4. 音乐引擎（Web Audio 程序合成 + 预计算事件表）
     5. 游戏状态与实体
     6. 更新逻辑（物理 / 判定 / 计分 / 死亡）
     7. 渲染（霓虹暗黑画面 + 粒子特效）
     8. 输入与界面流程
   ================================================================ */

/* ---------- 1. 配置常量 ---------- */
const CONFIG = {
  // —— 视觉（CLAUDE.md 第七章：霓虹暗黑风）——
  bgTop: '#07070f', bgBottom: '#0d0d1a', groundColor: '#0c0c18',
  playerColor: '#00e5ff',   // 方块：发光青色
  noteColor: '#ff2fd6',     // 节拍点：洋红
  obstacleColor: '#ff3355', // 障碍：红色警示

  // —— 跳跃物理（CLAUDE.md 第三章：高度 3 倍方块、时长 0.5 秒）——
  jumpDuration: 0.5,
  jumpBuffer: 0.1,          // 落地前 0.1 秒内的按键会被记住，落地瞬间起跳

  // —— 节拍点几何 ——
  noteHeightFactor: 2,      // 节拍点中心高度 = 方块尺寸 × 2（地面以上）
  noteRadiusFactor: 0.62,   // 节拍点半径 = 方块尺寸 × 0.62

  // —— 判定（CLAUDE.md 第二章：Perfect ±50ms / Good ±100ms）——
  perfectWindow: 0.05,      // 起跳时刻与鼓点相差 50 毫秒内 → Perfect
  goodWindow: 0.1,          // 100 毫秒内 → Good
  // 超出时间窗但方块与节拍点几何接触 → 兜底 Good（画面碰到就不算 Miss）

  // —— 计分（CLAUDE.md 第五章）——
  scorePerfect: 200,
  scoreGood: 100,
  comboStep: 10,            // 连击每 +10，倍率 +1
  maxComboMult: 5,          // 倍率上限 ×5

  // —— 音乐（CLAUDE.md 第四章）——
  bpmStage1: 120, bpmStage2: 128, bpmStage3: 136,
  stage1Beats: 64,          // 简单：0-63 拍
  stage2Beats: 64,          // 中等：64-127 拍
  stage3Beats: 128,         // 困难：128-255 拍（之后循环困难段）
  eventBeats: 320,          // 预计算的音乐事件总拍数（约 2 分半）

  // —— 实体飞行 ——
  travelBeats: 2,           // 元素从屏幕右缘飞到方块处需要 2 拍
  speedRamp: 1.2,           // 全程速度倍率 1.0 → 1.2 线性提升
  noteOffset: 0.1,          // 元素到达方块的时间比鼓点晚 0.1 秒
                            // （这样「在鼓点上按键」时画面正好接触）

  // —— 障碍几何与死亡（CLAUDE.md 第二章）——
  obstacleHeightFactor: 1.2, // 障碍高度 = 方块尺寸 × 1.2
  obstacleWidthFactor: 0.8,  // 障碍宽度 = 方块尺寸 × 0.8

  // —— 流程 ——
  leadIn: 1.0,               // 开局 1 秒准备时间（先见元素、再响音乐）
  deathPause: 0.9,           // 死亡后停顿 0.9 秒再弹出结算界面

  bestKey: 'musicJumpBestScore',
};

/* ---------- 2. 节拍时间表 ---------- */

const TOTAL_BEATS = CONFIG.stage1Beats + CONFIG.stage2Beats + CONFIG.stage3Beats; // 256

// 每拍一个时间点（秒）。三阶段 BPM：120 → 128 → 136
const beatTimes = [0];
for (let i = 1; i < TOTAL_BEATS; i++) {
  beatTimes.push(beatTimes[i - 1] + 60 / bpmForBeat(i));
}
const SONG_LENGTH = beatTimes[TOTAL_BEATS - 1]; // ≈ 118 秒（约 2 分钟一轮）

function bpmForBeat(i) {
  if (i < CONFIG.stage1Beats) return CONFIG.bpmStage1;
  if (i < CONFIG.stage1Beats + CONFIG.stage2Beats) return CONFIG.bpmStage2;
  return CONFIG.bpmStage3;
}

// 256 拍之后：按 136 BPM 无限延伸（游戏能玩多久，音乐就响多久）
function beatTime(i) {
  if (i < TOTAL_BEATS) return beatTimes[i];
  return beatTimes[TOTAL_BEATS - 1] + (i - (TOTAL_BEATS - 1)) * (60 / CONFIG.bpmStage3);
}

/* ---------- 3. 关卡生成（每一拍的安排，纯函数） ----------
   密度递进（CLAUDE.md 第五章难度曲线）：
     简单（0-63 拍, 120BPM）：偶数拍一个节拍点；每 12 拍一个障碍（与节拍点同拍）
     中等（64-127 拍, 128BPM）：偶数拍一个节拍点；每 8 拍两个障碍
                             （k=3 独立障碍 + k=6 与节拍点同拍）
     困难（128+ 拍, 136BPM）：偶数拍一个节拍点；每 8 拍三个障碍
                             （k=5 → k=6 连拍障碍，最高难度的节奏考验）
   节拍点间隔 2 拍 ≥ 0.88 秒，跳跃时长 0.5 秒，密度已验证物理可行。 */
function patternForBeat(i) {
  if (i < 4) return { note: false, obstacle: false }; // 开局 4 拍留白热身
  let b = i;
  if (b >= TOTAL_BEATS) {
    b = CONFIG.stage1Beats + CONFIG.stage2Beats + ((b - TOTAL_BEATS) % CONFIG.stage3Beats);
  }
  const k = b % 8;
  const note = (k % 2 === 0); // 节拍点永远在偶数拍
  let obstacle = false;
  if (b < CONFIG.stage1Beats) {
    if (b % 12 === 6) obstacle = true;
  } else if (b < CONFIG.stage1Beats + CONFIG.stage2Beats) {
    if (k === 3 || k === 6) obstacle = true;
  } else {
    if (k === 3 || k === 5 || k === 6) obstacle = true;
  }
  return { note, obstacle };
}

/* ---------- 4. 音乐引擎（程序合成，见 CLAUDE.md 第四章） ---------- */

const AudioEngine = {
  ctx: null, master: null, session: null, noise: null,
  schedulerId: null, running: false,
  songStart: 0, eventIndex: 0, events: [],

  // 惰性创建：必须在用户点击「开始游戏」后调用（浏览器自动播放策略）
  ensure() {
    if (this.ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      const comp = this.ctx.createDynamicsCompressor(); // 防止多声部叠加破音
      this.master.connect(comp).connect(this.ctx.destination);
      // 预生成 1 秒白噪声（踩镲 / 军鼓共用）
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return true;
    } catch (e) { return false; }
  },
};

// —— 和弦进行：Am → F → C → G，每小节（4 拍）换一个，循环 ——
const CHORDS = [
  { bass: 110.00, tones: [220.00, 261.63, 329.63, 440.00] },   // Am
  { bass: 87.31,  tones: [174.61, 220.00, 261.63, 349.23] },   // F
  { bass: 130.81, tones: [261.63, 329.63, 392.00, 523.25] },   // C
  { bass: 98.00,  tones: [196.00, 246.94, 293.66, 392.00] },   // G
];
function chordForBeat(i) { return CHORDS[Math.floor(i / 4) % 4]; }

// —— 旋律密度按阶段递增（小节内的位置，单位：拍）——
const LEAD_PATTERNS = {
  1: [0.5, 2.5],
  2: [0.5, 1.5, 2.5, 3.5],
  3: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
};
function stageForBeat(i) {
  return i < CONFIG.stage1Beats ? 1 : i < CONFIG.stage1Beats + CONFIG.stage2Beats ? 2 : 3;
}

// —— 预计算整首歌的音乐事件表（排序后由调度器按时间消费）——
function buildEvents() {
  const evs = [];
  for (let b = 0; b < CONFIG.eventBeats; b++) {
    const t = beatTime(b);
    const beatDur = beatTime(b + 1) - t; // 当前拍的实际时长
    const half = beatDur / 2;            // 半拍
    const stage = stageForBeat(b);
    const chord = chordForBeat(b);

    evs.push({ t, type: 'kick' });                    // 底鼓：每拍
    evs.push({ t: t + half, type: 'hat' });           // 踩镲：每半拍
    if (b % 4 === 1 || b % 4 === 3) evs.push({ t, type: 'snare' }); // 军鼓：第 2/4 拍
    evs.push({ t, type: 'bass', f: chord.bass });            // 贝斯：根音 8 分音符
    evs.push({ t: t + half, type: 'bass', f: chord.bass * 2 }); // 贝斯：高八度
    LEAD_PATTERNS[stage].forEach((off, idx) => {       // 旋律：按阶段加密
      evs.push({ t: t + off * beatDur, type: 'lead', f: chord.tones[idx % chord.tones.length] });
    });
  }
  evs.sort((a, b) => a.t - b.t);
  return evs;
}

// —— 乐器合成函数（t = AudioContext 绝对时间）——
function playKick(t) {
  const c = AudioEngine.ctx, o = c.createOscillator(), g = c.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.12); // 扫频：咚咚的感觉
  g.gain.setValueAtTime(1.0, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  o.connect(g).connect(AudioEngine.session);
  o.start(t); o.stop(t + 0.32);
}
function playHat(t) {
  const c = AudioEngine.ctx, s = c.createBufferSource(), g = c.createGain(), f = c.createBiquadFilter();
  s.buffer = AudioEngine.noise;
  f.type = 'highpass'; f.frequency.value = 8000;
  g.gain.setValueAtTime(0.16, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  s.connect(f).connect(g).connect(AudioEngine.session);
  s.start(t); s.stop(t + 0.06);
}
function playSnare(t) {
  const c = AudioEngine.ctx, s = c.createBufferSource(), g = c.createGain(), f = c.createBiquadFilter();
  s.buffer = AudioEngine.noise;
  f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.8;
  g.gain.setValueAtTime(0.5, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  s.connect(f).connect(g).connect(AudioEngine.session);
  s.start(t); s.stop(t + 0.18);
}
function playBass(t, freq) {
  const c = AudioEngine.ctx, o = c.createOscillator(), g = c.createGain(), f = c.createBiquadFilter();
  o.type = 'sawtooth'; o.frequency.value = freq;
  f.type = 'lowpass'; f.frequency.value = 550;
  g.gain.setValueAtTime(0.22, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  o.connect(f).connect(g).connect(AudioEngine.session);
  o.start(t); o.stop(t + 0.25);
}
function playLead(t, freq) {
  const c = AudioEngine.ctx, g = c.createGain(), f = c.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 2600;
  const o1 = c.createOscillator(), o2 = c.createOscillator();
  o1.type = 'square'; o1.frequency.value = freq;
  o2.type = 'square'; o2.frequency.value = freq * 1.005; // 轻微失谐，音色更丰满
  g.gain.setValueAtTime(0.16, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  o1.connect(f); o2.connect(f); f.connect(g).connect(AudioEngine.session);
  o1.start(t); o1.stop(t + 0.32);
  o2.start(t); o2.stop(t + 0.32);
}
function playBoom() { // 死亡爆音
  const c = AudioEngine.ctx;
  if (!c || !c.session) return;
  const t = c.currentTime;
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(120, t);
  o.frequency.exponentialRampToValueAtTime(30, t + 0.4);
  g.gain.setValueAtTime(0.8, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  o.connect(g).connect(c.session);
  o.start(t); o.stop(t + 0.55);
  const s = c.createBufferSource(), g2 = c.createGain(), f = c.createBiquadFilter();
  s.buffer = c.noise; f.type = 'lowpass'; f.frequency.value = 900;
  g2.gain.setValueAtTime(0.5, t);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  s.connect(f).connect(g2).connect(c.session);
  s.start(t); s.stop(t + 0.35);
}
function playMiss() { // 漏拍提示音（小声）
  const c = AudioEngine.ctx;
  if (!c) return;
  const t = c.currentTime;
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'sine'; o.frequency.value = 110;
  g.gain.setValueAtTime(0.12, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  o.connect(g).connect(c.session || c.master);
  o.start(t); o.stop(t + 0.15);
}

// —— 调度器：每 25ms 把未来 0.15s 内的音乐事件安排给音频硬件 ——
function schedulerTick() {
  const c = AudioEngine;
  const ahead = c.ctx.currentTime + 0.15;
  while (c.eventIndex < c.events.length && c.songStart + c.events[c.eventIndex].t < ahead) {
    const e = c.events[c.eventIndex++];
    const t = c.songStart + e.t;
    switch (e.type) {
      case 'kick': playKick(t); break;
      case 'hat': playHat(t); break;
      case 'snare': playSnare(t); break;
      case 'bass': playBass(t, e.f); break;
      case 'lead': playLead(t, e.f); break;
    }
  }
}

function startMusic() {
  const c = AudioEngine;
  if (c.schedulerId) clearInterval(c.schedulerId);
  // 若上一局音乐还连着（连点两次开始），先淡出旧通道，避免两路声音叠响
  if (c.session) {
    const old = c.session;
    old.gain.setTargetAtTime(0, c.ctx.currentTime, 0.03);
    setTimeout(() => { try { old.disconnect(); } catch (e) {} }, 200);
    c.session = null;
  }
  c.eventIndex = 0;
  c.songStart = c.ctx.currentTime + CONFIG.leadIn;
  c.session = c.ctx.createGain(); // 每局一个独立音量通道
  c.session.gain.value = 1;
  c.session.connect(c.master);
  c.running = true;
  c.schedulerId = setInterval(schedulerTick, 25);
}

function fadeOutMusic() { // 死亡 / 返回首页时淡出本局音乐
  const c = AudioEngine;
  if (c.session) {
    const s = c.session;
    s.gain.setTargetAtTime(0, c.ctx.currentTime, 0.06);
    setTimeout(() => { try { s.disconnect(); } catch (e) {} }, 500);
    c.session = null;
  }
  if (c.schedulerId) { clearInterval(c.schedulerId); c.schedulerId = null; }
  c.running = false;
}

function songTime() {
  return AudioEngine.ctx ? AudioEngine.ctx.currentTime - AudioEngine.songStart : 0;
}

/* ---------- 5. 游戏状态与实体 ---------- */

const S = {
  phase: 'menu',            // menu | playing | dying | over
  score: 0, combo: 0, best: 0,
  jumpStart: -10,           // 上一次起跳时刻（歌内时间）
  jumpBufferUntil: -1,      // 空中按键的缓冲截止时刻
  entities: [],             // { type, start, dur, judged, beatT }
  particles: [], texts: [], trail: [],
  spawnIndex: 0,            // 下一个要生成的拍号
  beatCursor: 0,            // 当前已响起的拍号（用于画面脉动）
  worldOffset: 0,           // 网格滚动偏移
  flash: 0, shake: 0, deathAt: 0,
};

/* ---------- DOM 与画布 ---------- */

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);
const hudEl = $('hud'), menuEl = $('menu'), gameoverEl = $('gameover');
const scoreEl = $('score'), comboEl = $('combo'), progressFill = $('progress-fill');
const bestValue = $('best-value'), finalScore = $('final-score');
const finalBestValue = $('final-best-value'), newRecord = $('new-record');

let W = 0, H = 0, squareSize = 40, playerX = 0, groundY = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  squareSize = Math.max(20, Math.min(44, Math.round(H * 0.05)));
  playerX = W * 0.25;
  groundY = H * 0.8;
}
window.addEventListener('resize', resize);

/* ---------- 6. 更新逻辑 ---------- */

// 跳跃高度（解析式，不逐帧积分 → 无误差、标签页暂停也不漂移）
// h(e) = 24s·e − 48s·e²，e = 起跳后经过的秒数，最高点 = 3 倍方块
function playerHeight() {
  const e = Math.min(Math.max(songTime() - S.jumpStart, 0), CONFIG.jumpDuration);
  return squareSize * (24 * e - 48 * e * e);
}
function isGrounded() {
  return songTime() - S.jumpStart >= CONFIG.jumpDuration;
}
function pressJump() {
  if (S.phase !== 'playing') return;
  if (isGrounded()) { S.jumpStart = songTime(); S.jumpBufferUntil = -1; }
  else S.jumpBufferUntil = songTime() + CONFIG.jumpBuffer; // 空中按键 → 落地即跳
}

// 当前世界速度（元素飞行速度随 BPM 与进度提升）
function speedNow() {
  const mult = 1 + (CONFIG.speedRamp - 1) * Math.min(1, Math.max(0, songTime()) / SONG_LENGTH);
  return (W - playerX) / (CONFIG.travelBeats * (60 / bpmForBeat(S.spawnIndex)) / mult);
}

// 按到达时间反推出生时间，到点就把该拍的元素放进屏幕
function spawnUpcoming() {
  const t = songTime();
  while (true) {
    const b = S.spawnIndex;
    const arrival = beatTime(b) + CONFIG.noteOffset;
    const travelT = (W - playerX) / speedNow();
    const spawnT = arrival - travelT;
    if (t < spawnT) break;
    const p = patternForBeat(b);
    if (p.note) S.entities.push({ type: 'note', start: spawnT, dur: travelT, judged: false, beatT: beatTime(b) });
    if (p.obstacle) S.entities.push({ type: 'obstacle', start: spawnT, dur: travelT });
    S.spawnIndex++;
    if (S.spawnIndex > 100000) break; // 保险丝
  }
}

function comboMult() {
  return Math.min(1 + Math.floor(S.combo / CONFIG.comboStep), CONFIG.maxComboMult);
}

// 节拍判定：按时间（|起跳 − 鼓点|），超窗但画面接触 → 兜底 Good
function judgeNote(e, playerH) {
  e.judged = true;
  const dt = S.jumpStart - e.beatT;
  if (Math.abs(dt) <= CONFIG.perfectWindow) return 'perfect';
  if (Math.abs(dt) <= CONFIG.goodWindow) return 'good';
  const dy = Math.abs(playerH + squareSize / 2 - CONFIG.noteHeightFactor * squareSize);
  if (dy <= (CONFIG.noteRadiusFactor + 0.5) * squareSize) return 'good';
  return 'miss';
}

function applyHit(kind) {
  S.combo++;
  S.score += (kind === 'perfect' ? CONFIG.scorePerfect : CONFIG.scoreGood) * comboMult();
  const ny = groundY - CONFIG.noteHeightFactor * squareSize;
  addText(kind === 'perfect' ? 'Perfect!' : 'Good', playerX, ny - 34,
    kind === 'perfect' ? CONFIG.playerColor : '#e8e8f0');
  burst(playerX, ny, CONFIG.noteColor, kind === 'perfect' ? 16 : 9);
}
function applyMiss() {
  S.combo = 0;
  addText('Miss', playerX, groundY - CONFIG.noteHeightFactor * squareSize - 34, '#666680');
  playMiss();
}

function die() {
  if (S.phase !== 'playing') return;
  S.phase = 'dying';
  S.deathAt = songTime();
  S.flash = 1; S.shake = 1;
  burst(playerX, groundY - squareSize, CONFIG.obstacleColor, 30);
  burst(playerX, groundY - squareSize, CONFIG.playerColor, 20);
  playBoom();
  fadeOutMusic();
}

function update(dt) {
  const t = songTime();

  // 当前鼓点推进（画面脉动用）
  while (beatTime(S.beatCursor + 1) <= t) S.beatCursor++;

  // 落地缓冲跳
  if (S.phase === 'playing' && S.jumpBufferUntil > t && isGrounded()) {
    S.jumpStart = t; S.jumpBufferUntil = -1;
  }
  // 生成新元素
  if (S.phase === 'playing') spawnUpcoming();

  const playerH = playerHeight();

  // 跳跃拖尾
  if (S.phase === 'playing' && !isGrounded()) {
    S.trail.push({ y: groundY - playerH - squareSize / 2, t: 0 });
  }

  // 实体推进 + 判定
  for (let i = S.entities.length - 1; i >= 0; i--) {
    const e = S.entities[i];
    const p = (t - e.start) / e.dur;
    const x = W - p * (W - playerX); // 进度 → 屏幕坐标（窗口缩放也安全）

    if (e.type === 'note') {
      if (S.phase === 'playing' && !e.judged && x <= playerX) {
        const kind = judgeNote(e, playerH);
        if (kind === 'miss') applyMiss();
        else { applyHit(kind); S.entities.splice(i, 1); continue; }
      }
    } else if (S.phase === 'playing') {
      // 障碍碰撞：方块下沿低于障碍顶部且横向重叠 → 游戏结束
      const halfW = (CONFIG.obstacleWidthFactor * squareSize + squareSize) / 2;
      if (Math.abs(x - playerX) < halfW && playerH < CONFIG.obstacleHeightFactor * squareSize) {
        die();
        break;
      }
    }
    if (p > 1.6) S.entities.splice(i, 1); // 飞出屏幕后移除
  }

  // 粒子 / 飘字
  for (const pt of S.particles) { pt.t += dt; pt.vy += 700 * dt; pt.x += pt.vx * dt; pt.y += pt.vy * dt; }
  S.particles = S.particles.filter((pt) => pt.t < pt.life);
  for (const tx of S.texts) { tx.t += dt; tx.y -= 46 * dt; }
  S.texts = S.texts.filter((tx) => tx.t < tx.life);
  for (const tr of S.trail) tr.t += dt;
  S.trail = S.trail.filter((tr) => tr.t < 0.25);

  // 特效衰减
  S.flash = Math.max(0, S.flash - dt * 2.8);
  S.shake = Math.max(0, S.shake - dt * 1.8);

  // 背景滚动（死亡瞬间画面定格，更有冲击感）
  if (S.phase === 'playing') S.worldOffset += speedNow() * dt;
  else if (S.phase === 'menu') S.worldOffset += 80 * dt;

  // 死亡 → 结算
  if (S.phase === 'dying' && t - S.deathAt > CONFIG.deathPause) showGameOver();

  updateHud();
}

function burst(x, y, color, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 120 + Math.random() * 320;
    S.particles.push({
      x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80,
      t: 0, life: 0.4 + Math.random() * 0.4, color,
    });
  }
}
function addText(text, x, y, color) {
  S.texts.push({ text, x, y, t: 0, life: 0.7, color });
}

/* ---------- 7. 渲染 ---------- */

function rr(x, y, w, h, r) { // 圆角矩形路径
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function render() {
  const t = songTime();

  ctx.save();
  if (S.shake > 0) { // 死亡震屏
    ctx.translate((Math.random() - 0.5) * 14 * S.shake, (Math.random() - 0.5) * 10 * S.shake);
  }

  // 背景：天空渐变 + 地面
  const sky = ctx.createLinearGradient(0, 0, 0, groundY);
  sky.addColorStop(0, CONFIG.bgTop);
  sky.addColorStop(1, CONFIG.bgBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(-20, -20, W + 40, groundY + 20);
  ctx.fillStyle = CONFIG.groundColor;
  ctx.fillRect(-20, groundY, W + 40, H - groundY + 20);

  // 滚动网格（天空淡、地面稍亮）
  const spacing = 90;
  const off = S.worldOffset % spacing;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,229,255,0.045)';
  for (let x = -off; x < W; x += spacing) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, groundY); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0,229,255,0.09)';
  for (let x = -off; x < W; x += spacing) {
    ctx.beginPath(); ctx.moveTo(x, groundY); ctx.lineTo(x, H); ctx.stroke();
  }

  // 地平线：随鼓点脉动
  const dtb = Math.max(0, t - beatTime(S.beatCursor));
  const pulse = Math.max(0, 1 - dtb / 0.25);
  ctx.strokeStyle = 'rgba(0,229,255,' + (0.3 + 0.45 * pulse).toFixed(3) + ')';
  ctx.shadowColor = CONFIG.playerColor;
  ctx.shadowBlur = 10 + 16 * pulse;
  ctx.beginPath(); ctx.moveTo(-20, groundY); ctx.lineTo(W + 20, groundY); ctx.stroke();
  ctx.shadowBlur = 0;

  // 实体
  for (const e of S.entities) {
    const p = Math.min(1.6, Math.max(0, (t - e.start) / e.dur));
    const x = W - p * (W - playerX);
    if (e.type === 'note') {
      // 未踩中的节拍点越过玩家后淡出
      let alpha = 1;
      if (e.judged) alpha = Math.max(0, 1 - (p - 1) * 2.5);
      const ny = groundY - CONFIG.noteHeightFactor * squareSize;
      const r = CONFIG.noteRadiusFactor * squareSize * (1 + 0.08 * Math.sin(t * 8));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = CONFIG.noteColor;
      ctx.globalAlpha = alpha * 0.28;
      ctx.beginPath(); ctx.arc(x, ny, r * 1.9, 0, Math.PI * 2); ctx.fill(); // 外圈光晕
      ctx.globalAlpha = alpha;
      ctx.shadowColor = CONFIG.noteColor; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(x, ny, r, 0, Math.PI * 2); ctx.fill();      // 核心
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    } else {
      const ow = CONFIG.obstacleWidthFactor * squareSize;
      const oh = CONFIG.obstacleHeightFactor * squareSize;
      const ox = x - ow / 2, oy = groundY - oh;
      ctx.fillStyle = CONFIG.obstacleColor;
      ctx.shadowColor = CONFIG.obstacleColor; ctx.shadowBlur = 14;
      rr(ox, oy, ow, oh, 3); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(10,10,20,0.55)'; // 内芯警示条纹
      ctx.fillRect(x - ow * 0.12, oy + oh * 0.16, ow * 0.24, oh * 0.68);
    }
  }

  // 跳跃拖尾（幽灵残影）
  for (const tr of S.trail) {
    const a = (1 - tr.t / 0.25) * 0.32;
    ctx.globalAlpha = a;
    ctx.fillStyle = CONFIG.playerColor;
    rr(playerX - squareSize / 2, tr.y, squareSize, squareSize, squareSize * 0.18);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 玩家方块（发光青色）
  const playerH = playerHeight();
  const py = groundY - playerH - squareSize / 2;
  ctx.fillStyle = CONFIG.playerColor;
  ctx.shadowColor = CONFIG.playerColor;
  ctx.shadowBlur = 14 + 10 * pulse;
  rr(playerX - squareSize / 2, py, squareSize, squareSize, squareSize * 0.18);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(10,10,20,0.65)'; // 内芯：霓虹灯框质感
  const inset = squareSize * 0.16;
  rr(playerX - squareSize / 2 + inset, py + inset, squareSize - inset * 2, squareSize - inset * 2, squareSize * 0.1);
  ctx.fill();

  // 粒子（叠加混合，更亮）
  ctx.globalCompositeOperation = 'lighter';
  for (const pt of S.particles) {
    ctx.globalAlpha = Math.max(0, 1 - pt.t / pt.life);
    ctx.fillStyle = pt.color;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 2.6 * (1 - pt.t / pt.life) + 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  // 飘字（Perfect! / Good / Miss）
  ctx.textAlign = 'center';
  ctx.font = 'bold 16px "Segoe UI", "Microsoft YaHei", sans-serif';
  for (const tx of S.texts) {
    ctx.globalAlpha = Math.max(0, 1 - tx.t / tx.life);
    ctx.fillStyle = tx.color;
    ctx.shadowColor = tx.color; ctx.shadowBlur = 8;
    ctx.fillText(tx.text, tx.x, tx.y);
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;

  ctx.restore();

  // 死亡白闪（不随震屏晃动）
  if (S.flash > 0) {
    ctx.fillStyle = 'rgba(255,255,255,' + (S.flash * 0.45).toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);
  }
}

/* ---------- 8. 输入与界面流程 ---------- */

function loadBest() {
  try { return Number(localStorage.getItem(CONFIG.bestKey)) || 0; } catch (e) { return 0; }
}
function saveBest(v) {
  try { localStorage.setItem(CONFIG.bestKey, String(v)); } catch (e) {}
}

function updateHud() {
  const s = String(S.score);
  if (scoreEl.textContent !== s) scoreEl.textContent = s;
  if (S.combo >= 2) {
    comboEl.textContent = S.combo + ' 连击 ×' + comboMult();
    comboEl.classList.remove('hidden');
  } else {
    comboEl.classList.add('hidden');
  }
  const pct = Math.max(0, Math.min(1, songTime() / SONG_LENGTH));
  progressFill.style.width = (pct * 100).toFixed(1) + '%';
}

function startGame() {
  S.phase = 'playing';
  S.score = 0; S.combo = 0;
  S.entities = []; S.particles = []; S.texts = []; S.trail = [];
  S.spawnIndex = 0; S.beatCursor = 0; S.worldOffset = 0;
  S.jumpStart = -10; S.jumpBufferUntil = -1;
  S.flash = 0; S.shake = 0;
  menuEl.classList.add('hidden');
  gameoverEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  startMusic();
}

function showGameOver() {
  S.phase = 'over';
  S.entities = []; // 清掉画面上遗留的元素，结算界面保持干净
  const isNew = S.score > S.best;
  if (isNew) { S.best = S.score; saveBest(S.best); }
  finalScore.textContent = S.score + ' 分';
  finalBestValue.textContent = S.best;
  newRecord.classList.toggle('hidden', !isNew);
  hudEl.classList.add('hidden');
  gameoverEl.classList.remove('hidden');
}

function toMenu() {
  fadeOutMusic();
  S.phase = 'menu';
  gameoverEl.classList.add('hidden');
  menuEl.classList.remove('hidden');
  hudEl.classList.add('hidden');
  bestValue.textContent = S.best;
}

function startFromButton() {
  if (!AudioEngine.ensure()) { alert('你的浏览器不支持音频播放，无法运行游戏'); return; }
  AudioEngine.ctx.resume().catch(() => {});
  startGame();
}
function restartGame() {
  if (!AudioEngine.ctx) { startFromButton(); return; }
  AudioEngine.ctx.resume().catch(() => {});
  startGame();
}

// 跳跃输入：电脑（鼠标/空格/↑/W）+ 手机（触摸屏幕任意位置）
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (AudioEngine.ctx && AudioEngine.ctx.state === 'suspended') {
    AudioEngine.ctx.resume().catch(() => {}); // iOS 首次触摸恢复音频
  }
  pressJump();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
    e.preventDefault();
    pressJump();
  } else if (e.code === 'Enter') {
    if (S.phase === 'over') restartGame();
    else if (S.phase === 'menu') startFromButton();
  }
});

$('btn-start').addEventListener('click', startFromButton);
$('btn-restart').addEventListener('click', restartGame);
$('btn-home').addEventListener('click', toMenu);

// 切换标签页 → 自动暂停（音频时钟冻结，回来继续时不会错拍）
document.addEventListener('visibilitychange', () => {
  const c = AudioEngine;
  if (!c.ctx) return;
  if (document.hidden) {
    if (c.schedulerId) { clearInterval(c.schedulerId); c.schedulerId = null; }
    if (c.ctx.state === 'running') c.ctx.suspend().catch(() => {});
  } else {
    if (c.ctx.state === 'suspended') c.ctx.resume().catch(() => {});
    if (c.running && !c.schedulerId) c.schedulerId = setInterval(schedulerTick, 25);
  }
});

/* ---------- 启动 ---------- */

AudioEngine.events = buildEvents();
S.best = loadBest();
bestValue.textContent = S.best;
resize();

let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  update(dt);
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
