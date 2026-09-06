# 音乐跳动 🎵

霓虹暗黑风的网页节奏游戏：跟着音乐跳跃的小方块——踩中节拍得分，躲开障碍求生。
纯 HTML + CSS + JavaScript，无需安装任何东西，浏览器打开即玩。详细设计见 [CLAUDE.md](CLAUDE.md)。

## 怎么玩（发给好友看这里）

### 在线玩（推荐，手机电脑都行）

点这个链接 → <https://exoplanetKLM.github.io/music-beats/>

- 首次加载约 14MB（内置三首歌，128kbps），**建议用 Wi-Fi**：菜单秒出，稍等几秒即可点「开始游戏」
- 微信里打不开就点右上角「…」→「在浏览器打开」
- iPhone 可以把链接「添加到主屏幕」，之后全屏启动体验最好

### 单文件版（离线备份）

- **安卓手机**：微信/QQ 收到的 `音乐跳动-单文件.html`，用文件管理器打开并选择浏览器即可玩（飞行模式也能玩，音频已内嵌）
- **电脑**：双击就能玩
- **iPhone**：无法直接打开本地 HTML 文件，请用上面的链接玩

玩法：电脑点鼠标 / 按空格跳跃，手机点屏幕跳跃——踩中节拍得分（金色星形翻倍），躲开障碍，碰到障碍游戏结束。开始界面可切换三首歌（No.9 / Sugar Free / Sexy Love），每首歌最高分独立保存。

## 构建（开发者看这里）

单文件打包（零依赖，仅需 Node.js）：

```bash
node build-single.js                          # 生成 dist/音乐跳动-单文件.html
node build-single.js dist/music-beats.html    # 对方反馈文件名乱码时用 ASCII 名
```

换歌 / 重新生成歌曲数据（需原始 MP3）：

```bash
node embed-songs.js <MP3路径> <输出js路径> <全局变量名> <歌曲名>
```

## 在线部署（GitHub Pages，一次性设置）

> 注：Gitee Pages 已停服，本仓库托管在 GitHub Pages。GitHub Pages 免费、链接永久有效、push 后自动更新。

1. GitHub 上建一个公开仓库（如 `music-beats`），把本仓库推上去：`git remote add github <仓库地址>` → `git push github master`
2. 仓库 Settings → Pages → Source 选「Deploy from a branch」→ 分支选 master、目录选 / (root) → Save
3. 稍等 1~2 分钟，访问 `https://<用户名>.github.io/<仓库名>/` 即部署完成

每次改完代码 `git push github master`，页面自动更新（无需手动操作）。

## 项目结构

| 文件 | 说明 |
|------|------|
| index.html | 入口页（三界面 + 移动端 meta） |
| style.css | 霓虹暗黑风样式 |
| game.js | 游戏全部逻辑（物理 / 节拍 / 计分 / 音频引擎） |
| song-data*.js | 内嵌歌曲 base64 数据（128kbps 重压版，**勿手改**；原始 320kbps 备份在本地 .audio-backup，未入库） |
| build-single.js | 单文件打包脚本 |
| embed-songs.js | 歌曲数据生成脚本 |
| CLAUDE.md | 产品设计文档 |
| dist/ | 打包产物（不进 git，按需生成） |

## 常见问题

- **打开很慢 / 开始按钮点不了**：14MB 资源还在加载，切 Wi-Fi 或稍等
- **链接 404 / 打不开**：确认仓库 Settings → Pages 已开启且分支/目录选对；改代码后 push 会自动更新，个别网络（移动数据）下 github.io 可能较慢，换 Wi-Fi 重试
- **好友说文件名乱码**：用 `node build-single.js dist/music-beats.html` 重新生成 ASCII 文件名版再发
- **最高分没了**：分数存在各设备浏览器本地（localStorage），换设备或清浏览器缓存会丢失
