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

  // —— 奖励时间（2026-09-20 新增：1/2/3 分钟各 15 秒无障碍，专心吃节拍点得分）——
  bonusAtSec: [60, 120, 180],  // 触发时刻（歌内秒数，一局共三次，之后不再给）
  bonusDuration: 15,           // 奖励时间时长（秒）
  bonusClearMargin: 0.2,       // 窗口末尾额外清障余量（秒）：障碍碰撞半宽 = 0.9×方块尺寸，
                               // 换算成时间最大约 0.17 秒（手机竖屏），不加会出现
                               // 「窗口结束前几十毫秒被末尾障碍撞死」的判定
  bonusNoteSpawnMin: 0.5,      // 奖励时间内节拍点间隔下限（= 跳跃时长，一跳接一跳）
  bonusNoteSpawnMax: 0.8,      // 奖励时间内节拍点间隔上限（平时 0.7~1.4）
  bonusStarChance: 0.3,        // 奖励时间内星形概率（平时 starChance = 0.15）

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

  // —— 浮空障碍（CLAUDE.md 第二章：2026-09-02 新增，2026-09-21 改：开局即可出现）——
  floatingStartBeat: 0,     // 开局即可出现（原为第 64 拍）
  floatingBaseChance: 0.2,  // 开局概率（原来隐含为 0，现在 20% 起步）
  floatingRampBeats: 64,    // 概率爬坡拍数：64 拍（约 30 秒）后达到上限
  floatingMaxChance: 0.4,   // 浮空概率上限 40%

  // —— 障碍几何与死亡（CLAUDE.md 第二章）——
  obstacleHeightFactor: 1.2, // 障碍高度 = 方块尺寸 × 1.2
  obstacleWidthFactor: 0.8,  // 障碍宽度 = 方块尺寸 × 0.8

  // —— 蓝色巨障与护盾（2026-09-20 新增，2026-09-21 改：30 秒起；跳不过去，必须开盾撞破）——
  blueObstacleColor: '#2f7dff', // 蓝色巨障（特意区别于方块青 #00e5ff）
  shieldColor: '#d8f6ff',    // 护盾光环
  blueStartSec: 30,          // 30 秒之后开始出现（歌内秒数；原为 90）
  blueMinGap: 5,             // 出现间隔下限（秒）：不宜再低于护盾冷却（4 秒），
                             // 否则「看到蓝墙就按 K」会来不及（5 秒时余量 1 秒）
  blueMaxGap: 9,             // 出现间隔上限（秒）
  blueLead: 0.7,             // 到达时刻的提前量（秒）：≥ noteGapAfter，节拍点才躲得开；
                             // 并进飞行时长（见 spawnBlueObstacle），不是提前站在右缘。
                             // 飞行时长 travelTime+blueLead = 1.7 秒 > shieldDuration，
                             // 这是「看到蓝墙要稍等再按」的由来
  blueHeightFactor: 3.6,     // 仅渲染用：碰撞对蓝墙一律致命（跳跃顶点 3×方块 → 跳不过去）
  blueWidthFactor: 1.1,      // 宽度 = 方块尺寸 × 1.1
  blueClearGap: 0.6,         // 与其它障碍到达时刻的最小间隔（防「刚跳完就要盾」）
  blueRetryStep: 0.15,       // 冲突重试步长：须小于极难段的空档宽度，否则会跨过唯一空位
  blueRetryLimit: 2.5,       // 连续重试上限（秒）：超时放弃本次、重新排期（防无限重试）
  bluePostBonusGrace: 1.5,   // 奖励时间结束后此秒数内不出蓝色巨障
  shieldDuration: 1.5,       // 护盾持续（秒）：比蓝墙 1.7 秒的飞行时长还短，
                             // 所以「看到墙立刻按」会差 0.2 秒撞死——要等墙飞近一点再按
  shieldCooldown: 4,         // 冷却：从「按下」算起 4 秒后可再按（护盾结束后有 2.5 秒空窗）
  scoreBlueSmash: 400,       // 撞破得分（固定分，不吃连击倍率）

  // —— 流程 ——
  leadIn: 1.0,               // 开局 1 秒准备时间（先见元素、再响音乐）
  deathPause: 0.9,           // 死亡后停顿 0.9 秒再弹出结算界面

  bestKey: 'musicJumpBestScore', // 最高分记录前缀：每首歌一条，键 = 前缀 + 曲目 id
  songKey: 'musicJumpSong',  // 上次选择的背景音乐（localStorage）
  howToKey: 'musicJumpHowTo', // 玩法说明「看过了」的标记：首次进入自动弹窗，只弹一次
  songLoadTimeout: 12,       // 歌曲加载超时（秒）：超时先放行（用合成音乐开打），
                             // 数据到位后自动换上——避免 CDN 慢/不通时菜单被卡死
};

/* ---------- 1.5 背景音乐曲库（2026-09-03 新增：音乐选择弹窗里切换） ---------- */
// 每首歌独立内嵌（见 song-data*.js）；数据**按需加载**——只有被选中的歌才注入数据脚本、
// 解码分析（见 ensureSongData），已解码结果放 AudioEngine.songCache（LRU，最多缓存 2 首）。
// file = 该曲数据脚本的文件名；tune 可选，见 SONG_TUNE 注释（正常不写）。
const SONGS = [
  { id: 'no9', name: 'No.9（T-ara）', file: 'song-data.js', data: () => window.SONG_DATA },
  { id: 'sugar-free', name: 'Sugar Free（T-ara）', file: 'song-data-sugar-free.js', data: () => window.SONG_DATA_SUGAR_FREE },
  { id: 'sexy-love', name: 'Sexy Love（T-ara）', file: 'song-data-sexy-love.js', data: () => window.SONG_DATA_SEXY_LOVE },
  { id: 'shattered', name: '纠缠Shattered（叶自冉）', file: 'song-data-shattered.js', data: () => window.SONG_DATA_SHATTERED },
  { id: 'flower', name: 'flower.（LYVET李维特）', file: 'song-data-flower.js', data: () => window.SONG_DATA_FLOWER },
];

// 数据脚本按需加载（2026-09-21）。三条放行路径，保证「没有加载器」时行为与从前一致：
//   · 单文件产物：build-single.js 把 __loadSongScript 短路成 Promise.resolve(true)；
//   · 无头测试桩 / 其他宿主：window 上没有这个方法 → 直接放行，走 data() 返回 undefined
//     的既有失败路径（'歌曲数据缺失'）；
//   · 没写 file 字段：当作数据已就位。
// 加载器约定只 resolve(true/false) 不 reject；这里再兜一层，绝不让它把 loadSong 的链带崩。
function ensureSongData(entry) {
  if (!entry.file) return Promise.resolve(true);
  if (typeof window.__loadSongScript !== 'function') return Promise.resolve(true);
  try {
    return Promise.resolve(window.__loadSongScript(entry.id, entry.file))
      .then((ok) => ok !== false, () => false);
  } catch (e) { return Promise.resolve(false); }
}

/* ---------- 2. 节拍时间表 ---------- */

const TOTAL_BEATS =
  CONFIG.stage1Beats + CONFIG.stage2Beats + CONFIG.stage3Beats + CONFIG.stage4Beats; // 256

// 手动微调（节拍分析不准时使用，正常保持 0）：
//   bpm > 0   用指定 BPM 重建均匀拍表（也是把难度密度拉回常规区间的手段——BPM 直接决定
//             一轮的秒数，太快会让「每 8 拍 4 个障碍」变成跳跃时长压不住的连拍）
//   offset > 0 把首拍挪到指定秒数
// 这是全局默认值；单曲可用 SONGS[].tune 覆盖（没写的字段按「不覆盖」处理——
// undefined > 0 为 false，所以 { offset: 1.2 } 这种半截对象是合法的）
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
   浮空障碍（2026-09-02 新增，2026-09-21 起开局就有）：障碍按概率转为浮空形态
     （20% 起步、64 拍爬到 40% 封顶）——悬在节拍点高度，贴地通过安全、起跳撞上即死
     （「别跳」的反向考验）。
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

// 浮空概率：从 floatingBaseChance（开局就有）线性爬坡，floatingRampBeats 拍后到上限
function floatingChanceAt(i) {
  if (i < CONFIG.floatingStartBeat) return 0;
  const k = Math.min(1, (i - CONFIG.floatingStartBeat) / CONFIG.floatingRampBeats);
  return CONFIG.floatingBaseChance + (CONFIG.floatingMaxChance - CONFIG.floatingBaseChance) * k;
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
        // 按需加载数据脚本。这个 await 必须留在微任务里（不能在 .then 之前 await）：
        // 上面那行 loadPromises[id] = p 尚未执行，提前 await 会让同步失败路径在赋值之前
        // 跑到 finally 的 delete，键永远残留、按钮卡在「加载中」且无法重试。
        if (!(await ensureSongData(entry))) throw new Error('歌曲数据脚本未就绪：' + id);
        const data = entry.data();
        if (typeof data !== 'string') throw new Error('歌曲数据缺失');
        const bytes = await fetch(data).then((r) => r.arrayBuffer());
        const audio = await this.ctx.decodeAudioData(bytes);
        const info = analyzeBeats(audio);
        if (!info || info.beats.length < 32) throw new Error('节拍分析失败');
        let beats = info.beats;
        const tune = entry.tune || SONG_TUNE; // 逐曲微调优先，全局默认兜底
        if (tune.bpm > 0 || tune.offset > 0) {
          // 手动微调：按给定 BPM / 首拍重建拍表（对当前歌曲生效）
          const d = tune.bpm > 0 ? 60 / tune.bpm : beats[1] - beats[0];
          const start = tune.offset > 0 ? tune.offset : beats[0];
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
  // 注意：session / master / noise 都挂在 AudioEngine 上（不是 ctx 上）
  const e = AudioEngine, c = e.ctx;
  if (!c || !e.session) return;
  const t = c.currentTime;
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(120, t);
  o.frequency.exponentialRampToValueAtTime(30, t + 0.4);
  g.gain.setValueAtTime(0.8, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  o.connect(g).connect(e.session);
  o.start(t); o.stop(t + 0.55);
  const s = c.createBufferSource(), g2 = c.createGain(), f = c.createBiquadFilter();
  s.buffer = e.noise; f.type = 'lowpass'; f.frequency.value = 900;
  g2.gain.setValueAtTime(0.5, t);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  s.connect(f).connect(g2).connect(e.session);
  s.start(t); s.stop(t + 0.35);
}
function playMiss() { // 漏拍提示音（小声）
  const e = AudioEngine, c = e.ctx;
  if (!c || !e.session) return;
  const t = c.currentTime;
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'sine'; o.frequency.value = 110;
  g.gain.setValueAtTime(0.12, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  o.connect(g).connect(e.session);
  o.start(t); o.stop(t + 0.15);
}
function playShield() { // 开盾：短促上扬音
  const e = AudioEngine, c = e.ctx;
  if (!c || !e.session) return;
  const t = c.currentTime;
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(320, t);
  o.frequency.exponentialRampToValueAtTime(880, t + 0.14);
  g.gain.setValueAtTime(0.18, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  o.connect(g).connect(e.session);
  o.start(t); o.stop(t + 0.2);
}
function playSmash() { // 撞破蓝色巨障：低频冲击 + 带通噪声爆裂
  const e = AudioEngine, c = e.ctx;
  if (!c || !e.session) return;
  const t = c.currentTime;
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'square';
  o.frequency.setValueAtTime(220, t);
  o.frequency.exponentialRampToValueAtTime(90, t + 0.18);
  g.gain.setValueAtTime(0.3, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  o.connect(g).connect(e.session);
  o.start(t); o.stop(t + 0.25);
  const s = c.createBufferSource(), f = c.createBiquadFilter(), g2 = c.createGain();
  s.buffer = e.noise; f.type = 'bandpass'; f.frequency.value = 1800;
  g2.gain.setValueAtTime(0.28, t);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  s.connect(f).connect(g2).connect(e.session);
  s.start(t); s.stop(t + 0.2);
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
  songRowEls: {},           // 音乐选择弹窗的行 DOM 引用（id → { row, name, best }）
  songLoad: { id: null, state: '' }, // 本次歌曲加载：'' 空闲 | 'loading' 在途 | 'slow' 超时放行
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
  bonusIdx: 0,              // 下一个待触发的奖励时间序号（CONFIG.bonusAtSec 下标）
  bonusStart: -Infinity,    // 本次奖励时间开始时刻（-Infinity = 未激活）
  bonusUntil: -Infinity,    // 本次奖励时间结束时刻（必须 -Infinity：开局 leadIn 期间 songTime 为负）
  bonusOn: false,           // 上一帧是否处于奖励时间（用于「结束」播报）
  lastNoteArrival: -Infinity, // 上一个节拍点到达时刻（防止窗口开启瞬间双押）
  nextBlueAt: CONFIG.blueStartSec, // 下一根蓝色巨障的排布时刻（开局 30 秒前不排）
  shieldUntil: -Infinity,   // 护盾生效截止时刻（-Infinity = 无盾）
  shieldReadyAt: -Infinity, // 下次可以开盾的时刻（冷却）
  blueRetryFrom: -Infinity, // 本次排布尝试的起始时刻（blueRetryLimit 用）
  blueSeen: false,          // 本局是否已播报过蓝墙教学提示
};

/* ---------- DOM 与画布 ---------- */

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);
const hudEl = $('hud'), menuEl = $('menu'), gameoverEl = $('gameover');
const scoreEl = $('score'), comboEl = $('combo'), progressFill = $('progress-fill');
const bonusEl = $('bonus'), bonusCountEl = $('bonus-count');
const shieldStateEl = $('shield-state'), shieldBtnEl = $('shield-btn');
const finalScore = $('final-score'), finalBestSong = $('final-best-song');
const finalBestValue = $('final-best-value'), newRecord = $('new-record');
const howToModalEl = $('how-to-modal');
const songModalEl = $('song-modal'), songRowsEl = $('song-rows'), btnMusicEl = $('btn-music');

let W = 0, H = 0, squareSize = 40, playerX = 0, groundY = 0;

// 是否触屏设备（决定护盾提示文案；按钮显隐由 CSS 的 any-pointer 负责，见 style.css）
function touchUI() {
  return document.body.classList.contains('touch') ||
    (window.matchMedia && window.matchMedia('(any-pointer: coarse)').matches);
}

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

// —— 奖励时间（2026-09-20 新增）——
// 到 1/2/3 分钟各开启 15 秒「无障碍」窗口：窗口内到达的障碍一律不落地，
// 节拍点更密、星形更多、漏吃不断连击，让玩家专心吃分。
function bonusActive(t) { return t < S.bonusUntil; } // t = songTime()

// 窗口开启：清掉在飞的障碍 + 立刻开始出节拍点 + 金色开场信号。
// 触发判定放在 update() 最前面，保证本帧就清场（不出现「先碰撞、后清场」的一帧差）。
function startBonus(t) {
  S.bonusStart = t;
  S.bonusUntil = t + CONFIG.bonusDuration;
  // 场上障碍立即清空：此刻在飞的障碍到达时刻必然 < 窗口结束（飞行仅 1 秒），
  // 全部属于窗口内，删掉即与 spawnUpcoming 的抑制条件一致
  S.entities = S.entities.filter((e) => e.type !== 'obstacle');
  if (S.nextNoteAt > t) S.nextNoteAt = t; // 立刻开始生成节拍点，不空等最多 1.4 秒
  S.flash = 0.5; S.shake = 0.25;
  burst(playerX, groundY - squareSize, CONFIG.starColor, 26);
  addText('奖励时间！', playerX, groundY - squareSize * 3.4, CONFIG.starColor);
}

function updateBonus(t) {
  if (S.phase !== 'playing') { S.bonusOn = false; return; }
  // 时钟可能一次跳过多个触发点（长时间卡顿 / 后台恢复）：过期窗口不补，只给最近一个
  while (S.bonusIdx < CONFIG.bonusAtSec.length && t >= CONFIG.bonusAtSec[S.bonusIdx]) {
    const stale = t - CONFIG.bonusAtSec[S.bonusIdx];
    S.bonusIdx++;
    if (stale <= CONFIG.bonusDuration) startBonus(t);
  }
  const on = bonusActive(t);
  if (S.bonusOn && !on) {
    S.bonusOn = false;
    addText('奖励结束', playerX, groundY - squareSize * 3.4, CONFIG.starColor);
  } else if (on) S.bonusOn = true;
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
    // 奖励时间：到达时刻落在窗口内（末尾留 bonusClearMargin 余量）的障碍不落地。
    // 只抑制「落地」这一步：spawnIndex / lastPat / obstacleTimes 全部照常推进，
    // 两条链始终同步，窗口结束无需重对齐。被抑制的障碍会在 obstacleTimes 里留下
    // 「幽灵」项，由 spawnNote 的奖励时间分支跳过。
    // 按「到达时刻」而非「出生时刻」判断：出生在窗口内、到达在窗口后的障碍必须照常
    // 出生（窗口末尾的世界回归预告），否则 obstacleTimes 会留下幽灵记录压制节拍点。
    const suppressed = p.obstacle && arrival >= S.bonusStart &&
      arrival < S.bonusUntil + CONFIG.bonusClearMargin;
    if (p.obstacle && !suppressed) {
      S.entities.push({ type: 'obstacle', float: p.float, start: spawnT, dur: travelT });
    }
    S.spawnIndex++;
    if (S.spawnIndex > 100000) break; // 保险丝
  }
  // 障碍到达时间前瞻（供 spawnNote 避让、蓝色巨障错开；覆盖候选节拍点可能的全部冲突区间）。
  // 前瞻范围要比「节拍点需要的 travelTime + gap」更远一点：蓝色巨障的到达时刻提前
  // blueLead 登记，还要与它前后 blueClearGap 内的障碍错开——只扫到 t+1.65 的话，
  // 落在 (t+1.65, t+2.3] 的障碍查不到，蓝墙可能正好贴着一根红障碍到达。
  // 多登记的条目对节拍点避让没有影响（冲突判定只看到达窗口内那几条）。
  const gap = Math.max(CONFIG.noteGapBefore, CONFIG.noteGapAfter);
  const ahead = Math.max(gap, CONFIG.blueClearGap + CONFIG.blueLead);
  while (beatTime(S.lookaheadIndex) + CONFIG.noteOffset <= t + CONFIG.travelTime + ahead) {
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
// 奖励时间内（2026-09-20）：间隔换成更密的 bonusNoteSpawnMin~Max、星形概率提升，
// 避让铁律对「窗口之后的障碍」依然生效（只跳过窗口内的幽灵登记项）。
function spawnNote() {
  const t = songTime();
  const gap = Math.max(CONFIG.noteGapBefore, CONFIG.noteGapAfter);
  while (S.obstacleTimes.length && S.obstacleTimes[0] < t - gap) S.obstacleTimes.shift();
  if (t < S.nextNoteAt) return;
  const inBonus = bonusActive(t);
  const A = t + CONFIG.travelTime; // 候选到达时刻（立即从右缘出生）
  // 奖励时间内 obstacleTimes 里「窗口末尾 + 余量」之前的登记项是幽灵（对应障碍已被
  // 抑制），跳过；窗口之后的登记项照常避让——否则窗口最后一刻生成的节拍点会与
  // 「窗口后第一根障碍」撞车（踩点与起跳互斥，必死）。阈值与 spawnUpcoming 的抑制
  // 阈值取同一个数，保证「参与避让 ⇔ 障碍真实存在」。
  const clearBefore = inBonus ? S.bonusUntil + CONFIG.bonusClearMargin : -Infinity;
  for (const O of S.obstacleTimes) {
    if (O < clearBefore) continue; // 幽灵项：不参与避让
    if (O > A - CONFIG.noteGapBefore && O < A + CONFIG.noteGapAfter) {
      S.nextNoteAt = t + CONFIG.noteRetryDelay; // 与障碍冲突：稍后重试
      return;
    }
  }
  // 奖励时间内再挡一层：窗口开启瞬间把 nextNoteAt 钳到当前时刻，避免与刚生成的
  // 节拍点贴在一起（两个节拍点相差几十毫秒，画面上会叠在一起）
  if (inBonus && A < S.lastNoteArrival + CONFIG.bonusNoteSpawnMin) {
    S.nextNoteAt = t + CONFIG.noteRetryDelay;
    return;
  }
  const isStar = Math.random() < (inBonus ? CONFIG.bonusStarChance : CONFIG.starChance);
  S.entities.push({
    type: isStar ? 'star' : 'note',
    start: t, dur: CONFIG.travelTime, judged: false,
    beatT: A - CONFIG.noteOffset, // 视觉接触前 0.1 秒按键 = Perfect（与原手感一致）
  });
  S.lastNoteArrival = A;
  const lo = inBonus ? CONFIG.bonusNoteSpawnMin : CONFIG.noteSpawnMin;
  const hi = inBonus ? CONFIG.bonusNoteSpawnMax : CONFIG.noteSpawnMax;
  S.nextNoteAt = t + lo + Math.random() * (hi - lo);
}

// —— 蓝色巨障（2026-09-20 新增）——
// 开局 30 秒后随机出现（间隔 blueMinGap~blueMaxGap 秒），跳不过去，只能开盾撞破。
// 排布时不进节拍表（patternForBeat 是纯函数，不能掺时间条件），但到达时刻会提前
// blueLead 秒登记进 obstacleTimes —— 节拍点避让只在生成时查一次表，早于登记生成的
// 节拍点由 blueLead ≥ noteGapAfter(0.5) 保证落在避让窗口之外，不会出现「同一个位置
// 既要踩点又要撞盾」。落点还要与其它障碍错开 blueClearGap，并躲开奖励时间窗口。
function spawnBlueObstacle() {
  const t = songTime();
  if (S.phase !== 'playing' || t < S.nextBlueAt) return;
  const travelT = (W - playerX) / speedNow(); // === CONFIG.travelTime（恒定）
  const arrival = t + travelT + CONFIG.blueLead;
  // 奖励时间（含窗口末尾的清障余量与结束后的静默期）：窗口内必须一个障碍都没有
  if (arrival < S.bonusUntil + CONFIG.bluePostBonusGrace) {
    S.nextBlueAt = S.bonusUntil + CONFIG.bluePostBonusGrace;
    S.blueRetryFrom = -Infinity;
    return;
  }
  // 也别把蓝墙排进「即将到来的」奖励时间窗口：窗口开启时会把它连同其它障碍一起清掉
  // （所以绝不会撞到），但玩家会看到一个刚出现的蓝墙又凭空消失，还可能白按一次护盾。
  // 触发时刻是固定日程（CONFIG.bonusAtSec），可以直接提前避开。
  for (const at of CONFIG.bonusAtSec) {
    if (arrival >= at && arrival < at + CONFIG.bonusDuration + CONFIG.bluePostBonusGrace) {
      S.nextBlueAt = at + CONFIG.bonusDuration + CONFIG.bluePostBonusGrace;
      S.blueRetryFrom = -Infinity;
      return;
    }
  }
  for (const O of S.obstacleTimes) {
    if (Math.abs(O - arrival) < CONFIG.blueClearGap) { // 离其它障碍太近：稍后再试
      if (S.blueRetryFrom < 0) S.blueRetryFrom = t;
      if (t - S.blueRetryFrom > CONFIG.blueRetryLimit) {
        // 空档挤不进去（快歌极难段空档很窄）：放弃本次，重新排期
        S.blueRetryFrom = -Infinity;
        S.nextBlueAt = t + CONFIG.blueMinGap + Math.random() * (CONFIG.blueMaxGap - CONFIG.blueMinGap);
      } else S.nextBlueAt = t + CONFIG.blueRetryStep;
      return;
    }
  }
  S.blueRetryFrom = -Infinity;
  // 「减速飞行」而非「提前站在右缘」：render 会把 p 钳在 Math.max(0,…)，提前出生的
  // 话方块会在右缘静止 blueLead 秒，看起来像卡死。并进 dur 则匀速飞完、到达时刻不变。
  S.entities.push({ type: 'obstacle', blue: true, start: t, dur: travelT + CONFIG.blueLead });
  // obstacleTimes 不保证严格升序（下一帧前瞻仍可能压入更小的到达时刻），按序插入最稳
  let k = S.obstacleTimes.length;
  while (k > 0 && S.obstacleTimes[k - 1] > arrival) k--;
  S.obstacleTimes.splice(k, 0, arrival);
  S.nextBlueAt = t + CONFIG.blueMinGap + Math.random() * (CONFIG.blueMaxGap - CONFIG.blueMinGap);
  if (!S.blueSeen) { // 首次出现播报一次（之后不再刷）
    S.blueSeen = true;
    addText(touchUI() ? '蓝色巨障！点左下按钮开盾' : '蓝色巨障！按 K 开盾',
      playerX, groundY - squareSize * 4.2, CONFIG.blueObstacleColor);
  }
}

// 护盾（2026-09-20 新增）：随时可按，持续 shieldDuration 秒；
// 冷却从「按下」算起 shieldCooldown 秒（= 1.5 秒护盾 + 2.5 秒空窗），
// 不是「失效后再等 4 秒」——误按的代价被压到最小。
function activateShield() {
  if (S.phase !== 'playing') return;
  const t = songTime();
  if (t < S.shieldReadyAt) return; // 冷却中
  S.shieldUntil = t + CONFIG.shieldDuration;
  S.shieldReadyAt = t + CONFIG.shieldCooldown;
  S.flash = Math.max(S.flash, 0.18);
  burst(playerX, groundY - playerHeight() - squareSize / 2, CONFIG.shieldColor, 12);
  if (!S.entities.some((e) => e.blue)) { // 空放提醒（蓝墙在场时才是刚需）
    addText('护盾浪费了', playerX, groundY - squareSize * 3.4, '#8a8fb8');
  }
  playShield();
}

// 撞破蓝色巨障：固定加分（不吃连击倍率、也不动连击数——撞破不是节奏输入）、
// 蓝白粒子、消耗护盾（早消耗早回冷，用得早不吃亏）。
function smashBlue(t) {
  S.shieldUntil = t;
  S.shieldReadyAt = t + CONFIG.shieldCooldown;
  S.score += CONFIG.scoreBlueSmash;
  S.shake = Math.max(S.shake, 0.5);
  S.flash = Math.max(S.flash, 0.18); // 别用 1：白闪是「死亡」的既有语义
  burst(playerX, groundY - squareSize, CONFIG.blueObstacleColor, 26);
  burst(playerX, groundY - squareSize, '#ffffff', 10);
  addText('+' + CONFIG.scoreBlueSmash, playerX, groundY - squareSize * 2.2, CONFIG.blueObstacleColor);
  playSmash();
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
  // 奖励时间内漏吃节拍点不断连击（2026-09-20：奖励时间放心刷分，容错放宽）
  const inBonus = bonusActive(songTime());
  if (!inBonus) S.combo = 0;
  addText(inBonus ? 'Miss · 连击保留' : 'Miss',
    playerX, groundY - CONFIG.noteHeightFactor * squareSize - 34, '#666680');
  playMiss();
}

function die(hit) {
  if (S.phase !== 'playing') return;
  S.phase = 'dying';
  S.deathAt = songTime();
  S.flash = 1; S.shake = 1;
  // hit = 撞到的实体（可选）：撞蓝墙死时粒子用蓝，其余沿用红色警示
  burst(playerX, groundY - squareSize,
    (hit && hit.blue) ? CONFIG.blueObstacleColor : CONFIG.obstacleColor, 30);
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

  // 奖励时间：触发 / 清场 / 结束播报（必须早于 spawnUpcoming 与实体碰撞循环）
  updateBonus(t);

  // 当前鼓点推进（画面脉动用）
  while (beatTime(S.beatCursor + 1) <= t) S.beatCursor++;

  // 落地缓冲跳（>= 吸收落地瞬间的浮点边界误差）
  if (S.phase === 'playing' && S.jumpBufferUntil >= t && isGrounded()) {
    S.jumpStart = t; S.jumpBufferUntil = -1;
  }
  // 生成新元素（障碍按节拍表，节拍点随机，蓝色巨障独立随机排布）。
  // 蓝墙排在节拍点之前：本帧生成的节拍点就已经能让开它。
  if (S.phase === 'playing') { spawnUpcoming(); spawnBlueObstacle(); spawnNote(); }

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
      // 障碍碰撞：横向重叠时按形态判定（蓝墙更宽，阈值按各自宽度算）
      const bw = e.blue ? CONFIG.blueWidthFactor : CONFIG.obstacleWidthFactor;
      const halfW = (bw * squareSize + squareSize) / 2;
      if (Math.abs(x - playerX) < halfW) {
        if (e.blue) {
          // 蓝色巨障：高度 3.6×方块 > 跳跃顶点 3×，跳不过去——有盾撞破，没盾结束
          if (t < S.shieldUntil) {
            smashBlue(t);
            S.entities.splice(i, 1);
            continue; // 必须 continue：否则下面的 p>1.6 会对同一个 i 二次 splice，误删下一个实体
          }
          die(e);
          break;
        }
        if (e.float) {
          // 浮空障碍：贴地通过安全；方块顶部进入障碍下沿 → 游戏结束
          const boxBottom = CONFIG.noteHeightFactor * squareSize - CONFIG.obstacleHeightFactor * squareSize / 2;
          if (playerH + squareSize > boxBottom) { die(e); break; }
        } else if (playerH < CONFIG.obstacleHeightFactor * squareSize) {
          // 地面障碍：方块下沿低于障碍顶部 → 游戏结束
          die(e);
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
      // 蓝色巨障用自己的一套几何与配色（更宽更高的蓝柱），其余障碍沿用红色警示
      const blue = !!e.blue;
      const ow = (blue ? CONFIG.blueWidthFactor : CONFIG.obstacleWidthFactor) * squareSize;
      const oh = (blue ? CONFIG.blueHeightFactor : CONFIG.obstacleHeightFactor) * squareSize;
      const ocol = blue ? CONFIG.blueObstacleColor : CONFIG.obstacleColor;
      if (blue) {
        // 蓝色巨障：跳不过去的高墙，画成发光蓝柱 + 白色盾形内芯（提示「开盾撞破」）
        const ox = x - ow / 2, oy = groundY - oh;
        ctx.fillStyle = ocol;
        ctx.shadowColor = ocol; ctx.shadowBlur = 22;
        rr(ox, oy, ow, oh, 5); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(232,246,255,0.9)'; // 白色盾形/亮条：这不是「跳过去」的东西
        ctx.beginPath();
        ctx.moveTo(x, oy + oh * 0.12);
        ctx.lineTo(x + ow * 0.28, oy + oh * 0.24);
        ctx.lineTo(x + ow * 0.28, oy + oh * 0.52);
        ctx.quadraticCurveTo(x + ow * 0.28, oy + oh * 0.78, x, oy + oh * 0.9);
        ctx.quadraticCurveTo(x - ow * 0.28, oy + oh * 0.78, x - ow * 0.28, oy + oh * 0.52);
        ctx.lineTo(x - ow * 0.28, oy + oh * 0.24);
        ctx.closePath(); ctx.fill();
        // 顶部脉动光边：远处也能一眼认出
        ctx.strokeStyle = 'rgba(232,246,255,' + (0.45 + 0.35 * Math.sin(t * 6)).toFixed(3) + ')';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(ox - 5, oy); ctx.lineTo(ox + ow + 5, oy); ctx.stroke();
      } else if (e.float) {
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

  // 护盾光环（2026-09-20 新增）：有盾时方块外圈套一层脉动白青光环
  if (t < S.shieldUntil) {
    const cy = py + squareSize / 2;
    const r = squareSize * (0.92 + 0.06 * Math.sin(t * 9));
    const fade = Math.min(1, (S.shieldUntil - t) / 0.4); // 最后 0.4 秒淡出，提示护盾要没了
    ctx.globalAlpha = 0.35 + 0.5 * fade;
    ctx.strokeStyle = CONFIG.shieldColor;
    ctx.shadowColor = CONFIG.shieldColor; ctx.shadowBlur = 18;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(playerX, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.18 * fade; // 外圈光晕
    ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(playerX, cy, r * 1.12, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

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
// 玩法说明是否看过（首次进入自动弹窗用）。
// localStorage 不可用（隐私模式 / 某些 file:// 配置）时当作没看过——每次都弹一次，
// 功能不受影响，且 try/catch 保证异常绝不打断裂启动段。
function howToSeen() {
  try { return localStorage.getItem(CONFIG.howToKey) === '1'; } catch (e) { return false; }
}
function markHowToSeen() {
  try { localStorage.setItem(CONFIG.howToKey, '1'); } catch (e) {}
}

function updateHud() {
  const t = songTime();
  const s = String(S.score);
  if (scoreEl.textContent !== s) scoreEl.textContent = s;
  if (S.combo >= 2) {
    comboEl.textContent = S.combo + ' 连击 ×' + comboMult();
    comboEl.classList.remove('hidden');
  } else {
    comboEl.classList.add('hidden');
  }
  const pct = Math.max(0, Math.min(1, t / roundLength()));
  progressFill.style.width = (pct * 100).toFixed(1) + '%';

  // 奖励时间横幅：只在游戏中且窗口未结束时显示；最后 3 秒转红闪烁预警
  const inBonus = S.phase === 'playing' && bonusActive(t);
  bonusEl.classList.toggle('hidden', !inBonus);
  if (inBonus) {
    const left = S.bonusUntil - t;
    const n = String(Math.ceil(left));
    if (bonusCountEl.textContent !== n) bonusCountEl.textContent = n;
    bonusEl.classList.toggle('warning', left <= 3);
  }

  // —— 护盾指示（2026-09-20 新增）——
  // 三态：生效（金色倒计时）/ 冷却（灰色倒计时）/ 就绪；蓝墙在场且就绪时闪烁提醒开盾。
  // 只在游戏中刷新（updateHud 在所有相位都会跑），文本相同就不写，避免逐帧重排。
  const playing = S.phase === 'playing';
  const shieldLeft = playing ? S.shieldUntil - t : -1;
  const readyLeft = playing ? S.shieldReadyAt - t : -1;
  let stText, stCls;
  if (shieldLeft > 0) { stText = '护盾 ' + shieldLeft.toFixed(1) + ' 秒'; stCls = 'on'; }
  else if (readyLeft > 0) { stText = '护盾冷却 ' + readyLeft.toFixed(1) + ' 秒'; stCls = 'cool'; }
  else { stText = touchUI() ? '护盾就绪 · 点左下按钮' : '护盾就绪 · 按 K'; stCls = 'ready'; }
  if (playing) {
    const blueNear = S.entities.some((e) => e.blue);
    if (blueNear && stCls === 'ready') { stText = '按 K 开盾！撞破蓝色巨障'; stCls = 'alert'; }
    if (shieldStateEl.textContent !== stText) shieldStateEl.textContent = stText;
    shieldStateEl.className = 'show ' + stCls;
  } else if (shieldStateEl.className !== '') {
    shieldStateEl.className = ''; // 非游戏相位：收起指示（#hud 本身也是隐藏的）
  }
  const btnCool = readyLeft > 0 && shieldLeft <= 0;
  if (shieldBtnEl.classList.contains('cool') !== btnCool) shieldBtnEl.classList.toggle('cool', btnCool);
}

// —— 背景音乐切换（2026-09-03 新增，2026-09-21 改弹窗）——
// 选择曲目：记录选择 → 收起弹窗 → 开始界面按钮显示曲名 → 未缓存则异步解码分析
// （期间禁用开始按钮，避免「选了歌却响合成音乐」）。加载失败自动回退 No.9，再失败则程序合成降级。
function selectSong(id) {
  if (!SONGS.some((s) => s.id === id)) return;
  closeSongModal(); // 不变量：选中即收起（幂等，弹窗没开时也无害）
  AudioEngine.songId = id;
  saveSongId(id);
  const cached = AudioEngine.songCache.get(id);
  if (cached) {
    if (S.phase === 'playing') AudioEngine.pendingSong = { id, song: cached };
    else AudioEngine.song = cached;
    S.songLoad = { id, state: '' }; // 命中缓存：立刻可用，提示也该跟着消失
    setStartEnabled(true);
    refreshSongUI();
    return;
  }
  setStartEnabled(false);
  loadSongGuarded(id); // 先发起加载（同步建立 loadPromises），再刷新按钮的 loading 态
  refreshSongUI();
}

// —— 歌曲加载的兜底放行（2026-09-20）——
// 解码分析期间禁用「开始游戏」是为了避免「选了歌却响合成音乐」；但歌曲数据走 CDN，
// 慢或不通时不能把菜单无限期卡死（实测慢链路下 14MB 要几分钟）。所以加超时兜底：
// 超时（或加载失败）就放行——先用程序合成音乐开打，并在开始界面标明原因；
// 数据到位后由 __songDataReady 自动重新加载，装上真正的歌曲。
function setSongHint(text) {
  const el = $('song-hint');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

function loadSongGuarded(id) {
  S.songLoad = { id, state: 'loading' };
  const loaded = AudioEngine.loadSong(id);
  const guard = new Promise((r) => setTimeout(() => r('timeout'), CONFIG.songLoadTimeout * 1000));
  const settle = (state) => {
    // 只在「这次加载仍是当前这次」时改状态：期间玩家又换了曲目就交给后来者，
    // 否则晚到的超时会把新选的歌的状态覆盖掉
    if (S.songLoad.id === id) S.songLoad = { id, state };
    if (AudioEngine.songId === id) setStartEnabled(true);
    refreshSongUI();
  };
  // 第二个参数不能省：loaded 万一 reject，没有它这里就是未捕获拒绝，
  // 「开始游戏」会永远停在灰态
  Promise.race([loaded, guard]).then((res) => settle(res === true ? '' : 'slow'), () => settle('slow'));
  // 超时之后才加载完成——按需加载后这是常态（数据脚本 3MB 走慢链路要几十秒）：
  // race 那时已经落了 'slow'，这里必须补一次状态，否则「加载中」的黄字会一直挂在
  // 开始界面（歌其实已经装好了，下一局就会响）
  loaded.then((res) => { if (res === true && S.songLoad.id === id && S.songLoad.state !== '') settle(''); }, () => {});
  return loaded;
}

// 提示文案由加载状态派生（而不是各调用点各写一遍）：切回已缓存的歌时提示会自动消失，
// 不会像以前那样把上一条「加载中」黄字一直挂在开始界面
function hintText() {
  const L = S.songLoad;
  if (!L.id || L.id !== AudioEngine.songId) return '';
  if (L.state === 'loading') return '正在加载《' + songName(L.id) + '》…';
  if (L.state === 'slow') return '歌曲加载中…（可先玩，背景先用合成音乐）'; // 超时/失败时的原文案
  return '';
}

// —— 音乐选择弹窗的歌曲行（2026-09-21：原「三曲按钮 + 各曲最高分榜单」合并成一套）——
// 行由 SONGS 生成（以后加歌自动扩展），启动时 build 一次，之后只刷新文案与状态——
// 刷新绝不可重建行（会丢掉焦点与已绑的监听）。行是 <button>：可聚焦、Enter/空格激活、
// 自带 ≥44px 触控高度；点击在生成处逐行绑定（行只建一次，不必用事件委托）。
function buildSongRows() {
  if (!songRowsEl) return; // DOM 缺失时的兜底：宁可没有行也别打断启动段
  songRowsEl.innerHTML = '';
  S.songRowEls = {};
  for (const s of SONGS) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'song-row';
    row.setAttribute('data-song', s.id);
    const name = document.createElement('span');
    name.className = 'song-row-name';
    name.textContent = s.name;
    const tag = document.createElement('span');
    tag.className = 'song-row-tag';
    tag.textContent = '使用中';
    const best = document.createElement('span');
    best.className = 'song-row-best';
    const meta = document.createElement('span'); // 第二行：胶囊 + 最高分
    meta.className = 'song-row-meta';
    meta.appendChild(tag); meta.appendChild(best);
    row.appendChild(name); row.appendChild(meta);
    row.addEventListener('click', () => pickSong(s.id));
    songRowsEl.appendChild(row);
    S.songRowEls[s.id] = { row, name, best };
  }
  refreshSongUI();
}

// 行上的四件事一次刷完（正在使用 / 待确认选中 / 加载态 / 最高分都在同一行上，分开刷必然漏一处）
function refreshSongRows() {
  const cur = AudioEngine.songId;
  const loading = !!AudioEngine.loadPromises[cur]; // 只有当前曲目才可能「在加载」
  for (const s of SONGS) {
    const ref = S.songRowEls[s.id];
    if (!ref) continue;
    const current = s.id === cur;
    ref.row.classList.toggle('current', current);
    // 待确认标记只在弹窗开着时渲染：关掉之后它没有任何含义，
    // 留着会在「确定后 → 再打开」之间显示成与当前曲目矛盾的高亮
    ref.row.classList.toggle('picked', isSongModalOpen() && s.id === musicPickId);
    ref.row.classList.toggle('loading', current && loading);
    ref.row.setAttribute('aria-current', current ? 'true' : 'false');
    ref.name.textContent = current && loading ? s.name + '…' : s.name;
    const b = bestFor(s.id);
    ref.best.textContent = b > 0 ? '最高 ' + b : '暂无记录';
  }
}

// 开始界面那个按钮：曲名 + 加载中省略号（与行同一份数据，必须同一处刷新）
function refreshSongButton() {
  if (!btnMusicEl) return;
  const loading = !!AudioEngine.loadPromises[AudioEngine.songId];
  btnMusicEl.textContent = '音乐选择 · ' + songName(AudioEngine.songId) + (loading ? '…' : '');
  btnMusicEl.classList.toggle('loading', loading);
}

// 唯一的刷新入口（选曲 / 加载完成 / 打开弹窗 / 回到菜单 / 启动都走它）。
// 注意「开始游戏」按钮的 disabled 不在这里派生——它编码的是「玩家已经等够了」，
// 与「是否仍在加载」不是一回事（超时放行时两者恰好相反，混进来会把按钮永远锁死），
// 只能由 selectSong / loadSongGuarded 显式设置。
function refreshSongUI() {
  refreshSongRows();
  refreshSongButton();
  setSongHint(hintText());
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
  S.bonusIdx = 0; S.bonusStart = -Infinity; S.bonusUntil = -Infinity;
  S.bonusOn = false; S.lastNoteArrival = -Infinity;
  S.nextBlueAt = CONFIG.blueStartSec; S.blueRetryFrom = -Infinity; S.blueSeen = false;
  S.shieldUntil = -Infinity; S.shieldReadyAt = -Infinity;
  bonusEl.classList.add('hidden'); bonusEl.classList.remove('warning');
  shieldStateEl.className = ''; shieldBtnEl.classList.remove('cool');
  menuEl.classList.add('hidden');
  gameoverEl.classList.add('hidden');
  closeModals(); // 不变量：一开局弹窗必定收起（杜绝「弹窗盖在游戏画面上」这一整类问题）
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
  refreshSongUI(); // 结算页可能刚刷新过纪录，回菜单同步一次榜单数值
}

/* —— 弹窗（2026-09-21：玩法说明 / 音乐选择两个弹窗共用一套开关）——
   同一个时刻最多一个弹窗，因此焦点变量可以共用一组。
   弹窗打开期间 window 的 keydown 一律不喂给游戏（见下方 keydown 守卫）：
   Enter 既是「开始游戏」的快捷键、又是聚焦按钮的默认激活键，
   不拦住就会在玩家读弹窗的时候把游戏直接开起来。 */
let modalReturnFocus = null;  // 打开弹窗的元素，关闭后把焦点还回去
let downOnOverlay = null;     // 按下时落在哪个遮罩上（防「卡片里按下、遮罩上松手」误关）

function anyModalOpen() { return isHowToOpen() || isSongModalOpen(); }
function closeModals() { closeHowTo(); closeSongModal(); } // 两个都幂等

function showModal(el, focusTarget) {
  modalReturnFocus = document.activeElement || null; // 桩里可能没有 activeElement → 兜底 null
  el.classList.remove('hidden');
  // 焦点必须进弹窗：留在背后的「开始游戏」上时，Enter 会顺着按钮的默认行为把游戏开起来
  // （focus 的存在性判断是给无头测试的 DOM 桩留的）
  if (focusTarget && focusTarget.focus) focusTarget.focus();
}
function hideModal(el) {
  el.classList.add('hidden');
  downOnOverlay = null;
  const el0 = modalReturnFocus;
  modalReturnFocus = null;
  // 只在开始界面归还（开局时 #menu 已隐藏，还给隐藏元素没有意义）；
  // 自动弹出那次 activeElement 是 body → 不还，免得焦点落到「开始游戏」上
  // （Enter 会同时触发按钮 click 与全局快捷键，白开一局）
  if (S.phase === 'menu' && el0 && el0.focus && el0 !== document.body) el0.focus();
}
// 点遮罩关闭须「按下时也在遮罩上」——否则手指从卡片划到遮罩上松手，
// click 的 target 是公共祖先（= 遮罩），会把弹窗误关
function bindOverlayClose(el, closeFn) {
  el.addEventListener('pointerdown', (e) => { downOnOverlay = e.target === el ? el : null; });
  el.addEventListener('click', (e) => {
    if (downOnOverlay === el && e.target === el) closeFn();
    downOnOverlay = null;
  });
}

/* —— 玩法说明弹窗 ——
   首次进入自动弹出（打开即记进 localStorage，之后不再自动弹）；
   开始界面「玩法说明」按钮随时可再打开。 */
function isHowToOpen() { return !howToModalEl.classList.contains('hidden'); }
function openHowTo() {
  if (S.phase !== 'menu') return; // 只在开始界面可开：弹窗绝不盖在游戏画面上
  if (isHowToOpen()) return;
  closeSongModal();               // 互斥：同一时刻最多一个弹窗
  showModal(howToModalEl, $('howto-ok'));
  markHowToSeen();                // 「看到即算看过」：连点刷新也不会再弹
}
function closeHowTo() {
  if (!isHowToOpen()) return;
  hideModal(howToModalEl);
}

/* —— 音乐选择弹窗（2026-09-21）——
   开始界面不再平铺三首歌，改成一个「音乐选择 · 当前曲名」按钮 + 本弹窗；
   每行显示歌名 + 该曲最高分 + 「使用中」，点一行只是选中高亮，
   按「确定」才生效并关闭（✕ / 点遮罩 / Esc = 取消，不改动当前曲目）。 */
let musicPickId = ''; // 弹窗里待确认的曲目，只有「确定」才写进 AudioEngine.songId

function isSongModalOpen() { return !songModalEl.classList.contains('hidden'); }
function openSongModal() {
  if (S.phase !== 'menu') return;
  if (isSongModalOpen()) return;
  closeHowTo();                 // 互斥
  musicPickId = AudioEngine.songId; // 每次打开都从当前曲目起算
  showModal(songModalEl, $('music-ok'));
  refreshSongUI();              // 打开瞬间同步：最高分可能在结算后变了（须在 showModal 之后，
                                // 否则 .picked 的渲染判定还看不到「弹窗已打开」）
}
// 取消路径（✕ / 遮罩 / Esc / 开局）：关闭即丢弃待确认项（靠下次打开时重新起算，见下）。
// 这里刻意不重置 musicPickId——关闭那一刻 AudioEngine.songId 还可能没更新
// （「确定」是后面才调 selectSong 的），重置反而会留下一个和新曲目矛盾的待确认项；
// 待确认项只在弹窗开着时有意义（渲染时按 isSongModalOpen() 判定），
// 每次 openSongModal 都会重新从当前曲目起算，所以不需要在关闭时清。
function closeSongModal() {
  if (!isSongModalOpen()) return;
  hideModal(songModalEl);
  refreshSongRows(); // .picked 只在弹窗开着时渲染，关掉后要立刻抹掉（Esc / 点遮罩都会走到这里）
}
function pickSong(id) {
  if (!SONGS.some((s) => s.id === id)) return;
  musicPickId = id;
  refreshSongRows();
}
function confirmMusicPick() {
  const id = musicPickId;       // 先取出：closeSongModal 会把它重置掉
  closeSongModal();
  if (id && id !== AudioEngine.songId) selectSong(id); // 没换曲目就别重复触发加载
}

// 焦点循环：Tab / Shift+Tab 在弹窗内的可聚焦元素之间转圈。
// 绝不能放焦点跑出去——落到背后的「开始游戏」上，Enter 就在弹窗开着时开局了。
function modalFocusRing() {
  if (isSongModalOpen()) {
    const rows = SONGS.map((s) => S.songRowEls[s.id]).filter(Boolean).map((r) => r.row);
    return rows.concat([$('music-ok'), $('song-close')]);
  }
  if (isHowToOpen()) return [$('howto-ok'), $('howto-close')];
  return [];
}
function cycleModalFocus(delta) {
  const ring = modalFocusRing().filter((el) => el && el.focus);
  if (!ring.length) return;
  let i = ring.indexOf(document.activeElement);
  if (i < 0) i = delta > 0 ? -1 : 0;
  ring[(i + delta + ring.length) % ring.length].focus();
}
// ↑↓ 只在歌曲行之间移动焦点（不改变选中）；Enter/空格才是「选它」
function moveSongFocus(delta) {
  const rows = SONGS.map((s) => S.songRowEls[s.id]).filter(Boolean).map((r) => r.row);
  if (!rows.length) return;
  let i = rows.indexOf(document.activeElement);
  if (i < 0) i = SONGS.findIndex((s) => s.id === musicPickId);
  if (i < 0) i = 0;
  const next = rows[(i + delta + rows.length) % rows.length];
  if (next && next.focus) next.focus();
}
// 焦点在歌曲行上按 Enter：选中它并把焦点交给「确定」，键盘用户两次 Enter 走完「选中 → 确定」
function stageFocusedSong() {
  for (const s of SONGS) {
    const ref = S.songRowEls[s.id];
    if (ref && ref.row === document.activeElement) {
      pickSong(s.id);
      const ok = $('music-ok');
      if (ok && ok.focus) ok.focus();
      return true;
    }
  }
  return false;
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
  // 弹窗打开时所有按键都不喂给游戏：Esc 关闭、Tab 在弹窗内循环焦点（绝不放它跑出去，
  // 跑到背后的「开始游戏」上 Enter 就开局了）、↑↓ 在歌曲行间移动焦点，
  // 其余（Enter / 空格）交给聚焦的弹窗按钮——默认行为正是「选它 / 关掉 / 确定」
  if (anyModalOpen()) {
    if (e.code === 'Escape') { e.preventDefault(); closeModals(); }
    else if (e.code === 'Tab') { e.preventDefault(); cycleModalFocus(e.shiftKey ? -1 : 1); }
    else if (isSongModalOpen() && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
      e.preventDefault();
      moveSongFocus(e.code === 'ArrowDown' ? 1 : -1);
    } else if (e.code === 'Enter' && stageFocusedSong()) {
      // 焦点在歌曲行上按 Enter：选中它并把焦点交给「确定」，键盘两次 Enter 走完「选中 → 确定」。
      // 必须 preventDefault 掉原生激活——焦点已经在上面那行里移走了，
      // 不拦的话原生 click 会落到「确定」上，一按 Enter 就直接确认（没有反悔余地）。
      // 空格不在此列：空格是 keyup 激活，原生 click 落在行上（= 只选中、不动焦点），正合适
      e.preventDefault();
    }
    return;
  }
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
    e.preventDefault();
    pressJump();
  } else if (e.code === 'KeyK') {
    e.preventDefault();
    activateShield(); // 护盾：电脑端 K 键（CLAUDE.md 第三章）
  } else if (e.code === 'Enter') {
    if (S.phase === 'over') restartGame();
    else if (S.phase === 'menu') startFromButton();
  }
});

// 护盾按钮（手机）：只绑 pointerdown + preventDefault（不产生 click、不获取焦点，
// 因此空格/回车不会被它二次触发）；按钮在 #hud 内、不是 canvas 子节点，
// 所以点它不会连带触发跳跃。
shieldBtnEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  activateShield();
});
// 触屏判定：any-pointer: coarse 已覆盖绝大多数情况，这里再用「真实触摸事件」兜底，
// 保证触屏设备上按钮一定会出现（按钮不出现 = 手机玩家没有开盾手段）。
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') document.body.classList.add('touch');
}, { once: true });

$('btn-start').addEventListener('click', startFromButton);
$('btn-restart').addEventListener('click', restartGame);
$('btn-home').addEventListener('click', toMenu);
// 玩法说明弹窗：按钮打开，关闭走「知道了」/ ✕ / 点遮罩（Esc 在 keydown 里）
$('btn-how-to').addEventListener('click', openHowTo);
$('howto-ok').addEventListener('click', closeHowTo);
$('howto-close').addEventListener('click', closeHowTo);
bindOverlayClose(howToModalEl, closeHowTo);
// 音乐选择弹窗：按钮打开，关闭走「确定」（见 confirmMusicPick）/ ✕ / 点遮罩 / Esc
$('btn-music').addEventListener('click', openSongModal);
$('music-ok').addEventListener('click', confirmMusicPick);
$('song-close').addEventListener('click', closeSongModal);
bindOverlayClose(songModalEl, closeSongModal);

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
// 过渡兼容钩子：GitHub Pages 对 HTML 与 JS 都给 max-age=600，部署后约十分钟内可能出现
// 「新 game.js + 旧 index.html」的错配——旧加载器在每个歌曲脚本 onload 时会调这个函数。
// 新页面（按需加载）不再调用它，留着只是让那十分钟里数据到位后仍能接管。
window.__songDataReady = function () {
  if (AudioEngine.songCache.has(AudioEngine.songId)) return; // 已经装好了
  loadSongGuarded(AudioEngine.songId);
};
setStartEnabled(false);
loadSongGuarded(AudioEngine.songId); // 只加载当前选中这一首的数据脚本
// 每首歌的最高分记录 + 旧全局最高分一次性迁移到《No.9》
for (const s of SONGS) S.bests[s.id] = loadBest(s.id);
try {
  const legacy = Number(localStorage.getItem(CONFIG.bestKey)) || 0;
  if (legacy > 0) {
    if (legacy > S.bests.no9) { S.bests.no9 = legacy; saveBest('no9', legacy); }
    localStorage.removeItem(CONFIG.bestKey);
  }
} catch (e) {}
buildSongRows(); // 建行 + 首次刷新（最高分已在上面的循环里读进 S.bests）
resize();
// 首次进入自动弹玩法说明（打开即记住，之后只从开始界面的「玩法说明」按钮打开）
if (!howToSeen()) openHowTo();

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
