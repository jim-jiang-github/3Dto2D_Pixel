# tools/

以下命令从仓库根目录执行。Python 图像工具依赖见根目录 `requirements-dev.txt`。

| 工具 | 用途 |
| --- | --- |
| `build_cast_px.py` | 一条命令从 GLB 生成像素精灵：高分无抗锯齿渲染 → 分块颜色投票降采样 → 1px 外轮廓 → sprite.json / sheet / 4×2 图集 / 2× / preview |
| `render_toon.py` | 单个 GLB 的卡通着色渲染（三档硬光 + 正交相机 + 固定光向），是上一条管线的第一步 |
| `px_ssaa.py` | 分块颜色投票降采样：每块保留主导色组的均值，不产生中间调、不做全局减色 |
| `px_outline.py` | 只给剪影外侧画 1px 墨线，不碰本体 |
| `build_bat.py` | 把 `start-webui.bat.utf8` 重新编译成 GBK + CRLF 的 `start-webui.bat`。改启动脚本必须走这条路，直接编辑 .bat 会被编辑器存成 UTF-8 而导致 cmd 解析错乱 |

## 精灵管线

```bash
python tools/build_cast_px.py --glb-dir assets/characters   # 目录下所有 .glb，约 55 秒/个
python tools/build_cast_px.py --size 90 --skip-render       # 复用已有高分帧，秒级
python tools/build_cast_px.py --size 80 --only orc          # --only 按名字子串过滤
```

- Blender 依次从 `$BLENDER`、`PATH`、常见安装路径查找。
- 输出在 `out/cast<size>/`：`{slug}/`（8 帧 + `sheet.png` + `atlas_4x2.png` + `sprite.json` + `preview_x4.png`）、`cast<size>_x2/{slug}/`（2× 最近邻）、`_hi<res>/{slug}/`（渲染中间帧，`--skip-render` 复用）。
- slug 取自文件名并去掉 `3d / model / character / figure / fantasy` 等噪声词，如 `wizard character 3d model.glb` → `wizard`。

目标尺寸必须整除超采样分辨率，否则每块采不到整数份子像素。1440 可出 72 / 80 / 90 / 96 / 120 / 144：

| 目标 | 每块子像素 | 角色块高 | 观感 |
| --- | --- | --- | --- |
| 72 | 20 | ~65 | 块最粗，眼睛开始塌 |
| 80 | 18 | ~72 | 粗，五官仍在 |
| **90** | **16** | **~81** | **默认定稿：块明显且五官清楚** |
| 96 | 15 | ~86 | 偏细 |
| 112 | 14 | ~100 | 丢掉块感，像缩小的高清图 |

**不要走过的路**：全局调色板量化 / 色阶合并（16~372 色）会把皮肤和衣料弄出脏斑（实测验证并否决过）；正确的做法是保持真彩色，只把网格变粗。

游戏引擎接入注意：显示时用**最近邻插值 + 整数倍缩放**，不要 LANCZOS/双线性重采样，也不要把颜色 snap 到固定色阶——这两步会在运行时把像素块糊掉并二次减色，毁掉渲染端保住的块面。
