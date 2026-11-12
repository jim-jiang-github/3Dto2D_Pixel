/**
 * 3D GLB -> 8-direction pixel sprite, entirely in the browser.
 *
 * The recipe mirrors the offline Blender pipeline (tools/render_toon.py +
 * tools/px_ssaa.py) so results line up with the approved art:
 *
 *   render big, no anti-aliasing  ->  every sub-pixel is a real shaded colour
 *   vote per target block         ->  block keeps its dominant colour, no muddy averaging
 *   1px ink ring outside          ->  silhouette reads on busy backgrounds
 *
 * Colour is never reduced: the block grid changes, the palette does not.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  voteDownscale, inkOutline, toCanvas, makeSheet, downloadCanvas, ORDER, ORDER_CN,
} from "./pixelate.js";
import { buildZip, canvasToBytes } from "./zip.js";
import { encodeGif } from "./gif.js";

/* ---------- tuned constants, matching the Blender script ---------- */

// Blender's Z-up light (-0.42, -0.62, 0.66) expressed in glTF's Y-up space.
const LIGHT = new THREE.Vector3(-0.42, 0.66, 0.62).normalize();
const BAND_MID = 0.46;   // colour-ramp stop for the mid tone
const BAND_HI = 0.68;    // colour-ramp stop for full light
const BAND_MID_VAL = 0.78;
const BAND_HI_VAL = 1.0;

// Blender yaw per facing; the same angle works on Three's Y axis.
const YAW_DEG = { S: 270, SW: 315, W: 0, NW: 45, N: 90, NE: 135, E: 180, SE: 225 };
const YAWS = Object.fromEntries(
  Object.entries(YAW_DEG).map(([k, v]) => [k, THREE.MathUtils.degToRad(v)])
);

/* ---------- state ---------- */

const state = {
  size: 90,
  ss: 16,
  headScale: 1.8,
  bandLow: 0.52,
  outline: true,
  ink: [0, 0, 0],
  lightBg: false,
  modelName: "model",
  gifZoom: 4,      // integer nearest-neighbour scale for the spin GIF
  gifDelay: 150,   // ms per facing
};

let renderer, scene, camera, root, gradient, dirLight;
let frameHeight = 1;
let frames = {};          // dir -> Uint8ClampedArray
let sheetCanvas = null;
let previewYaw = YAWS.S;
let dragging = null;
let gifBytes = null;      // cached so ZIP export never re-encodes
let gifUrl = null;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const logEl = $("log");
const barEl = $("bar");

/* ---------- setup ---------- */

function initRenderer() {
  const canvas = $("preview");
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: true,
    preserveDrawingBuffer: false,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(320, 320, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 0);

  scene = new THREE.Scene();
  scene.background = null;

  // Without ambient light the only contributor is the directional band light.
  dirLight = new THREE.DirectionalLight(0xffffff, Math.PI);
  dirLight.position.copy(LIGHT).multiplyScalar(10);
  scene.add(dirLight);
  scene.add(dirLight.target);

  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);

  gradient = buildGradient(state.bandLow);
}

/** 64-step ramp sampled with NEAREST: below 0.46 shadow, 0.46-0.68 mid, above full. */
function buildGradient(low) {
  const N = 64;
  const data = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    const v = t < BAND_MID ? low : t < BAND_HI ? BAND_MID_VAL : BAND_HI_VAL;
    data[i] = Math.round(255 * v);
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/* ---------- model ---------- */

function loadGLB(arrayBuffer) {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(arrayBuffer, "", resolve, reject);
  });
}

function dropIcosphere(object3d) {
  const junk = [];
  object3d.traverse((o) => {
    if (o.name && o.name.startsWith("Icosphere")) junk.push(o);
  });
  junk.forEach((o) => o.parent && o.parent.remove(o));
  return junk.length;
}

function toToonMaterial(src) {
  const hasMap = !!(src && src.map);
  if (hasMap) src.map.colorSpace = THREE.SRGBColorSpace;
  const color = hasMap
    ? new THREE.Color(0xffffff)
    : src && src.color
    ? src.color.clone()
    : new THREE.Color(0.72, 0.72, 0.72);
  const mat = new THREE.MeshToonMaterial({
    map: hasMap ? src.map : null,
    color,
    gradientMap: gradient,
    side: THREE.FrontSide,
    transparent: false,
  });
  mat.name = "toon";
  return mat;
}

function applyToon(object3d) {
  let meshes = 0;
  object3d.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.frustumCulled = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const next = mats.map(toToonMaterial);
    o.material = Array.isArray(o.material) ? next : next[0];
    meshes++;
  });
  return meshes;
}

function findHeadBone(object3d) {
  let found = null;
  object3d.traverse((o) => {
    if (found) return;
    if (o.isBone && /^head$/i.test(o.name)) found = o;
  });
  return found;
}

/**
 * Point a bone at a world-space direction. Roll-agnostic: works out the delta
 * between where the bone currently aims and where we want it, then converts
 * that back into the bone's parent space. Assumes the bone aims at its first
 * bone child, which is how every Tripo / Mixamo rig is built.
 */
function aimBone(bone, targetDir) {
  const child = bone.children.find((c) => c.isBone && /fore|lower.?arm|hand/i.test(c.name))
    || bone.children.find((c) => c.isBone);
  if (!child) return false;

  bone.updateWorldMatrix(true, false);
  const from = bone.getWorldPosition(new THREE.Vector3());
  const to = child.getWorldPosition(new THREE.Vector3());
  const cur = to.sub(from);
  if (cur.lengthSq() < 1e-9) return false;
  cur.normalize();

  const delta = new THREE.Quaternion().setFromUnitVectors(cur, targetDir.clone().normalize());
  const worldQ = bone.getWorldQuaternion(new THREE.Quaternion());
  const parentQ = new THREE.Quaternion();
  if (bone.parent) bone.parent.getWorldQuaternion(parentQ);

  bone.quaternion.copy(parentQ.invert().multiply(delta.multiply(worldQ)));
  bone.updateMatrixWorld(true);
  return true;
}

/** Blender's script dropped the arms 58 deg so the turnaround stays narrow. */
function poseArms(object3d, degrees) {
  const arms = [];
  object3d.traverse((o) => {
    if (o.isBone && /(upper.?arm|upperarm)$/i.test(o.name)) arms.push(o);
  });
  if (!arms.length) return 0;

  const rad = THREE.MathUtils.degToRad(degrees);
  let done = 0;
  for (const bone of arms) {
    // left/right from where the bone actually sits, not from its name prefix
    const p = bone.getWorldPosition(new THREE.Vector3());
    const sign = p.x >= 0 ? 1 : -1;
    const target = new THREE.Vector3(sign * Math.cos(rad), -Math.sin(rad), 0).normalize();
    if (aimBone(bone, target)) done++;
  }
  return done;
}

/**
 * Exact world bounds for one facing.
 *
 * Rotating a cached axis-aligned box and re-boxing it inflates the result by up
 * to sqrt(2) at 45 deg, which silently shrinks the character in the frame. So
 * sample real vertices, run them through the skin, then measure.
 */
function worldBoxAtYaw(yaw, budget = 24000) {
  root.rotation.y = yaw;
  root.updateMatrixWorld(true);

  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
    if (!pos) return;
    if (o.isSkinnedMesh && o.skeleton) o.skeleton.update();
    const step = Math.max(1, Math.floor(pos.count / budget));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i);
      if (o.isSkinnedMesh && o.applyBoneTransform) o.applyBoneTransform(i, v);
      v.applyMatrix4(o.matrixWorld);
      box.expandByPoint(v);
    }
    // always include the last vertex so the sample never misses an extreme
    v.fromBufferAttribute(pos, pos.count - 1);
    if (o.isSkinnedMesh && o.applyBoneTransform) o.applyBoneTransform(pos.count - 1, v);
    v.applyMatrix4(o.matrixWorld);
    box.expandByPoint(v);
  });
  return box;
}

/** One framing for the whole turnaround: union of every facing's bounds. */
function frameCamera() {
  const union = new THREE.Box3();
  for (const dir of ORDER) union.union(worldBoxAtYaw(YAWS[dir]));

  const size = union.getSize(new THREE.Vector3());
  const center = union.getCenter(new THREE.Vector3());
  const h = Math.max(size.x, size.y) * 1.1;

  frameHeight = h;
  camera.left = -h / 2;
  camera.right = h / 2;
  camera.top = h / 2;
  camera.bottom = -h / 2;
  camera.position.set(center.x, center.y, center.z + 10);
  camera.lookAt(center.x, center.y, center.z);
  camera.updateProjectionMatrix();
  return { h, center, size };
}

/* ---------- preview ---------- */

function drawPreview() {
  if (!root) return;
  root.rotation.y = previewYaw;
  root.updateMatrixWorld(true);
  renderer.setRenderTarget(null);
  renderer.setSize(320, 320, false);
  renderer.clear();
  renderer.render(scene, camera);
}

/* ---------- the actual conversion ---------- */

async function convert() {
  const { size, ss } = state;
  const W = size * ss;
  const t0 = performance.now();

  setBusy(true);
  progress(0.02, "准备渲染目标 " + W + "×" + W);

  const rt = new THREE.WebGLRenderTarget(W, W, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  rt.texture.generateMipmaps = false;

  const px = new Uint8Array(W * W * 4);
  const out = {};

  try {
    for (let i = 0; i < ORDER.length; i++) {
      const dir = ORDER[i];
      root.rotation.y = YAWS[dir];
      root.updateMatrixWorld(true);

      renderer.setRenderTarget(rt);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(rt, 0, 0, W, W, px);

      progress(0.05 + 0.55 * (i / ORDER.length), `渲染 ${ORDER_CN[dir]}（${dir}）`);
      await nextTick();

      progress(0.05 + 0.55 * ((i + 1) / ORDER.length), `投票降采样 ${dir}`);
      let grid = voteDownscale(px, W, size, 8, 0.3, true);
      if (state.outline) grid = inkOutline(grid, size, state.ink);
      out[dir] = grid;
      await nextTick();
    }
  } finally {
    rt.dispose();
  }

  frames = out;

  // second angle pass: the camera was framed from all yaws, restore a facing
  root.rotation.y = previewYaw;

  progress(0.92, "拼接与预览");
  sheetCanvas = makeSheet(frames, size);
  renderCells();
  renderGif();
  $("dlAll").disabled = false;

  const ms = Math.round(performance.now() - t0);
  progress(1, `完成 · ${size}×${size} · 每块 ${ss * ss} 份采样 · ${ms} ms`);
  setBusy(false, "ok");
}

function nextTick() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/* ---------- output rendering ---------- */

function renderCells() {
  const grid = $("grid");
  grid.innerHTML = "";
  for (const dir of ORDER) {
    const data = frames[dir];
    const cell = document.createElement("div");
    cell.className = "cell" + (state.lightBg ? " light" : "");
    const head = document.createElement("div");
    head.className = "cell-head";
    head.innerHTML = `<b>${dir}</b><span>${ORDER_CN[dir]}</span>`;
    cell.appendChild(head);

    if (!data) {
      cell.classList.add("empty");
      cell.textContent = "—";
    } else {
      const box = document.createElement("div");
      box.className = "thumb";
      const c = toCanvas(data, state.size, 4);
      box.appendChild(c);
      cell.appendChild(box);
    }
    grid.appendChild(cell);
  }
}

/* ---------- spin gif ---------- */

/**
 * The 8-facing loop. GIF caps a frame at 256 colours, so every frame gets its
 * own median-cut table (no dithering - it would scatter single pixels and undo
 * the grid). The PNG frames and the atlas stay true colour; this is only the
 * shareable preview.
 */
function renderGif() {
  const img = $("gifPreview");
  const empty = $("gifEmpty");
  const list = ORDER.map((d) => frames[d]).filter(Boolean);

  if (list.length < 2) {
    gifBytes = null;
    img.hidden = true;
    empty.hidden = false;
    $("dlGif").disabled = true;
    return 0;
  }

  const t0 = performance.now();
  gifBytes = encodeGif(list, {
    width: state.size,
    height: state.size,
    zoom: state.gifZoom,
    delay: state.gifDelay,
    loop: 0,
  });
  const ms = Math.round(performance.now() - t0);

  if (gifUrl) URL.revokeObjectURL(gifUrl);
  gifUrl = URL.createObjectURL(new Blob([gifBytes], { type: "image/gif" }));
  img.src = gifUrl;
  img.hidden = false;
  empty.hidden = true;
  $("dlGif").disabled = false;

  const side = state.size * state.gifZoom;
  $("gifNote").textContent =
    `${side}×${side} · ${list.length} 帧 · ${(gifBytes.length / 1024).toFixed(0)} KB · ` +
    `${state.gifDelay} ms/帧 · GIF 每帧上限 256 色（中位切分、不抖动），PNG 帧仍是真彩色`;
  return ms;
}

function downloadBytes(bytes, name, type) {
  const blob = new Blob([bytes], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportGif() {
  if (!gifBytes) return;
  downloadBytes(gifBytes, `${state.modelName}_${state.size}_spin.gif`, "image/gif");
}

function exportCells() {  for (const dir of ORDER) {
    if (!frames[dir]) continue;
    const c = toCanvas(frames[dir], state.size, 1);
    downloadCanvas(c, `${state.modelName}_${state.size}_${dir}.png`);
  }
}

async function exportZip() {
  setBusy(true, "打包 ZIP");
  try {
    const files = [];
    for (const dir of ORDER) {
      if (!frames[dir]) continue;
      const c = toCanvas(frames[dir], state.size, 1);
      files.push({ name: `${dir}.png`, data: await canvasToBytes(c) });
    }
    files.push({ name: "sheet.png", data: await canvasToBytes(sheetCanvas) });
    if (gifBytes) files.push({ name: "spin.gif", data: gifBytes });
    files.push({
      name: "sprite.json",
      data: new TextEncoder().encode(JSON.stringify({
        cell_w: state.size,
        cell_h: state.size,
        order: ORDER,
        mode: "browser ssaa-vote+outline",
        subpixels_per_block: state.ss * state.ss,
        head_scale: state.headScale,
        band_low: state.bandLow,
      }, null, 2)),
    });

    const blob = buildZip(files);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.modelName}_px${state.size}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    progress(1, `ZIP 已导出 · ${files.length} 个文件`);
  } catch (err) {
    console.error(err);
    progress(0, "ZIP 失败：" + err.message);
  }
  setBusy(false, "ok");
}

/* ---------- ui plumbing ---------- */

function setBusy(busy, kind) {
  const run = $("run");
  run.disabled = busy || !root;
  if (!busy) {
    statusEl.className = "status " + (kind || "");
  } else {
    statusEl.className = "status busy";
  }
  if (busy) statusEl.textContent = "处理中…";
  else if (kind === "ok") statusEl.textContent = "完成";
  else if (kind === "err") statusEl.textContent = "失败";
  else statusEl.textContent = root ? "模型已就绪" : "等待导入模型";
}

function progress(p, msg) {
  barEl.style.width = Math.round(p * 100) + "%";
  if (msg) logEl.textContent = msg;
}

function bindSegment(id, onPick) {
  const el = $(id);
  el.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    [...el.children].forEach((b) => b.classList.toggle("on", b === btn));
    onPick(btn.dataset.v);
  });
}

function bindUI() {
  const drop = $("drop");
  const file = $("file");
  drop.addEventListener("click", () => file.click());
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) ingest(f);
  });
  file.addEventListener("change", () => {
    if (file.files[0]) ingest(file.files[0]);
  });

  bindSegment("sizeSeg", (v) => { state.size = +v; });
  bindSegment("ssSeg", (v) => { state.ss = +v; });
  bindSegment("bgSeg", (v) => {
    state.lightBg = v === "light";
    document.querySelectorAll(".cell").forEach((c) => c.classList.toggle("light", state.lightBg));
    renderCells();
    $("gifWrap").classList.toggle("light", state.lightBg);
  });

  const head = $("head");
  head.addEventListener("input", () => {
    state.headScale = +head.value;
    $("headVal").textContent = state.headScale.toFixed(2);
    if (root) applyHeadScale();
  });

  const band = $("band");
  band.addEventListener("input", () => {
    state.bandLow = +band.value;
    $("bandVal").textContent = state.bandLow.toFixed(2);
    gradient.dispose();
    gradient = buildGradient(state.bandLow);
    if (root) {
      root.traverse((o) => {
        if (o.material && o.material.gradientMap !== undefined) o.material.gradientMap = gradient;
      });
      drawPreview();
    }
  });

  $("outline").addEventListener("change", (e) => { state.outline = e.target.checked; });
  $("inkColor").addEventListener("change", (e) => {
    const hex = e.target.value;
    state.ink = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  });

  $("run").addEventListener("click", () => convert().catch((err) => {
    console.error(err);
    progress(0, err.message);
    setBusy(false, "err");
  }));
  $("dlAll").addEventListener("click", exportZip);
  $("dlGif").addEventListener("click", exportGif);

  // preview drag to spin
  const cv = $("preview");
  cv.addEventListener("pointerdown", (e) => {
    dragging = { x: e.clientX, yaw: previewYaw };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    previewYaw = dragging.yaw + (e.clientX - dragging.x) * 0.012;
    drawPreview();
  });
  cv.addEventListener("pointerup", () => { dragging = null; });
  cv.addEventListener("pointercancel", () => { dragging = null; });
}

/** Re-apply the head bone scale and reframe; cheap enough to run on slider drag. */
function applyHeadScale() {
  const bone = findHeadBone(root);
  if (!bone) {
    logEl.textContent = "模型无 Head 骨骼，头部放大已跳过";
    return;
  }
  bone.scale.setScalar(state.headScale);
  bone.updateMatrixWorld(true);
  frameCamera();
  drawPreview();
}

async function ingest(file) {
  if (!/\.(glb|gltf)$/i.test(file.name)) {
    progress(0, "请选择 .glb 或 .gltf 文件");
    setBusy(false, "err");
    return;
  }
  setBusy(true);
  progress(0.1, `读取 ${file.name}（${(file.size / 1048576).toFixed(1)} MB）`);

  try {
    const buf = await file.arrayBuffer();
    progress(0.35, "解析 GLB…");
    const gltf = await loadGLB(buf);

    if (root) {
      scene.remove(root);
      disposeTree(root);
    }

    root = gltf.scene;
    state.modelName = file.name.replace(/\.(glb|gltf)$/i, "").replace(/[^\w\-]+/g, "_").slice(0, 40) || "model";

    const junk = dropIcosphere(root);
    const meshes = applyToon(root);
    scene.add(root);

    // arms down first: a T-pose forces the frame to fit the widest span and
    // shrinks the character by a third compared with the offline renders
    const arms = poseArms(root, 76);

    // head bone next, so the cached boxes already include the bigger head
    const bone = findHeadBone(root);
    if (bone) bone.scale.setScalar(state.headScale);
    root.updateMatrixWorld(true);

    const frame = frameCamera();

    previewYaw = YAWS.S;
    root.rotation.y = previewYaw;
    root.updateMatrixWorld(true);
    drawPreview();

    let tris = 0;
    root.traverse((o) => {
      if (o.isMesh && o.geometry) {
        const g = o.geometry;
        tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      }
    });

    $("modelInfo").innerHTML =
      `<b>${file.name}</b><br>` +
      `${(file.size / 1048576).toFixed(1)} MB · ${meshes} 个网格 · ${Math.round(tris).toLocaleString()} 三角面` +
      (junk ? ` · 已移除 ${junk} 个辅助球` : "") +
      (arms ? ` · 手臂下垂 ${arms} 侧` : " · 未识别手臂骨骼") +
      (bone ? "" : " · 无 Head 骨骼");

    frames = {};
    sheetCanvas = null;
    renderCells();
    $("dlAll").disabled = true;
    $("grid").innerHTML = "";
    for (let i = 0; i < 8; i++) {
      const d = document.createElement("div");
      d.className = "cell empty";
      d.textContent = "待生成";
      $("grid").appendChild(d);
    }

    progress(0, `取景高度 ${frame.h.toFixed(2)}，可生成`);
    setBusy(false);
  } catch (err) {
    console.error(err);
    progress(0, "解析失败：" + err.message);
    setBusy(false, "err");
  }
}

function disposeTree(object3d) {
  object3d.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if (m.map && m.map !== undefined) m.map.dispose();
        m.dispose();
      });
    }
  });
}

/* ---------- boot ---------- */

initRenderer();
bindUI();
setBusy(false);
window.__app = {
  state,
  get frames() { return frames; },
  get root() { return root; },
  get scene() { return scene; },
  get camera() { return camera; },
  convert,
  ingest,
  exportZip,
  exportCells,
  renderGif,
  get gifBytes() { return gifBytes; },
};
