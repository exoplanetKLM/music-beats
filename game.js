'use strict';

/* ================================================================
   音乐跳动 · 游戏主逻辑（纯 JavaScript，无第三方库）
   需求依据：CLAUDE.md 产品设计文档

   时间同步说明：
     整个游戏只有「一个时钟」——AudioContext.currentTime。
     歌内时间 songTime = currentTime - songStart；障碍与音乐按预计算的
     节拍时间表工作（音画严格同步）；节拍点随机生成，与音乐解绑，
     音乐仅作背景（2026-09-03 起节拍点不再跟随鼓点）。

   结构：
     1. 配置常量（所有可调数值集中在这里）
     2. 节拍时间表（歌曲模式：按节拍分析的拍表；降级模式：BPM 120）
     3. 关卡生成（每一拍安排什么：地面障碍 / 浮空障碍）+ 随机节拍点生成器
     4. 音乐引擎（歌曲模式：三首内嵌 MP3 可切换 + 各自节拍分析对齐循环；
                 降级模式：Web Audio 程序合成 + 预计算事件表）
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
  starColor: '#ffd700',     // 星形节拍点：金色
  obstacleColor: '#ff3355', // 障碍：红色警示

  // —— 跳跃物理（CLAUDE.md 第三章：高度 3 倍方块、时长 0.5 秒）——
  jumpDuration: 0.5,
  jumpBuffer: 0.15,         // 空中按键缓冲：落地前 0.15 秒内的按键在落地瞬间起跳
                            // （稍大于一帧，吸收落地瞬间的浮点误差；再早的按键忽略，
                            //  避免把提前按键转成「落地即跳」撞上障碍）

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

  // —— 星形节拍点（2026-09-03 新增：随机节拍点中 15% 为星形，得分翻倍）——
  starChance: 0.15,         // 星形节拍点概率 15%
  scoreStarPerfect: 400,    // 星形 Perfect 得分
  scoreStarGood: 200,       // 星形 Good 得分

  // —— 随机节拍点生成（2026-09-03：节拍点与音乐解绑，随机生成；音乐仅作背景）——
  noteSpawnMin: 0.7,        // 随机生成间隔下限（秒）
  noteSpawnMax: 1.4,        // 随机生成间隔上限（秒）
  noteRetryDelay: 0.2,      // 与障碍冲突时的重试间隔（秒）
  noteFirstDelay: 0.2,      // 首个节拍点的首次尝试时刻 = leadIn + 此值
  noteGapBefore: 0.65,      // 节拍点到达后此秒数内不得有障碍到达（防踩点后连跳必死）
  noteGapAfter: 0.5,        // 障碍到达后此秒数内不得有节拍点到达（防跳跃未落地接踩点）

  // —— 音乐（CLAUDE.md 第四章）——
  // 歌曲模式：T-ara《No.9》内嵌循环（song-data.js，节拍分析自动对齐）；
  // 降级模式（歌曲加载/分析失败时）：程序合成，BPM 120
  bpm: 120,
  stage1Beats: 64,          // 简单：0-63 拍
  stage2Beats: 64,          // 中等：64-127 拍
  stage3Beats: 64,          // 困难：128-191 拍
  stage4Beats: 64,          // 极难：192-255 拍（之后循环极难段）
  eventBeats: 320,          // 预计算的音乐事件总拍数（约 2 分 40 秒）

  // —— 实体飞行（匀速：难度不再靠加速，改由障碍承担）——
  travelTime: 1.0,          // 元素从屏幕右缘飞到方块处固定 1 秒
  noteOffset: 0.1,          // 障碍到达比鼓点晚 0.1 秒（视觉对齐）；
                            // 随机节拍点的判定时刻 = 到达时刻 − 此值（视觉接触前 0.1 秒按键 = Perfect）

  // —— 浮空障碍（CLAUDE.md 第二章：中后期随机出现，2026-09-02 新增）——
  floatingStartBeat: 64,    // 第 64 拍（中等阶段）起可能出现
  floatingRampBeats: 128,   // 概率爬坡拍数：第 192 拍达到上限
  floatingMaxChance: 0.4,   // 浮空概率上限 40%

  // —— 障碍几何与死亡（CLAUDE.md 第二章）——
  obstacleHeightFactor: 1.2, // 障碍高度 = 方块尺寸 × 1.2
  obstacleWidthFactor: 0.8,  // 障碍宽度 = 方块尺寸 × 0.8

  // —— 流程 ——
  leadIn: 1.0,               // 开局 1 秒准备时间（先见元素、再响音乐）
  deathPause: 0.9,           // 死亡后停顿 0.9 秒再弹出结算界面

  bestKey: 'musicJumpBestScore', // 最高分记录前缀：每首歌一条，键 = 前缀 + 曲目 id
  songKey: 'musicJumpSong',  // 上次选择的背景音乐（localStorage）
};

/* ---------- 1.5 背景音乐曲库（2026-09-03 新增：开始界面可切换） ---------- */
// 每首歌独立内嵌（见 song-data*.js）；data 懒取——只有被选中的歌才解码分析，
// 已解码结果放 AudioEngine.songCache（LRU，最多缓存 2 首）。
const SONGS = [
  { id: 'no9', name: 'No.9', data: () => window.SONG_DATA },
  { id: 'sugar-free', name: 'Sugar Free', data: () => window.SONG_DATA_SUGAR_FREE },
  { id: 'sexy-love', name: 'Sexy Love', data: () => window.SONG_DATA_SEXY_LOVE },
];

/* ---------- 2. 节拍时间表 ---------- */

const TOTAL_BEATS =
  CONFIG.stage1Beats + CONFIG.stage2Beats + CONFIG.stage3Beats + CONFIG.stage4Beats; // 256

// 手动微调（节拍分析不准时使用，正常保持 0）：
//   bpm > 0   用指定 BPM 重建拍表
//   offset > 0 把首拍挪到指定秒数
const SONG_TUNE = { bpm: 0, offset: 0 };

// 一「轮」的长度（秒，进度条用）：歌曲模式 = 256 拍 × 实际拍距
function roundLength() {
  const s = AudioEngine.song;
  if (s && s.beats) return TOTAL_BEATS * (s.loopLen / s.beats.length);
  return TOTAL_BEATS * (60 / CONFIG.bpm);
}

// 节拍时间：歌曲模式按节拍分析出的真实鼓点拍表（循环回绕，与听到的音乐严格同步）；
// 降级模式按固定 BPM 线性延伸（游戏能玩多久，音乐就响多久）
function beatTime(i) {
  const s = AudioEngine.song;
  if (s && s.beats) {
    const n = s.beats.length;
    return s.beats[i % n] - s.beats[0] + Math.floor(i / n) * s.loopLen;
  }
  return i * (60 / CONFIG.bpm);
}

/* ---------- 3. 关卡生成（每一拍的障碍安排，纯函数） ----------
   难度递进（CLAUDE.md 第五章：移动匀速，难度由障碍数量与浮空障碍承担）：
     简单（0-63 拍）：每 12 拍一个障碍（b%12=6）
     中等（64-127 拍）：每 8 拍两个障碍（k=2、k=6）
     困难（128-191 拍）：每 8 拍三个障碍（k=2、k=3 连拍、k=6）
     极难（192-255 拍，之后循环本段）：每 8 拍四个障碍（k=2→3、k=6→7 连拍）
   节拍点（2026-09-03 起）：不再按拍表排布，由 spawnNote() 随机生成；
     排布铁律（防必死连跳）由生成时的间隙规则保证——障碍到达前
     noteGapBefore 秒 / 到达后 noteGapAfter 秒内不生成节拍点，踩点后
     跳障碍、跳障碍后踩点的窗口都足够宽；浮空障碍的「前拍无节拍点」
     约束同样被该间隙覆盖。
   浮空障碍（2026-09-02 新增）：第 64 拍起，障碍按概率（线性爬坡至 40%）转为
     浮空形态——悬在节拍点高度，贴地通过安全、起跳撞上即死（「别跳」的反向考验）。
   浮空与否用确定性散列 beatRand(i) 决定——同一拍永远同一结果，函数保持纯函数。 */

// 256 拍后：循环极难段（后期难度稳定在最高档）
function remapBeat(i) {
  if (i < TOTAL_BEATS) return i;
  return CONFIG.stage1Beats + CONFIG.stage2Beats + CONFIG.stage3Beats +
    ((i - TOTAL_BEATS) % CONFIG.stage4Beats);
}

// 该拍是否安排障碍槽位（数量随阶段递增；槽位前 1 拍均无节拍点）
function slotGroundAt(b) {
  const k = b % 8;
  if (b < CONFIG.stage1Beats) return (b % 12 === 6);
  if (b < CONFIG.stage1Beats + CONFIG.stage2Beats) return (k === 2 || k === 6);
  if (b < CONFIG.stage1Beats + CONFIG.stage2Beats + CONFIG.stage3Beats) {
    return (k === 2 || k === 3 || k === 6);
  }
  return (k === 2 || k === 3 || k === 6 || k === 7);
}

// 确定性伪随机：同一拍永远得到同一个 [0,1) 值
function beatRand(i) {
  let x = Math.imul(i + 1, 0x9E3779B1) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21F0AAAD);
  x = Math.imul(x ^ (x >>> 15), 0x735A2D97);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

// 浮空概率：第 floatingStartBeat 拍起线性爬坡，floatingRampBeats 拍后封顶
function floatingChanceAt(i) {
  if (i < CONFIG.floatingStartBeat) return 0;
  return CONFIG.floatingMaxChance *
    Math.min(1, (i - CONFIG.floatingStartBeat) / CONFIG.floatingRampBeats);
}

// 该拍是否命中浮空概率（最终还要过「前拍约束」）
function wantsFloatAt(i) {
  return beatRand(i) < floatingChanceAt(i);
}

// prev = 上一拍的生成结果（spawnUpcoming / 前瞻扫描顺序调用时传入；留白拍传 undefined）
function patternForBeat(i, prev) {
  const none = { obstacle: false, float: false };
  if (i < 4) return none; // 开局 4 拍留白热身
  const prevP = prev || none;
  const b = remapBeat(i);

  const obstacle = slotGroundAt(b);
  let float = false;
  if (obstacle) {
    // 浮空要求前一拍无需起跳（前拍是地面障碍 → 玩家起跳后来不及落地；
    // 节拍点由随机生成器的间隙规则保证不落在浮空障碍前 1 拍内，这里拦连拍障碍）
    const prevBusy = prevP.obstacle && !prevP.float;
    if (!prevBusy && wantsFloatAt(i)) float = true;
  }

  return { obstacle, float };
}

/* ---------- 4. 音乐引擎（程序合成，见 CLAUDE.md 第四章） ---------- */

const AudioEngine = {
  ctx: null, master: null, session: null, noise: null,
  schedulerId: null, running: false,
  songStart: 0, eventIndex: 0, events: [],
  song: null, songSource: null, // 当前使用的歌曲（含拍表；null = 程序合成降级）
  songId: 'no9',                // 玩家当前选择的曲目（开始界面可切换，localStorage 记忆）
  loadPromises: {},             // 每首歌的在途加载 Promise（防重复解码）
  songCache: new Map(),         // 已解码歌曲缓存（LRU，最多 2 首，防手机内存吃紧）
  pendingSong: null,            // 游戏进行中才加载完成的歌 {id, song}，下一局开局启用

  // 惰性创建：必须在用户点击「开始游戏」后调用（浏览器自动播放策略）
  ensure() {
    if (this.ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      // 音频从挂起中恢复时的自愈：若停摆期间游戏时钟（墙钟兜底）已走到音乐前面，
      // 把音乐起点重锚到游戏时钟，未来音乐事件与画面重新对齐；
      // 正常暂停/恢复时两者无差，这里是空操作。同时续上音乐调度器。
      this.ctx.onstatechange = () => {
        if (this.ctx.state !== 'running') return;
        if (this.running) {
          const gap = songTimeFallback - (this.ctx.currentTime - this.songStart);
          if (gap > 0.05) {
            // 音频停摆期间游戏时钟（墙钟兜底）已走到音乐前面：把时间轴重锚到游戏时钟
            if (this.song && this.songSource) {
              // 歌曲模式：重启音源到与游戏时钟一致的位置
              const pos = this.song.beats[0] + (songTimeFallback % this.song.loopLen);
              try { this.songSource.stop(); } catch (e) {}
              this.songSource = null;
              this.startSong(this.ctx.currentTime, pos);
            }
            this.songStart = this.ctx.currentTime - songTimeFallback;
          }
          if (!this.schedulerId && !this.song) {
            this.schedulerId = setInterval(schedulerTick, 25);
          }
        }
      };
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

  // 加载并分析一首内嵌歌曲（data URL → 解码 → 节拍分析）。返回 Promise<boolean>。
  // 完成时若该曲仍是当前选择：非游戏中直接启用；游戏中则存 pendingSong 下一局
  // 开局启用（避免中途换拍表导致障碍排布跳变）。失败时回退默认曲 No.9。
  loadSong(id) {
    if (this.songCache.has(id)) return Promise.resolve(true);
    if (this.loadPromises[id]) return this.loadPromises[id];
    // 主体放进微任务执行：保证 finally 里的 delete 一定发生在 loadPromises[id] 赋值之后
    // （否则同步失败路径会在赋值前删除，键永远残留，按钮卡在「加载中」且无法重试）
    const p = Promise.resolve().then(async () => {
      try {
        const entry = SONGS.find((s) => s.id === id);
        if (!entry) throw new Error('曲目不存在：' + id);
        const data = entry.data();
        if (typeof data !== 'string') throw new Error('歌曲数据缺失');
        const bytes = await fetch(data).then((r) => r.arrayBuffer());
        const audio = await this.ctx.decodeAudioData(bytes);
        const info = analyzeBeats(audio);
        if (!info || info.beats.length < 32) throw new Error('节拍分析失败');
        let beats = info.beats;
        if (SONG_TUNE.bpm > 0 || SONG_TUNE.offset > 0) {
          // 手动微调：按给定 BPM / 首拍重建拍表（对当前歌曲生效）
          const d = SONG_TUNE.bpm > 0 ? 60 / SONG_TUNE.bpm : beats[1] - beats[0];
          const start = SONG_TUNE.offset > 0 ? SONG_TUNE.offset : beats[0];
          const arr = [];
          for (let t = start; t < audio.duration - d; t += d) arr.push(t);
          beats = arr;
        }
        const n = beats.length;
        const period = beats[n - 1] - beats[n - 2];
        const song = {
          audio, beats,
          loopLen: n * period, // 循环段 = 整拍数（回归后拍距严格均匀，循环点即拍点）
          bpm: 60 / period,
        };
        // LRU 缓存（最多 2 首：当前 + 上一首，切回不用重新解码）
        if (this.songCache.has(id)) this.songCache.delete(id);
        this.songCache.set(id, song);
        while (this.songCache.size > 2) this.songCache.delete(this.songCache.keys().next().value);
        if (id === this.songId) {
          if (S.phase === 'playing') this.pendingSong = { id, song };
          else this.song = song;
        }
        return true;
      } catch (e) {
        console.warn('歌曲加载失败：' + id, e);
        if (id === this.songId && id !== 'no9') selectSong('no9'); // 回退默认曲
        return false;
      } finally {
        delete this.loadPromises[id];
      }
    });
    this.loadPromises[id] = p;
    return p;
  },

  // 启动歌曲音源：从 offset（首个强拍）开始播放，循环到拍表末尾 + 1 拍
  startSong(t0, offset) {
    const s = this.song;
    const src = this.ctx.createBufferSource();
    src.buffer = s.audio;
    src.loop = true;
    src.loopStart = s.beats[0];
    src.loopEnd = Math.min(s.audio.duration, s.beats[0] + s.loopLen);
    src.connect(this.session);
    src.start(t0, offset);
    this.songSource = src;
  },
};

/* —— 节拍分析（内嵌歌曲）——
   能量包络差分（onset 强度）→ 自相关求 BPM → 相位对齐 → 逐拍追踪 →
   迭代重加权回归。恒定速度的电子舞曲拍点严格均匀，回归把逐拍抓取的
   抖动（±20~60ms）消到 ≈0，并锁定主网格（离群游走段权重收敛到 0）。
   返回 { bpm, beats }：beats = 每拍在音频内的绝对时间（秒）。 */
function analyzeBeats(audio) {
  const sr = audio.sampleRate;
  const ch = audio.getChannelData(0);
  const hop = Math.max(256, Math.round(sr / 86)); // ≈11.6ms 一帧
  const hopSec = hop / sr;
  const frames = Math.floor(ch.length / hop);
  const duration = ch.length / sr;
  if (frames < 2000) return null;

  // 1) 能量包络 + onset 强度（正向能量差分）
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0; const off = f * hop;
    for (let j = 0; j < hop; j += 8) { const v = ch[off + j]; sum += v * v; }
    env[f] = Math.sqrt(sum / (hop / 8));
  }
  const flux = new Float64Array(frames);
  let fluxMax = 0;
  for (let f = 1; f < frames; f++) {
    flux[f] = Math.max(0, env[f] - env[f - 1]);
    if (flux[f] > fluxMax) fluxMax = flux[f];
  }
  const sigFlux = 0.2 * fluxMax; // 显著 onset 阈值（首个强拍判定）

  // 2) BPM 粗估：自相关（90~170 BPM）+ 抛物线精修
  function corrAt(lag) {
    let s = 0; const n = frames - lag;
    for (let f = 0; f < n; f += 4) s += flux[f] * flux[f + lag];
    return s;
  }
  const minLag = Math.round((60 / 170) / hopSec);
  const maxLag = Math.round((60 / 90) / hopSec);
  let bestLag = minLag, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const s = corrAt(lag);
    if (s > bestScore) { bestScore = s; bestLag = lag; }
  }
  const s0 = corrAt(bestLag - 1), s2 = corrAt(bestLag + 1);
  const denom = s0 - 2 * bestScore + s2;
  const lagRef = bestLag + (denom !== 0 ? (0.5 * (s0 - s2)) / denom : 0);
  const beatDur = lagRef * hopSec;

  // 3) 相位：候选相位扫描（每拍独立取整，无累积漂移）
  const K = Math.max(2, Math.round(beatDur / hopSec));
  let bestPhase = 0, bestSum = -Infinity;
  for (let p = 0; p < K; p++) {
    let sum = 0;
    for (let t = p * hopSec; t < duration; t += beatDur) {
      const f = Math.round(t / hopSec);
      if (f < frames) sum += flux[f];
    }
    if (sum > bestSum) { bestSum = sum; bestPhase = p * hopSec; }
  }

  // 4) 逐拍追踪：从首个强拍开始，每拍在网格 ±0.18 拍内找局部最强 onset。
  //    固定周期 + 逐拍重锚（小误差不累积）；窗口够不到半拍的踩镲/反拍；
  //    弱拍维持网格位置不被带偏。
  const beats = [];
  const maxBeatT = duration - 2 * beatDur;
  const snapThresh = 0.12 * fluxMax; // 低于此强度的 onset 不抓取（防弱拍带偏网格）
  let t = bestPhase, started = false;
  while (t < maxBeatT) {
    const f0 = Math.round(t / hopSec);
    const rad = Math.round((0.18 * beatDur) / hopSec);
    let bestF = f0, bestV = flux[f0] || 0;
    for (let f = Math.max(0, f0 - rad); f <= Math.min(frames - 1, f0 + rad); f++) {
      if (flux[f] > bestV) { bestV = flux[f]; bestF = f; }
    }
    if (bestV < snapThresh) bestF = f0; // 无显著 onset：保持网格位置
    const tHit = bestF * hopSec;
    if (!started && bestV >= sigFlux) { beats.length = 0; started = true; } // 首个强拍：网格从这里开始
    if (started) beats.push(tHit);
    t = tHit + beatDur;
  }
  if (beats.length < 32) return null;

  // 5) 迭代重加权回归：锁定主网格，消掉逐拍抖动与游走段
  const n = beats.length;
  const diffs = [];
  for (let i = 8; i < n; i++) diffs.push((beats[i] - beats[i - 8]) / 8); // 8 拍间隔抗离群
  diffs.sort((x, y) => x - y);
  let b = diffs[Math.floor(diffs.length / 2)]; // 初始斜率：中位数
  let a = beats[0];
  for (let iter = 0; iter < 6; iter++) {
    let W = 0, WX = 0, WY = 0, WXY = 0, WXX = 0;
    for (let i = 0; i < n; i++) {
      const r = Math.abs(beats[i] - (a + i * b));
      const w = r < 0.08 ? 1 : (r < 0.15 ? (0.15 - r) / 0.07 : 0);
      W += w; WX += w * i; WY += w * beats[i]; WXY += w * i * beats[i]; WXX += w * i * i;
    }
    if (W < n * 0.2) break;
    b = (W * WXY - WX * WY) / (W * WXX - WX * WX);
    a = (WY - b * WX) / W;
  }
  let ok = 0;
  for (let i = 0; i < n; i++) if (Math.abs(beats[i] - (a + i * b)) < 0.05) ok++;
  if (ok > n * 0.6) for (let i = 0; i < n; i++) beats[i] = a + i * b; // 用回归直线替换逐拍结果
  return { bpm: 60 / b, beats };
}

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
  if (c.songSource) { try { c.songSource.stop(); } catch (e) {} c.songSource = null; }
  // 若上一局音乐还连着（连点两次开始），先淡出旧通道，避免两路声音叠响
  if (c.session) {
    const old = c.session;
    old.gain.setTargetAtTime(0, c.ctx.currentTime, 0.03);
    setTimeout(() => { try { old.disconnect(); } catch (e) {} }, 200);
    c.session = null;
  }
  c.eventIndex = 0;
  c.songStart = c.ctx.currentTime + CONFIG.leadIn;
  songTimeFallback = -CONFIG.leadIn; // 与音乐起点对齐（开局准备时间内为负值）
  c.session = c.ctx.createGain(); // 每局一个独立音量通道
  c.session.gain.value = 1;
  c.session.connect(c.master);
  c.running = true;
  if (c.song) {
    c.startSong(c.songStart, c.song.beats[0]); // 歌曲模式：从首个强拍开始（跳过前奏）
  } else {
    c.schedulerId = setInterval(schedulerTick, 25); // 降级：程序合成音乐
  }
}

function fadeOutMusic() { // 死亡 / 返回首页时淡出本局音乐
  const c = AudioEngine;
  if (c.songSource) { try { c.songSource.stop(); } catch (e) {} c.songSource = null; }
  if (c.session) {
    const s = c.session;
    s.gain.setTargetAtTime(0, c.ctx.currentTime, 0.06);
    setTimeout(() => { try { s.disconnect(); } catch (e) {} }, 500);
    c.session = null;
  }
  if (c.schedulerId) { clearInterval(c.schedulerId); c.schedulerId = null; }
  c.running = false;
}

// 游戏时钟：正常情况下跟随音频时钟（音画严格同步）。当音频上下文被浏览器或
// 系统意外挂起（切后台、系统音频中断、自动挂起等）时，音频时钟停摆——此时由
// update() 用墙钟兜底推进本变量，游戏画面与跳跃绝不冻结；音频恢复后由
// ensure() 里的 onstatechange 重锚 songStart，音画自动重新对齐。
let songTimeFallback = 0;
let resumeRetryAt = 0; // 音频停摆时周期性重试 resume 的时机（游戏时间）
function songTime() {
  const c = AudioEngine.ctx;
  if (c && c.state === 'running') {
    songTimeFallback = c.currentTime - AudioEngine.songStart; // 音频在走：跟随音频时钟
  }
  return songTimeFallback;
}

/* ---------- 5. 游戏状态与实体 ---------- */

const S = {
  phase: 'menu',            // menu | playing | dying | over
  score: 0, combo: 0,
  bests: {},                // 每首歌的最高分记录（id → 分数，2026-09-03 起独立计算）
  bestRowEls: {},           // 小榜单行 DOM 引用（id → { row, val }）
  jumpStart: -10,           // 上一次起跳时刻（歌内时间）
  jumpBufferUntil: -1,      // 空中按键的缓冲截止时刻
  entities: [],             // { type, start, dur, judged, beatT }
  particles: [], texts: [], trail: [],
  spawnIndex: 0,            // 下一个要生成的拍号
  lastPat: { obstacle: false, float: false }, // 上一拍的生成结果（浮空约束用）
  nextNoteAt: 0,            // 下一个随机节拍点的首次尝试时刻
  obstacleTimes: [],        // 前瞻窗口内障碍的到达时刻（升序，随机节拍点避让用）
  lookaheadIndex: 0,        // 障碍前瞻已扫描到的拍号
  lookaheadPat: { obstacle: false, float: false }, // 前瞻的上一拍结果（与 lastPat 同步演进）
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
const finalScore = $('final-score'), finalBestSong = $('final-best-song');
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
  // 空中按键 → 落地瞬间起跳（仅限落地前 jumpBuffer 秒内）：
  // 「节拍点后 1 拍紧跟障碍」的连跳需要这层缓冲，但窗口保持短小，
  // 更早的按键直接忽略——否则会把误按/连点转成落地即跳，撞上紧随的障碍。
  else S.jumpBufferUntil = songTime() + CONFIG.jumpBuffer;
}

// 当前世界速度：全程匀速（元素从右缘飞到方块处固定 travelTime 秒，
// 难度不再靠加速，改由障碍数量与浮空障碍承担）
function speedNow() {
  return (W - playerX) / CONFIG.travelTime;
}

// 按到达时间反推出生时间，到点就把该拍的障碍放进屏幕（节拍点改由 spawnNote 随机生成）。
// 同时前瞻扫描未来 travelTime + 间隙内的障碍到达时刻，登记给随机节拍点避让查询。
// 前瞻与主循环各自链式调用纯函数 patternForBeat：起点一致、顺序一致 → 结果必然一致。
function spawnUpcoming() {
  const t = songTime();
  while (true) {
    const b = S.spawnIndex;
    const arrival = beatTime(b) + CONFIG.noteOffset;
    const travelT = (W - playerX) / speedNow();
    const spawnT = arrival - travelT;
    if (t < spawnT) break;
    const p = patternForBeat(b, S.lastPat); // 前拍结果用于浮空障碍的公平性约束
    S.lastPat = p;
    if (p.obstacle) S.entities.push({ type: 'obstacle', float: p.float, start: spawnT, dur: travelT });
    S.spawnIndex++;
    if (S.spawnIndex > 100000) break; // 保险丝
  }
  // 障碍到达时间前瞻（供 spawnNote 避让；覆盖候选节拍点可能的全部冲突区间）
  const gap = Math.max(CONFIG.noteGapBefore, CONFIG.noteGapAfter);
  while (beatTime(S.lookaheadIndex) + CONFIG.noteOffset <= t + CONFIG.travelTime + gap) {
    const p = patternForBeat(S.lookaheadIndex, S.lookaheadPat);
    S.lookaheadPat = p;
    if (p.obstacle) S.obstacleTimes.push(beatTime(S.lookaheadIndex) + CONFIG.noteOffset);
    S.lookaheadIndex++;
    if (S.lookaheadIndex > 100000) break; // 保险丝
  }
}

// 随机节拍点生成（2026-09-03：与音乐解绑，音乐仅作背景）：
// 每隔 noteSpawnMin~noteSpawnMax 秒尝试在右缘生成一个节拍点（starChance 概率为星形）。
// 避让铁律：障碍到达前 noteGapBefore 秒 / 到达后 noteGapAfter 秒内不生成——
// 否则「踩点后连跳障碍」或「跳障碍后接踩点」的窗口不足（必死/必漏）。
// 冲突时以 noteRetryDelay 间隔重试（候选到达窗口逐帧前滑，天然滑入空档）。
function spawnNote() {
  const t = songTime();
  const gap = Math.max(CONFIG.noteGapBefore, CONFIG.noteGapAfter);
  while (S.obstacleTimes.length && S.obstacleTimes[0] < t - gap) S.obstacleTimes.shift();
  if (t < S.nextNoteAt) return;
  const A = t + CONFIG.travelTime; // 候选到达时刻（立即从右缘出生）
  for (const O of S.obstacleTimes) {
    if (O > A - CONFIG.noteGapBefore && O < A + CONFIG.noteGapAfter) {
      S.nextNoteAt = t + CONFIG.noteRetryDelay; // 与障碍冲突：稍后重试
      return;
    }
  }
  const isStar = Math.random() < CONFIG.starChance;
  S.entities.push({
    type: isStar ? 'star' : 'note',
    start: t, dur: CONFIG.travelTime, judged: false,
    beatT: A - CONFIG.noteOffset, // 视觉接触前 0.1 秒按键 = Perfect（与原手感一致）
  });
  S.nextNoteAt = t + CONFIG.noteSpawnMin + Math.random() * (CONFIG.noteSpawnMax - CONFIG.noteSpawnMin);
}

function comboMult() {
  return Math.min(1 + Math.floor(S.combo / CONFIG.comboStep), CONFIG.maxComboMult);
}

// 节拍判定：按时间（|起跳 − 判定时刻|），超窗但画面接触 → 兜底 Good
function judgeNote(e, playerH) {
  e.judged = true;
  const dt = S.jumpStart - e.beatT;
  if (Math.abs(dt) <= CONFIG.perfectWindow) return 'perfect';
  if (Math.abs(dt) <= CONFIG.goodWindow) return 'good';
  const dy = Math.abs(playerH + squareSize / 2 - CONFIG.noteHeightFactor * squareSize);
  if (dy <= (CONFIG.noteRadiusFactor + 0.5) * squareSize) return 'good';
  return 'miss';
}

function applyHit(kind, e) {
  S.combo++;
  const star = e.type === 'star';
  const base = star
    ? (kind === 'perfect' ? CONFIG.scoreStarPerfect : CONFIG.scoreStarGood)
    : (kind === 'perfect' ? CONFIG.scorePerfect : CONFIG.scoreGood);
  S.score += base * comboMult();
  const ny = groundY - CONFIG.noteHeightFactor * squareSize;
  addText(star
      ? (kind === 'perfect' ? '★ Perfect!' : '★ Good')
      : (kind === 'perfect' ? 'Perfect!' : 'Good'),
    playerX, ny - 34,
    star ? CONFIG.starColor : (kind === 'perfect' ? CONFIG.playerColor : '#e8e8f0'));
  burst(playerX, ny, star ? CONFIG.starColor : CONFIG.noteColor,
    star ? (kind === 'perfect' ? 20 : 12) : (kind === 'perfect' ? 16 : 9));
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
  // 音频时钟停摆自愈：画面与跳跃改用墙钟兜底推进（游戏绝不冻结），
  // 并周期性尝试把音频拉回来（覆盖 'suspended' / iOS 的 'interrupted' 等状态）。
  const ac = AudioEngine.ctx;
  if (ac && ac.state !== 'running') {
    songTimeFallback += dt;
    if (S.phase === 'playing' && ac.state !== 'closed' && songTimeFallback >= resumeRetryAt) {
      resumeRetryAt = songTimeFallback + 0.5;
      ac.resume().catch(() => {});
    }
  }
  const t = songTime();

  // 当前鼓点推进（画面脉动用）
  while (beatTime(S.beatCursor + 1) <= t) S.beatCursor++;

  // 落地缓冲跳（>= 吸收落地瞬间的浮点边界误差）
  if (S.phase === 'playing' && S.jumpBufferUntil >= t && isGrounded()) {
    S.jumpStart = t; S.jumpBufferUntil = -1;
  }
  // 生成新元素（障碍按节拍表，节拍点随机）
  if (S.phase === 'playing') { spawnUpcoming(); spawnNote(); }

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

    if (e.type === 'note' || e.type === 'star') {
      if (S.phase === 'playing' && !e.judged && x <= playerX) {
        const kind = judgeNote(e, playerH);
        if (kind === 'miss') applyMiss();
        else { applyHit(kind, e); S.entities.splice(i, 1); continue; }
      }
    } else if (S.phase === 'playing') {
      // 障碍碰撞：横向重叠时按形态判定
      const halfW = (CONFIG.obstacleWidthFactor * squareSize + squareSize) / 2;
      if (Math.abs(x - playerX) < halfW) {
        if (e.float) {
          // 浮空障碍：贴地通过安全；方块顶部进入障碍下沿 → 游戏结束
          const boxBottom = CONFIG.noteHeightFactor * squareSize - CONFIG.obstacleHeightFactor * squareSize / 2;
          if (playerH + squareSize > boxBottom) { die(); break; }
        } else if (playerH < CONFIG.obstacleHeightFactor * squareSize) {
          // 地面障碍：方块下沿低于障碍顶部 → 游戏结束
          die();
          break;
        }
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

function starPath(cx, cy, r, rot) { // 五角星路径（外径 r、内径 r×0.45，仅路径不填充）
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = (i % 2 === 0) ? r : r * 0.45;
    const a = -Math.PI / 2 + i * Math.PI / 5 + rot;
    const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
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
    if (e.type === 'note' || e.type === 'star') {
      // 未踩中的节拍点越过玩家后淡出
      let alpha = 1;
      if (e.judged) alpha = Math.max(0, 1 - (p - 1) * 2.5);
      const star = e.type === 'star';
      const col = star ? CONFIG.starColor : CONFIG.noteColor;
      const ny = groundY - CONFIG.noteHeightFactor * squareSize;
      const r = CONFIG.noteRadiusFactor * squareSize * (1 + 0.08 * Math.sin(t * 8));
      ctx.globalAlpha = alpha * 0.28;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, ny, r * 1.9, 0, Math.PI * 2); ctx.fill(); // 外圈光晕
      ctx.globalAlpha = alpha;
      ctx.shadowColor = col; ctx.shadowBlur = 16;
      if (star) { starPath(x, ny, r, t * 1.2); ctx.fill(); }            // 星形：缓慢旋转
      else { ctx.beginPath(); ctx.arc(x, ny, r, 0, Math.PI * 2); ctx.fill(); } // 圆形核心
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    } else {
      const ow = CONFIG.obstacleWidthFactor * squareSize;
      const oh = CONFIG.obstacleHeightFactor * squareSize;
      if (e.float) {
        // 浮空障碍：悬在节拍点高度轻微浮动，贴地通过、起跳撞上
        const oy = groundY - CONFIG.noteHeightFactor * squareSize - oh / 2
          + Math.sin(t * 5 + e.start * 7) * 3;
        const ox = x - ow / 2;
        ctx.fillStyle = CONFIG.obstacleColor;
        ctx.shadowColor = CONFIG.obstacleColor; ctx.shadowBlur = 14;
        rr(ox, oy, ow, oh, 4); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(10,10,20,0.55)'; // 内芯警示条纹
        ctx.fillRect(x - ow * 0.12, oy + oh * 0.16, ow * 0.24, oh * 0.68);
        // 上下警示线：强调「别跳，从下面过」
        ctx.strokeStyle = 'rgba(255,51,85,0.45)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x - ow * 0.7, oy - 6); ctx.lineTo(x + ow * 0.7, oy - 6); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - ow * 0.7, oy + oh + 6); ctx.lineTo(x + ow * 0.7, oy + oh + 6); ctx.stroke();
      } else {
        const ox = x - ow / 2, oy = groundY - oh;
        ctx.fillStyle = CONFIG.obstacleColor;
        ctx.shadowColor = CONFIG.obstacleColor; ctx.shadowBlur = 14;
        rr(ox, oy, ow, oh, 3); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(10,10,20,0.55)'; // 内芯警示条纹
        ctx.fillRect(x - ow * 0.12, oy + oh * 0.16, ow * 0.24, oh * 0.68);
      }
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

// 最高分记录按曲目分键（2026-09-03：每首歌的记录独立计算，互不影响）
function bestKeyFor(id) {
  return CONFIG.bestKey + ':' + id;
}
function loadBest(id) {
  try { return Number(localStorage.getItem(bestKeyFor(id))) || 0; } catch (e) { return 0; }
}
function saveBest(id, v) {
  try { localStorage.setItem(bestKeyFor(id), String(v)); } catch (e) {}
}
function bestFor(id) {
  return S.bests[id] || 0;
}
function songName(id) {
  const s = SONGS.find((x) => x.id === id);
  return s ? s.name : id;
}
function loadSongId() {
  try { return localStorage.getItem(CONFIG.songKey) || ''; } catch (e) { return ''; }
}
function saveSongId(v) {
  try { localStorage.setItem(CONFIG.songKey, String(v)); } catch (e) {}
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
  const pct = Math.max(0, Math.min(1, songTime() / roundLength()));
  progressFill.style.width = (pct * 100).toFixed(1) + '%';
}

// —— 背景音乐切换（2026-09-03 新增）——
// 选择曲目：记录选择 → 按钮高亮 → 未缓存则异步解码分析（期间禁用开始按钮，
// 避免「选了歌却响合成音乐」）。加载失败自动回退 No.9，再失败则程序合成降级。
function selectSong(id) {
  if (!SONGS.some((s) => s.id === id)) return;
  AudioEngine.songId = id;
  saveSongId(id);
  const cached = AudioEngine.songCache.get(id);
  if (cached) {
    if (S.phase === 'playing') AudioEngine.pendingSong = { id, song: cached };
    else AudioEngine.song = cached;
    setStartEnabled(true);
    refreshSongButtons();
    refreshBestList();
    return;
  }
  setStartEnabled(false);
  AudioEngine.loadSong(id).then(() => { // 先发起加载（同步建立 loadPromises），再刷新按钮的 loading 态
    refreshSongButtons();
    if (AudioEngine.songId === id) setStartEnabled(true);
  });
  refreshSongButtons();
  refreshBestList();
}

function refreshSongButtons() {
  for (const btn of document.querySelectorAll('.btn-song')) {
    const id = btn.getAttribute('data-song');
    const entry = SONGS.find((s) => s.id === id);
    if (!entry) continue;
    const active = id === AudioEngine.songId;
    const loading = active && !!AudioEngine.loadPromises[id];
    btn.classList.toggle('active', active);
    btn.classList.toggle('loading', loading);
    btn.textContent = loading ? entry.name + '…' : entry.name;
  }
}

// —— 各曲最高分小榜单（2026-09-03 新增：每首歌的记录独立展示）——
// 榜单行由 SONGS 生成（以后加歌自动扩展），启动时 build 一次，之后只刷新数值与高亮。
function buildBestList() {
  const box = $('best-rows');
  box.innerHTML = '';
  S.bestRowEls = {};
  for (const s of SONGS) {
    const row = document.createElement('p');
    row.className = 'best-row';
    row.setAttribute('data-song', s.id);
    const name = document.createElement('span');
    name.className = 'best-row-name';
    name.textContent = s.name;
    const val = document.createElement('span');
    val.className = 'best-row-value';
    row.appendChild(name);
    row.appendChild(val);
    box.appendChild(row);
    S.bestRowEls[s.id] = { row, val };
  }
  refreshBestList();
}
function refreshBestList() {
  for (const s of SONGS) {
    const ref = S.bestRowEls[s.id];
    if (!ref) continue;
    ref.val.textContent = bestFor(s.id);
    ref.row.classList.toggle('current', s.id === AudioEngine.songId);
  }
}

function setStartEnabled(on) {
  $('btn-start').disabled = !on;
}

function startGame() {
  S.phase = 'playing';
  S.score = 0; S.combo = 0;
  S.entities = []; S.particles = []; S.texts = []; S.trail = [];
  S.spawnIndex = 0; S.beatCursor = 0; S.worldOffset = 0;
  S.lastPat = { obstacle: false, float: false };
  S.nextNoteAt = CONFIG.leadIn + CONFIG.noteFirstDelay; // 首个节拍点：音乐响起后 noteFirstDelay 秒尝试
  S.obstacleTimes = []; S.lookaheadIndex = 0;
  S.lookaheadPat = { obstacle: false, float: false };
  S.jumpStart = -10; S.jumpBufferUntil = -1;
  resumeRetryAt = 0;
  S.flash = 0; S.shake = 0;
  menuEl.classList.add('hidden');
  gameoverEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  // 上一局进行中才加载完成的歌曲在这里启用（拍表与障碍排布从本局开始一致）
  if (AudioEngine.pendingSong && AudioEngine.pendingSong.id === AudioEngine.songId) {
    AudioEngine.song = AudioEngine.pendingSong.song;
    AudioEngine.pendingSong = null;
  }
  startMusic();
}

function showGameOver() {
  S.phase = 'over';
  S.entities = []; // 清掉画面上遗留的元素，结算界面保持干净
  // 纪录按本局所用歌曲独立对比/保存（游戏中选歌 UI 不可达，songId 即本局歌曲）
  const runSong = AudioEngine.songId;
  const isNew = S.score > bestFor(runSong);
  if (isNew) { S.bests[runSong] = S.score; saveBest(runSong, S.score); }
  finalScore.textContent = S.score + ' 分';
  finalBestSong.textContent = '《' + songName(runSong) + '》';
  finalBestValue.textContent = bestFor(runSong);
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
  refreshBestList();
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
for (const btn of document.querySelectorAll('.btn-song')) {
  btn.addEventListener('click', () => selectSong(btn.getAttribute('data-song')));
}

// 切换标签页 → 自动暂停（音频时钟冻结，回来继续时不会错拍）
document.addEventListener('visibilitychange', () => {
  const c = AudioEngine;
  if (!c.ctx) return;
  if (document.hidden) {
    if (c.schedulerId) { clearInterval(c.schedulerId); c.schedulerId = null; }
    if (c.ctx.state === 'running') c.ctx.suspend().catch(() => {});
  } else {
    if (c.ctx.state === 'suspended') c.ctx.resume().catch(() => {});
    if (c.running && !c.schedulerId && !c.song) {
      c.schedulerId = setInterval(schedulerTick, 25); // 仅降级模式需要合成器调度
    }
  }
});

/* ---------- 启动 ---------- */

AudioEngine.events = buildEvents(); // 降级模式（程序合成）的事件表
AudioEngine.ensure();               // 提前创建音频上下文（用户点击开始时再 resume）
// 恢复上次选择的背景音乐并异步解码分析（加载完成前开始按钮禁用；失败则程序合成降级）
const savedSongId = loadSongId();
AudioEngine.songId = SONGS.some((s) => s.id === savedSongId) ? savedSongId : 'no9';
setStartEnabled(false);
AudioEngine.loadSong(AudioEngine.songId).then(() => {
  refreshSongButtons();
  setStartEnabled(true);
});
refreshSongButtons();
// 每首歌的最高分记录 + 旧全局最高分一次性迁移到《No.9》
for (const s of SONGS) S.bests[s.id] = loadBest(s.id);
try {
  const legacy = Number(localStorage.getItem(CONFIG.bestKey)) || 0;
  if (legacy > 0) {
    if (legacy > S.bests.no9) { S.bests.no9 = legacy; saveBest('no9', legacy); }
    localStorage.removeItem(CONFIG.bestKey);
  }
} catch (e) {}
buildBestList();
resize();

let lastT = performance.now();
let lastFrameError = '';
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  try {
    update(dt);
    render();
  } catch (err) {
    // 任何一帧异常都不允许打断主循环（否则画面永久定格）；同类错误只打印一次
    if (String(err) !== lastFrameError) {
      lastFrameError = String(err);
      console.error('帧异常（已跳过本帧）:', err);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
