# 3D to 2D Pixel

**Turn 3D models (.glb) into true-color pixel-art sprites with 8 directions — in your browser or offline with Blender.**

拖一个 `.glb` 进去，得到 8 方向像素精灵 + 游戏图集 + 旋转 GIF。真彩色、无减色、无抖动，纯前端零上传，模型不出本机。

![7 个角色 × 8 方向的像素精灵成品](docs/samples/cast90-all.png)

## 两种用法

| | Web UI（推荐） | Blender 离线管线 |
| --- | --- | --- |
| 入口 | 双击 `start-webui.bat`，或 `python -m http.server 8765` 后打开 `/webui/` | `python tools/build_cast_px.py --glb-dir assets/characters` |
| 依赖 | 只要浏览器（three.js 已内置于 `webui/vendor/`） | Blender 4.x + `pip install -r requirements-dev.txt` |
| 适合 | 单个模型、即时预览调参 | 批量出整套精灵、可脚本化 |

Web UI 界面（左侧模型与调参，右侧 8 方向输出与 GIF 预览，单屏无滚动）：

![Web UI 界面](docs/samples/webui-result.png)

## 它在做什么

核心配方（浏览器与 Blender 两端完全一致）：

1. **高分无抗锯齿渲染**。正交相机按 8 个朝向渲染到 `目标尺寸 × 超采样倍率` 的画布（默认 90×16=1440）。关抗锯齿是关键：每个子像素都是模型真实的着色结果，不会和透明背景混出半透明边。
2. **分块颜色投票**。每个目标块里所有不透明子像素按颜色分 8 桶投票，块保留票数最多那一组的平均色。块色永远来自模型上真实存在的颜色——**不做全局减色，不做抖动**。
3. **1px 墨线**。只在剪影外侧的透明像素上画，不压本体。

为什么必须投票而不是直接缩小：一块只采一条光线时，比块还细的特征（眼睛高光、帽绳）要么消失、要么炸成孤立杂点，肉眼读作"脏"。渲染大再投票，杂点输掉选举而不是被平均成灰。

> ⚠️ 不要走"调色板量化 / 色阶合并"的路：会把皮肤和衣料弄出脏斑，观感是"16 色图"。像素风格 ≠ 减色，**网格化（几何）与调色板（色彩）是两件事**。

## 参数

| 参数 | 说明 |
| --- | --- |
| 网格尺寸 | 72 / 80 / 90 / 96 / 112。**90 是调好的平衡点**：块一眼可见，五官还在；72 时眼睛开始塌，112 丢块感。 |
| 超采样倍率 | 每块采多少子像素。16× 时每块 256 份采样，2 秒左右出 8 帧。 |
| 头部放大 | 缩放 `Head` 骨骼，Q 版大头。默认 1.8。 |
| 阴影亮度 | 三档硬光里最暗档的亮度（默认 0.52）。 |
| 外轮廓 | 剪影外侧 1px 墨线，颜色可换。 |

手臂会自动从 T-pose 下垂到 76°，否则取景会被张开的双臂撑宽，角色在画面里小三分之一。

## 输出

- 8 张 `S/SW/W/NW/N/NE/E/SE.png`（`cell_w = cell_h = 网格尺寸`）
- `sheet.png`（1×8）、`atlas_4x2.png`（4×2 游戏图集）
- `spin.gif`：8 方向循环旋转（4× 最近邻放大、150 ms/帧）
- `sprite.json` 元数据 + 打包 ZIP 下载

## 仓库结构

```text
webui/               浏览器工具：渲染、投票降采样、图集与 GIF 导出（纯前端，离线可用）
tools/               Blender 离线管线与启动脚本编译器
  render_toon.py       三档硬光卡通着色 + 正交相机 8 朝向渲染
  px_ssaa.py           分块颜色投票降采样 + 外轮廓墨线
  px_outline.py        独立的 1px 外轮廓工具
  build_cast_px.py     一条命令：GLB 目录 → 全套精灵
  build_bat.py         把 start-webui.bat.utf8 编译成 GBK + CRLF 的 .bat
start-webui.bat      Windows 一键启动 Web UI
docs/samples/        示例输出图
.github/workflows/   GitHub Pages 部署（只发布 webui/）
```

## 快速开始

**Web UI**：Windows 双击 `start-webui.bat`（自动找 Python、自动避让端口、开浏览器）；其他系统：

```bash
python -m http.server 8765
# 打开 http://127.0.0.1:8765/webui/
```

`file://` 下 ES module 无法加载，必须起一个静态服务。

**Blender 离线管线**：

```bash
python -m pip install -r requirements-dev.txt
python tools/build_cast_px.py --glb-dir assets/characters   # 把 .glb 放进该目录
python tools/build_cast_px.py --size 90 --skip-render       # 复用已有高分帧，秒级
python tools/build_cast_px.py --size 80 --only orc          # 单个模型、换档位
```

Blender 从 `$BLENDER`、`PATH`、常见安装路径依次查找。目标尺寸必须整除超采样分辨率（1440 可出 72/80/90/96/120/144）。

## 部署到 GitHub Pages

工具没有后端，纯静态托管就够：推 `main`/`dev` 后仓库 Settings → Pages → Source 选 **"GitHub Actions"**，`.github/workflows/pages.yml` 会自动发布 `webui/` 目录。仓库需 public；私有仓库用 Cloudflare Pages / Netlify / Vercel，根目录设成 `webui` 即可。托管体积约 1.5 MB，无外链 CDN。

## 发版（推 tag 即发布）

```bash
git tag v0.0.1 && git push origin v0.0.1
```

- tag 必须严格是 `v主.次.修订`（`v1.0.0`）。其他写法（`v1`、`v1.0`、`1.0.0`、`v1.0.0-beta`）会在校验步失败，不会发版；误推可用 `git push origin :refs/tags/<tag>` 删除
- 触发 `.github/workflows/release.yml`：自动创建 GitHub Release，附带 `webui-v<版本>.zip`（可自托管的完整静态站点），并用提交记录自动生成 Release Notes
- `0.x` 版本自动标记为预发布（测试版），升到 `1.0.0` 起转正式版

## 许可

代码以 [MIT](LICENSE) 发布。模型与生成素材的版权归各自作者所有。
