// Three.js 3D 回放场景：球场 + 18 名小人（9v9）+ 脉冲 LED 球 + 跟随镜头
// 只读引擎数据（events/teams），不改引擎；播放/步进/跳节仍由 MatchView 控制
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MatchEvent } from '../game/match';
import { FIELD_W, FIELD_H } from '../game/match';
import type { Team } from '../game/teams';

export const PULSE_COLORS = ['#9ca3af', '#9ca3af', '#3b82f6', '#22c55e', '#eab308', '#ef4444'];

const TEAM_COLORS = ['#2563eb', '#dc2626']; // 蓝 / 红
const GK_COLOR = '#f59e0b';                 // 门将异色
const HALF_W = FIELD_W / 2;                 // 32.5
const HALF_H = FIELD_H / 2;                 // 20
const BALL_R = 0.22;
const CAM_H = 27;
const CAM_D = 22;

// 世界坐标：x = 游戏 x 居中，z = 游戏 y 居中，y 向上
const wx = (gx: number) => gx - HALF_W;
const wz = (gy: number) => gy - HALF_H;

function eventIndexAt(events: MatchEvent[], t: number): number {
  let lo = 0, hi = events.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// 简化站位：控球方围绕球展开，防守方在球与本方球门之间布阵（与旧 2D 版一致）
function layoutTeams(possession: 0 | 1, bx: number, by: number): { x: number; y: number }[][] {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const gkX = (t: 0 | 1) => (t === 0 ? 2.5 : FIELD_W - 2.5);
  const out: { x: number; y: number }[][] = [[], []];
  for (const t of [0, 1] as const) {
    const isAtt = t === possession;
    const d = isAtt ? (possession === 0 ? 1 : -1) : (possession === 0 ? -1 : 1);
    const arr = out[t];
    arr[0] = { x: gkX(t), y: FIELD_H / 2 };
    const offs: [number, number][] = isAtt
      ? [[10, 0], [5, 4.5], [5, -4.5], [0, 8], [0, -8], [1, 0], [-6, 5], [-6, -5]]
      : [[-3, 0], [-6, 3.5], [-6, -3.5], [-11, 7], [-11, -7], [-12, 0], [-18, 6], [-18, -6]];
    for (let i = 0; i < 8; i++) {
      arr[i + 1] = {
        x: clamp(bx + d * offs[i][0], 1.5, FIELD_W - 1.5),
        y: clamp(by + offs[i][1], 1.5, FIELD_H - 1.5),
      };
    }
  }
  return out;
}

// 号码 Sprite 文字纹理（每个号码缓存一份）
const labelTexCache = new Map<string, THREE.CanvasTexture>();
function labelTexture(text: string): THREE.CanvasTexture {
  const hit = labelTexCache.get(text);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.font = 'bold 88px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 12;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.strokeText(text, 64, 66);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, 64, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  labelTexCache.set(text, tex);
  return tex;
}

interface PlayerRig {
  group: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  yaw: number;       // 当前朝向（弧度）
  phase: number;     // 跑步摆腿相位
  prevTarget: THREE.Vector3;
}

// 共享几何体（内存省）
const sphereGeo = new THREE.SphereGeometry(1, 14, 12);
const capsuleGeo = new THREE.CapsuleGeometry(1, 1, 4, 8);
const headGeo = new THREE.SphereGeometry(0.17, 12, 10);

export class MatchScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private events: MatchEvent[];
  private players: PlayerRig[] = [];
  private ball: THREE.Mesh;
  private ballMat!: THREE.MeshStandardMaterial;
  private halo: THREE.Mesh;
  private haloMat!: THREE.MeshBasicMaterial;
  private actorRing: THREE.Mesh;
  private followTarget = new THREE.Vector3(0, 0, 0);
  private ballTarget = new THREE.Vector3();
  private clock = 0;
  private lastNow = 0;
  private interacting = false;
  private observer: ResizeObserver;
  private disposed = false;
  private disposables: { dispose(): void }[] = [];
  private actorNames: [string[], string[]];

  constructor(container: HTMLElement, teams: [Team, Team], events: MatchEvent[]) {
    this.events = events;
    this.actorNames = [
      teams[0].players.map((p) => p.name),
      teams[1].players.map((p) => p.name),
    ];

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.disposables.push(this.renderer);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0d2317');

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
    this.camera.position.set(0, CAM_H, CAM_D + 4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 90;
    this.controls.minPolarAngle = 0.12;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.12;
    this.controls.target.copy(this.followTarget);
    this.controls.addEventListener('start', () => { this.interacting = true; });
    this.controls.addEventListener('end', () => { this.interacting = false; });
    this.disposables.push(this.controls);

    // 灯光：环境光 + 方向光
    this.scene.add(new THREE.AmbientLight('#ffffff', 0.75));
    const dir = new THREE.DirectionalLight('#ffffff', 1.6);
    dir.position.set(30, 50, 20);
    this.scene.add(dir);
    const hemi = new THREE.HemisphereLight('#bfe6ff', '#1c3a28', 0.5);
    this.scene.add(hemi);

    this.buildField();
    this.buildGoals();
    this.ball = this.buildBall();
    this.halo = this.buildHalo();
    this.actorRing = this.buildActorRing();
    this.buildPlayers(teams);

    // 初始落位：0 秒事件的球位
    const e0 = events.length ? events[eventIndexAt(events, 0)] : undefined;
    if (e0) {
      const bx = e0.x, by = e0.y;
      this.ball.position.set(wx(bx), BALL_R, wz(by));
      this.halo.position.copy(this.ball.position);
      const layout = layoutTeams(e0.team === 0 ? 0 : 1, bx, by);
      for (let t = 0; t < 2; t++)
        for (let i = 0; i < 9; i++) {
          const p = this.players[t * 9 + i];
          p.group.position.set(wx(layout[t][i].x), 0, wz(layout[t][i].y));
          p.prevTarget.copy(p.group.position);
        }
    }

    // 尺寸自适应
    const fit = () => {
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight || (w * FIELD_H) / FIELD_W);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    fit();
    this.observer = new ResizeObserver(fit);
    this.observer.observe(container);
  }

  // ---------- 场景搭建 ----------

  private line(points: THREE.Vector3[], color: string, loop = false): THREE.Line {
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color });
    const line = loop ? new THREE.LineLoop(geo, mat) : new THREE.Line(geo, mat);
    this.disposables.push(geo, mat);
    return line;
  }

  private buildField(): void {
    // 草地平面
    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD_W, FIELD_H),
      new THREE.MeshStandardMaterial({ color: '#2e9e57', roughness: 0.95 }),
    );
    grass.rotation.x = -Math.PI / 2;
    this.scene.add(grass);
    this.disposables.push(grass.geometry, grass.material as THREE.Material);

    // 白线（边线 / 中线 / 中圈 / 禁区弧 / 脉冲区弧）
    const y = 0.02;
    this.scene.add(this.line([
      new THREE.Vector3(-HALF_W, y, -HALF_H), new THREE.Vector3(HALF_W, y, -HALF_H),
      new THREE.Vector3(HALF_W, y, HALF_H), new THREE.Vector3(-HALF_W, y, HALF_H),
    ], '#f2f7f4', true));
    this.scene.add(this.line([
      new THREE.Vector3(0, y, -HALF_H), new THREE.Vector3(0, y, HALF_H),
    ], '#f2f7f4'));

    // 中圈 r=3
    const cpts: THREE.Vector3[] = [];
    for (let a = 0; a <= Math.PI * 2 + 1e-4; a += Math.PI / 48) {
      cpts.push(new THREE.Vector3(3 * Math.cos(a), y, 3 * Math.sin(a)));
    }
    this.scene.add(this.line(cpts, '#f2f7f4'));

    // 禁区弧 r=8、脉冲区弧 r=13（半圆朝场内）
    for (const g of [0, FIELD_W] as const) {
      const cx = wx(g);
      const inDir = g === 0 ? 1 : -1; // 朝场内
      const arc = (r: number, color: string) => {
        const pts: THREE.Vector3[] = [];
        for (let a = -Math.PI / 2; a <= Math.PI / 2 + 1e-4; a += Math.PI / 40) {
          pts.push(new THREE.Vector3(cx + inDir * r * Math.cos(a), y, r * Math.sin(a)));
        }
        this.scene.add(this.line(pts, color));
      };
      arc(8, '#f2f7f4');
      arc(13, '#b8f0cc');
    }
    // 球门线（两端白线）
    for (const g of [0, FIELD_W] as const) {
      const cx = wx(g);
      this.scene.add(this.line([
        new THREE.Vector3(cx, y, -2.5), new THREE.Vector3(cx, y, 2.5),
      ], '#f2f7f4'));
    }
  }

  private buildGoals(): void {
    const postGeo = new THREE.CylinderGeometry(0.07, 0.07, 2.2, 8);
    const barGeo = new THREE.CylinderGeometry(0.07, 0.07, 4.2, 8);
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4 });
    this.disposables.push(postGeo, barGeo, mat);
    for (const g of [0, FIELD_W] as const) {
      const cx = wx(g);
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, mat);
        post.position.set(cx + (g === 0 ? -0.05 : 0.05), 1.1, s * 2);
        this.scene.add(post);
      }
      const bar = new THREE.Mesh(barGeo, mat);
      bar.rotation.x = Math.PI / 2; // 横梁沿 Z 轴（跨球门宽度）
      bar.position.set(cx + (g === 0 ? -0.05 : 0.05), 2.2, 0);
      this.scene.add(bar);
    }
  }

  private buildBall(): THREE.Mesh {
    const mat = new THREE.MeshStandardMaterial({
      color: '#ffffff', roughness: 0.35, emissive: '#9ca3af', emissiveIntensity: 1.2,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 20, 16), mat);
    this.scene.add(mesh);
    this.ballMat = mat;
    this.disposables.push(mesh.geometry, mat);
    return mesh;
  }

  private buildHalo(): THREE.Mesh {
    const mat = new THREE.MeshBasicMaterial({
      color: '#9ca3af', transparent: true, opacity: 0.26,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 12), mat);
    this.scene.add(mesh);
    this.haloMat = mat;
    this.disposables.push(mesh.geometry, mat);
    return mesh;
  }

  private buildActorRing(): THREE.Mesh {
    const mat = new THREE.MeshBasicMaterial({ color: '#fbbf24', transparent: true, opacity: 0.85 });
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.05, 6, 36), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    this.scene.add(mesh);
    this.disposables.push(mesh.geometry, mat);
    return mesh;
  }

  private buildPlayers(teams: [Team, Team]): void {
    const skinMat = new THREE.MeshStandardMaterial({ color: '#f1c27d', roughness: 0.7 });
    // 每队一套队色材质（门将单独异色）
    const teamMats: THREE.MeshStandardMaterial[][] = teams.map((_, t) => [
      new THREE.MeshStandardMaterial({ color: TEAM_COLORS[t], roughness: 0.6 }),
      new THREE.MeshStandardMaterial({ color: GK_COLOR, roughness: 0.6 }),
    ]);
    teamMats.forEach((mats) => { this.disposables.push(mats[0], mats[1]); });
    this.disposables.push(skinMat);

    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < 9; i++) {
        const isGK = i === 0;
        const bodyMat = teamMats[t][isGK ? 1 : 0];
        const group = new THREE.Group();

        // 身体（胶囊）+ 头
        const body = new THREE.Mesh(capsuleGeo, bodyMat);
        body.scale.set(0.2, 0.52, 0.16);
        body.position.y = 0.7;
        group.add(body);
        const head = new THREE.Mesh(headGeo, skinMat);
        head.position.y = 1.28;
        group.add(head);

        // 四肢（胶囊，组做旋转支点）
        const limbGeo = capsuleGeo;
        const mkLimb = (x: number, y: number, scale: [number, number, number]) => {
          const g = new THREE.Group();
          g.position.set(x, y, 0);
          const m = new THREE.Mesh(limbGeo, bodyMat);
          m.scale.set(scale[0], scale[1], scale[2]);
          m.position.y = -scale[1];
          g.add(m);
          group.add(g);
          return g;
        };
        const leftLeg = mkLimb(-0.1, 0.52, [0.08, 0.26, 0.08]);
        const rightLeg = mkLimb(0.1, 0.52, [0.08, 0.26, 0.08]);
        const leftArm = mkLimb(-0.24, 1.1, [0.06, 0.22, 0.06]);
        const rightArm = mkLimb(0.24, 1.1, [0.06, 0.22, 0.06]);

        // 号码标签
        const num = String(teams[t].players[i].number);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: labelTexture(num), transparent: true, depthWrite: false,
        }));
        sprite.scale.set(1.15, 1.15, 1);
        sprite.position.y = 1.92;
        group.add(sprite);

        this.scene.add(group);
        this.players.push({
          group, leftLeg, rightLeg, leftArm, rightArm,
          yaw: t === 0 ? Math.PI : 0, phase: i * 1.3,
          prevTarget: new THREE.Vector3(0, 0, 0),
        });
      }
    }
  }

  // ---------- 每帧更新 ----------

  update(vtime: number, now: number): void {
    const events = this.events;
    const t = Math.min(Math.max(0, vtime), events.length ? events[events.length - 1].t : 0);
    const idx = eventIndexAt(events, t);
    const cur = events[Math.min(idx, events.length - 1)];
    const nxt = events[idx + 1];
    const frac = nxt ? (t - cur.t) / Math.max(1e-6, nxt.t - cur.t) : 0;
    const bx = nxt ? cur.x + (nxt.x - cur.x) * frac : cur.x;
    const by = nxt ? cur.y + (nxt.y - cur.y) * frac : cur.y;
    const pulse = Math.max(0, Math.min(5, Math.round(cur.pulse)));
    const possession: 0 | 1 = cur.team === 0 ? 0 : 1;

    const dt = Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    this.clock += dt;

    // 球：线性插值坐标 + 轻微滞后
    const kBall = 1 - Math.exp(-dt * 9);
    this.ballTarget.set(wx(bx), BALL_R, wz(by));
    this.ball.position.lerp(this.ballTarget, kBall);
    const pc = new THREE.Color(PULSE_COLORS[pulse]);
    this.ballMat.emissive.copy(pc);
    this.haloMat.color.copy(pc);
    const hs = 1 + 0.3 * Math.sin(this.clock * 5);
    this.halo.scale.setScalar(hs);
    this.halo.position.copy(this.ball.position);

    // 球速（世界单位/秒，镜头提前量用）
    let bvx = 0, bvz = 0;
    if (nxt) {
      const dT = Math.max(1e-3, nxt.t - cur.t);
      bvx = (nxt.x - cur.x) / dT;
      bvz = (nxt.y - cur.y) / dT;
    }

    // 球员：位置缓动 + 面向移动方向 + 摆腿
    const layout = layoutTeams(possession, bx, by);
    const kP = 1 - Math.exp(-dt * 6);
    for (let t2 = 0; t2 < 2; t2++) {
      for (let i = 0; i < 9; i++) {
        const p = layout[t2][i];
        const rig = this.players[t2 * 9 + i];
        const g = rig.group.position;
        const tx = wx(p.x), tz = wz(p.y);
        const prev = rig.prevTarget;
        const v = dt > 1e-4 ? prev.distanceTo(new THREE.Vector3(tx, 0, tz)) / dt : 0;
        prev.set(tx, 0, tz);

        g.x += (tx - g.x) * kP;
        g.z += (tz - g.z) * kP;

        // 摆腿：sin 相位 × 速度
        const amp = Math.min(0.85, v * 0.16);
        rig.phase += v * dt * 6;
        rig.leftLeg.rotation.x = Math.sin(rig.phase) * amp;
        rig.rightLeg.rotation.x = Math.sin(rig.phase + Math.PI) * amp;
        rig.leftArm.rotation.x = Math.sin(rig.phase + Math.PI) * amp * 0.55;
        rig.rightArm.rotation.x = Math.sin(rig.phase) * amp * 0.55;

        // 朝向：朝目标方向，最短弧平滑
        if (v > 0.4) {
          const desired = Math.atan2(tx - g.x, tz - g.z);
          let d = desired - rig.yaw;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          rig.yaw += d * (1 - Math.exp(-dt * 8));
        }
        rig.group.rotation.y = rig.yaw;
      }
    }

    // 事件主角高亮圈
    const actorName = cur.player;
    let actor = -1;
    if (actorName !== undefined) {
      const names = this.actorNames[cur.team];
      for (let i = 0; i < 9; i++) {
        if (names[i] === actorName) { actor = cur.team * 9 + i; break; }
      }
    }
    if (actor >= 0) {
      this.actorRing.visible = true;
      const ap = this.players[actor].group.position;
      this.actorRing.position.set(ap.x, 0.045, ap.z);
    } else {
      this.actorRing.visible = false;
    }

    // 镜头：跟随球（提前量 + 俯视），鼠标拖拽/滚轮自由操控
    let lx = bvx * 0.9, lz = bvz * 0.9;
    const lmag = Math.hypot(lx, lz);
    if (lmag > 7) { lx *= 7 / lmag; lz *= 7 / lmag; }
    lx += possession === 0 ? 3 : -3; // 进攻方向偏置
    const kT = 1 - Math.exp(-dt * 4);
    this.followTarget.lerp(new THREE.Vector3(this.ball.position.x + lx, 0, this.ball.position.z + lz), kT);

    if (!this.interacting) {
      const ideal = new THREE.Vector3(this.followTarget.x, CAM_H, this.followTarget.z + CAM_D);
      this.camera.position.lerp(ideal, 1 - Math.exp(-dt * 3));
    }
    this.controls.target.lerp(this.followTarget, kT);
    this.controls.update();

    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer.disconnect();
    this.scene.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const d of this.disposables) {
      try { d.dispose(); } catch { /* 已释放 */ }
    }
    this.renderer.domElement.remove();
  }
}
