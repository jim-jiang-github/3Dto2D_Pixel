/**
 * Skeletal animation for the pixel-sprite tool.
 *
 * Three ways to get motion, in licensing-friendliest order:
 *
 *   1. built-in procedural clips (idle / walk / run) authored right here
 *      against the humanoid rig shared by the shipped models
 *      (Hip, Spine01/02, L_Thigh, L_Upperarm ...). No third-party files.
 *   2. clips embedded in the user's GLB, played as-is.
 *   3. clips that come inside the user's own GLB, played as-is.
 *
 * Cross-rig retargeting (Mixamo -> this rig) was prototyped and dropped: the
 * bone roll conventions differ too much and every variant produced a
 * permanent tilt, which is worse than not offering the feature.
 *
 * Procedural poses are authored in *character space* (root with yaw = 0) and
 * conjugated into each bone's local frame through the rest-pose parent
 * quaternion, so they work no matter what local axis conventions each bone
 * uses. The conjugation also cancels the root yaw automatically, so a leg
 * always swings in the sagittal plane of the character, whatever facing is
 * being rendered.
 */
import * as THREE from "three";

const DEG = THREE.MathUtils.degToRad;
const TAU = Math.PI * 2;

/* ---------- bone lookup ---------- */

// Exact names of the shared 78-joint rig first, regex fallbacks for friends.
const BONE_DEFS = {
  hip:       [/^Hip$/i, /^Hips$/i, /pelvis/i],
  spine1:    [/^Spine0?1$/i, /^Waist$/i, /^Spine$/i],
  spine2:    [/^Spine0?2$/i, /^Spine$/i],
  neck:      [/^Neck/i],
  lThigh:    [/^L_?Thigh$/i, /l.*(up.?leg|upper.?leg|thigh)/i],
  rThigh:    [/^R_?Thigh$/i, /r.*(up.?leg|upper.?leg|thigh)/i],
  lCalf:     [/^L_?Calf$/i, /l.*(calf|shin)/i],
  rCalf:     [/^R_?Calf$/i, /r.*(calf|shin)/i],
  lFoot:     [/^L_?Foot$/i],
  rFoot:     [/^R_?Foot$/i],
  lUpperarm: [/^L_?Upperarm$/i, /l.*(upper.?arm)/i],
  rUpperarm: [/^R_?Upperarm$/i, /r.*(upper.?arm)/i],
  lForearm:  [/^L_?Forearm$/i, /l.*(fore.?arm)/i],
  rForearm:  [/^R_?Forearm$/i, /r.*(fore.?arm)/i],
};

export function findBones(root) {
  const bones = {};
  root.traverse((o) => {
    if (!o.isBone) return;
    for (const [key, patterns] of Object.entries(BONE_DEFS)) {
      if (bones[key]) continue;
      if (patterns.some((re) => re.test(o.name))) bones[key] = o;
    }
  });
  return bones;
}

/* ---------- rest pose ---------- */

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Where does the character look in character space? Eyes are the most
 * reliable marker (this rig has L_Eye / R_Eye); toes are the fallback.
 * Without this, "swing the leg forward" would become "do the splits" on any
 * model whose forward axis is not +Z.
 */
function detectForward(root) {
  const head = [];
  const eyes = [];
  const feet = [];
  const toes = [];
  root.traverse((o) => {
    if (!o.isBone) return;
    if (/^head$/i.test(o.name)) head.push(o);
    else if (/eye/i.test(o.name)) eyes.push(o);
    else if (/toe/i.test(o.name)) toes.push(o);
    else if (/^[lr]_?foot$/i.test(o.name)) feet.push(o);
  });

  const centroid = (list) => {
    const v = new THREE.Vector3();
    list.forEach((b) => v.add(b.getWorldPosition(new THREE.Vector3())));
    return list.length ? v.divideScalar(list.length) : null;
  };

  let from = head[0] && head[0].getWorldPosition(new THREE.Vector3());
  let to = centroid(eyes);
  if (!from || !to) {
    from = centroid(feet);
    to = centroid(toes);
  }
  if (from && to) {
    const f = to.clone().sub(from);
    f.y = 0;
    if (f.lengthSq() > 1e-8) return f.normalize();
  }
  return new THREE.Vector3(0, 0, 1);
}

/**
 * Snapshot every bone's local transform plus each parent's world quaternion
 * (measured with the root yaw zeroed, after arm-drop and head scale, so the
 * procedural clips layer on top of the app's base pose). Also records the
 * character's own forward / side / up axes.
 */
export function captureRest(root) {
  const yaw = root.rotation.y;
  root.rotation.y = 0;
  root.updateMatrixWorld(true);

  const map = new Map();
  root.traverse((o) => {
    if (!o.isBone) return;
    const parentQ = o.parent
      ? o.parent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion();
    map.set(o, {
      bone: o,
      q: o.quaternion.clone(),
      p: o.position.clone(),
      parentQ,
      invParentQ: parentQ.clone().invert(),
    });
  });

  const fwd = detectForward(root);
  const side = fwd.clone().cross(UP).normalize();   // + side swings the bone forward

  root.rotation.y = yaw;
  root.updateMatrixWorld(true);
  return { map, bones: findBones(root), axes: { up: UP.clone(), fwd, side } };
}

export function restoreRest(rest) {
  if (!rest) return;
  for (const e of rest.map.values()) {
    e.bone.quaternion.copy(e.q);
    e.bone.position.copy(e.p);
  }
}

/* ---------- procedural clips ---------- */

function poseIdle(p, s) {
  const sin = Math.sin, cos = Math.cos;
  const ph = TAU * p;
  return [
    { b: "hip", dy: -0.004 * s * (1 - cos(ph)), rz: 1.2 * sin(ph) },
    { b: "spine1", rx: 1.4 * sin(ph), ry: 1.6 * sin(ph) },
    { b: "spine2", rx: 1.0 * sin(ph) },
    { b: "neck", rx: -0.9 * sin(ph) },
    { b: "lUpperarm", rx: 1.6 * sin(ph) },
    { b: "rUpperarm", rx: -1.6 * sin(ph) },
  ];
}

/** Shared leg/arm engine; walk and run only differ in amplitude and timing. */
function locomotion(p, s, k) {
  const sin = Math.sin, cos = Math.cos;
  const ph = TAU * p;

  // leg channels: left leads, right is half a cycle behind
  const swingL = sin(ph);
  const swingR = sin(ph + Math.PI);
  // knee bends while the leg swings forward through the back position
  const kneeL = k.knee * Math.max(0, sin(ph + k.kneePhase));
  const kneeR = k.knee * Math.max(0, sin(ph + k.kneePhase + Math.PI));

  return [
    { b: "hip", dy: -k.bob * s * (1 - cos(2 * ph)), ry: k.hipTwist * sin(ph), rx: k.lean },
    { b: "spine1", ry: -k.twist * sin(ph), rx: k.lean * 0.6 },
    { b: "spine2", ry: -k.twist * 0.55 * sin(ph), rx: k.lean * 0.4 },
    { b: "neck", ry: k.twist * 0.45 * sin(ph), rx: -k.lean * 0.5 },

    { b: "lThigh", rx: k.thigh * swingL + k.thighBend },
    { b: "rThigh", rx: k.thigh * swingR + k.thighBend },
    { b: "lCalf", rx: -kneeL },
    { b: "rCalf", rx: -kneeR },
    { b: "lFoot", rx: k.foot * sin(ph + 1.0) + k.footBend },
    { b: "rFoot", rx: k.foot * sin(ph + 1.0 + Math.PI) + k.footBend },

    { b: "lUpperarm", rx: -k.arm * swingL },
    { b: "rUpperarm", rx: -k.arm * swingR },
    { b: "lForearm", rx: -k.elbow - k.elbowSwing * swingL },
    { b: "rForearm", rx: -k.elbow - k.elbowSwing * swingR },
  ];
}

const WALK = {
  thigh: 30, thighBend: 4, knee: 46, kneePhase: 2.2, foot: 9, footBend: 0,
  arm: 24, elbow: 9, elbowSwing: 5, twist: 8, hipTwist: 3, lean: 2, bob: 0.012,
};
const RUN = {
  thigh: 38, thighBend: 10, knee: 68, kneePhase: 2.4, foot: 12, footBend: 6,
  arm: 34, elbow: 30, elbowSwing: 10, twist: 10, hipTwist: 5, lean: 6, bob: 0.022,
};

function poseWalk(p, s) { return locomotion(p, s, WALK); }
function poseRun(p, s) { return locomotion(p, s, RUN); }

/** Built-in clips. `dur` in seconds; pose(p) with p in [0, 1). */
export const PROC_CLIPS = [
  { id: "idle", label: "待机", dur: 3.6, pose: poseIdle },
  { id: "walk", label: "行走", dur: 1.05, pose: poseWalk },
  { id: "run", label: "奔跑", dur: 0.62, pose: poseRun },
];

/**
 * Apply a procedural pose. rx/ry/rz are degrees around the character's own
 * side / up / forward axes (not the world axes, and not each bone's local
 * axes); they get conjugated into each bone's local frame through the
 * rest-pose parent quaternion. `scale` (the framed character height)
 * normalises the hip bob.
 */
export function applyProcPose(rest, id, p, scale) {
  if (!rest) return;
  const clip = PROC_CLIPS.find((c) => c.id === id);
  if (!clip) return;
  restoreRest(rest);

  const { up, fwd, side } = rest.axes;
  const A = new THREE.Quaternion();
  const qx = new THREE.Quaternion();
  const qy = new THREE.Quaternion();
  const qz = new THREE.Quaternion();
  const local = new THREE.Quaternion();
  const off = new THREE.Vector3();

  for (const tr of clip.pose(p, scale)) {
    const bone = rest.bones[tr.b];
    const e = bone && rest.map.get(bone);
    if (!e) continue;

    qx.setFromAxisAngle(side, DEG(tr.rx || 0));
    qy.setFromAxisAngle(up, DEG(tr.ry || 0));
    qz.setFromAxisAngle(fwd, DEG(tr.rz || 0));
    A.copy(qy).multiply(qx).multiply(qz);

    local.copy(e.invParentQ).multiply(A).multiply(e.parentQ);
    bone.quaternion.copy(local).multiply(e.q);

    if (tr.dy) {
      off.set(0, tr.dy * scale, 0).applyQuaternion(e.invParentQ);
      bone.position.copy(e.p).add(off);
    }
  }
}
