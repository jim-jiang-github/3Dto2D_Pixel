# 3D to 2D Pixel（Web UI）

**Turn 3D models (.glb) into true-color pixel-art sprites with 8 directions — rendered in your browser, no upload, no server.**

3D to 2D Pixel is a browser-based tool that converts 3D models into 2D pixel-art game sprites.
Drop in a `.glb` file, and it renders the model from 8 directions using an orthographic camera,
then pixelates the result with per-block color voting — a coarse pixel grid with true-color
shading: no palette quantization, no dithering. Each sprite gets a 1px black outline, and
everything exports as PNG frames, a 4×2 sprite sheet, `sprite.json` metadata, and a rotating
GIF. Runs entirely client-side: your models never leave your machine.

拖一个 `.glb` 进去，得到 8 方向像素精灵 + 游戏图集 + 旋转 GIF。纯前端，没有后端，没有上传，模型不出本机。

## 启动

Windows 直接双击仓库根目录的 **`start-webui.bat`**：自动找 Python、自动避开被占用的端口、起好服务并打开浏览器。

```bash
# 或者手动起一个静态服务（file:// 下 ES module 无法加载）
python -m http.server 8765
# 打开 http://127.0.0.1:8765/webui/
```

`start-webui.bat` 的参数：`start-webui.bat 9000` 指定端口，`start-webui.bat nobrowser` 不自动开浏览器。

three.js 已放在 `vendor/three/`，离线可用。

## 部署到 GitHub Pages

这个工具没有后端（模型在浏览器里读，不上传），所以**不需要服务端**，纯静态托管就够。
仓库里的 `.github/workflows/pages.yml` 只发布 `webui/` 目录，不带 `tools/` 和任何输出图：

1. 推一次 `main`（改到 `webui/**` 会自动触发，也可以在 Actions 里手动跑）
2. 仓库 Settings → Pages → **Source 选 "GitHub Actions"**
3. 上线地址 `https://<user>.github.io/<repo>/`

前提：仓库是 public（免费账号下的 Pages 只对公开仓库开放）。
如果仓库要私有，用 Cloudflare Pages / Netlify / Vercel 连过来，把根目录设成 `webui` 即可，配置更少。

托管体积只有 1.5 MB（three.js 本地副本占大头），没有任何外链 CDN。

## 它在做什么

和 `tools/build_cast_px.py` 是同一套配方，只是把 Blender 换成了浏览器里的 Three.js：

1. **高分无抗锯齿渲染**。正交相机按 8 个朝向渲染到 `目标尺寸 × 超采样倍率` 的离屏纹理（默认 90×16=1440）。
   关掉抗锯齿是关键：每个子像素都是模型真实的着色结果，不会和透明背景混出一圈半透明边。
2. **分块颜色投票**（`pixelate.js`）。每个目标块里所有不透明子像素按颜色分 8 桶投票，
   块保留票数最多那一组的平均色。块色永远来自模型上真实存在的颜色，不做全局减色，也不做抖动。
3. **1px 墨线**。只在剪影**外侧**的透明像素上画，不压本体。

为什么必须投票而不是缩小：一块只采一条光线时，比块还细的特征（眼睛高光、帽绳）要么消失、
要么炸成一两个孤立杂点，肉眼读作"脏"。渲染大再投票，杂点会输掉选举而不是被平均成灰。

## 参数

| 参数 | 说明 |
| --- | --- |
| 网格尺寸 | 72 / 80 / 90 / 96 / 112。越小块越粗。90 是调好的平衡点：块一眼可见，五官还在；72 时眼睛开始塌。 |
| 超采样倍率 | 每块采多少子像素。16× 时每块 256 份采样，2 秒左右出 8 帧。 |
| 头部放大 | 缩放 `Head` 骨骼，Q 版大头。默认 1.8，和已定稿的美术一致。 |
| 阴影亮度 | 三档硬光里最暗那一档的亮度（0.52）。调高画面更平，调低对比更强。 |
| 外轮廓 | 剪影外侧 1px 墨线，颜色可换。 |

手臂会自动从 T-pose 下垂到 76°（`poseArms()`）。不做这一步，取景会被张开的双臂撑宽，
角色在画面里小三分之一，和离线渲染对不上。

## 输出

- 8 张 `S/SW/W/NW/N/NE/E/SE.png`，`cell_w = cell_h = 网格尺寸`
- `sheet.png`：4×2 图集，顺序 `S SW W NW` / `N NE E SE`
- `spin.gif`：8 方向循环旋转，默认 4× 最近邻放大（90 → 360px）、150 ms/帧、无限循环
- `sprite.json`
- 打包成 zip 下载，或单张 / 单个 GIF 下载

GIF 是格式限制下的折中：每帧最多 256 色，所以每帧用中位切分单独生成局部色板，
**不做抖动**（抖动会把单像素撒开，正好毁掉像素网格）。实测平均色差 2.5/255，肉眼看不出；
PNG 帧和拼图不经过这一步，保持真彩色。要真彩色动图就用 APNG 或直接把 8 张 PNG 丢给引擎做序列帧。

## 精度

和 Blender 管线逐像素比对（法师、兽人两个模型，90px）：

- 剪影 IoU **0.93–0.97**
- 不透明区域平均色差 **< 1.5/255**（137.4,90.9,136.7 对 138.2,90.4,137.6）
- 外轮廓墨线像素数 272 对 291

剩余差异来自离线管线额外做了 decimate 0.12（简化网格）和上臂 58° 的独立旋转，
浏览器用全精度网格 + 76° 对齐，视觉上看不出分别。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.html` | 结构 |
| `style.css` | 样式 |
| `app.js` | 渲染、取景、UI、导出 |
| `pixelate.js` | 投票降采样、墨线、图集拼接 |
| `zip.js` | 无依赖 ZIP 写入（store 模式，PNG 本身已压缩） |
| `gif.js` | 无依赖 GIF89a 编码（中位切分 + LZW + 局部色板） |
| `vendor/three/` | three.js r169 本地副本 |

`window.__app` 暴露了 `state` / `frames` / `convert` / `ingest` / `renderGif` / `gifBytes`，方便自动化脚本驱动。
