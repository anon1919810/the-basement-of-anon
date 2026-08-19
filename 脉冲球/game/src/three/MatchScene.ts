// Three.js 3D 回放场景：球场 + 18 名小人（9v9）+ 脉冲 LED 球 + 跟随镜头
// 只读引擎数据（events/teams），不改引擎；播放/步进/跳节仍由 MatchView 控制
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
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

// ---- 播放参数（集中可调）----
export const PLAYBACK = {
  // 游戏时钟推进倍率：1x = 1 游戏秒 / 1 真实秒 → 每秒一条的事件约铺 60 帧，插值/缓动充分展现。
  // 旧版为 duration/60（每帧正好跳一个事件 → 木偶跳帧）；如需整体加速观赛，调大此值即可
  //（建议 ≤ 6：再快则每事件不足 10 帧，缓动又开始丢失）。
  TIME_SCALE: 1,
  // easeInOutCubic：段内加速-减速（不是匀速直线）
  EASE: (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  // 球的飞行弧线：长距离/空中球类事件轻微抬高
  ARC: {
    MIN_DIST: 6,      // 位移 ≥ 6 米才起弧
    RATE: 0.08,       // 弧高 ≈ 位移 × RATE
    MAX_H: 2.6,       // 最高弧（米）
    TYPES: new Set<string>([
      'pass', 'shot', 'kickoff', 'throwin', 'offside',
      'penalty', 'penalty_goal', 'penalty_miss', 'shootout_goal', 'shootout_miss', 'goal',
    ]),
  },
};

// 物理（Rapier）：球是动态刚体，事件轨迹采样点作为"引力目标"——力驱动弹簧-阻尼约束
// 保住 vtime 回放同步，同时球有惯性/重力/弹跳/滚动；近点吸附防漂移
export const PHYS = {
  GRAVITY: -9.8,
  STEP: 1 / 60,        // 物理步长（秒）
  K_F: 42,             // 水平弹簧刚度（力/米）
  K_FY: 30,            // 垂直弹簧刚度（弱于重力，保弧线）
  DAMP: 4.2,           // 阻尼（力/速度）
  MAX_V: 30,           // 踢球初速上限（m/s）
  MAX_VY: 16,          // 垂直初速上限
  RESTITUTION: 0.52,   // 球地反弹
  SNAP_DIST: 0.4,      // 距目标该距离内吸附
};

// 球员碰撞（kinematic 胶囊推球）+ 转播镜头
export const PLAYER_COL = { RADIUS: 0.34, HALF: 0.55, Y: 0.9, SEP: 0.92 }; // SEP=球员最小中心距
export const KEY_BIG = new Set<string>(['goal', 'penalty_goal', 'shootout_goal', 'shootout_win']); // 大事件
export const BROADCAST = { SLOW_MS: 2600, SHAKE_MS: 700, ZOOM_D: 11, ZOOM_H: 17, SHAKE: 0.55 };

// Catmull-Rom 1D：过 P1→P2 段（u∈[0,1]），切向由相邻点 P0/P3 决定 → 曲线过最近 3-4 个事件点
function catmullRom1D(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * u +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * u3
  );
}

function eventIndexAt(events: MatchEvent[], t: number): number {
  let lo = 0, hi = events.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// ---- 阵型跑位（表现层，事件流驱动）：进攻 2-3-2-1 围绕球展开 / 防守压缩布防 / 无球前插·回追 ----
// 偏移表：fwd 沿进攻方向为正（进攻=朝对方球门；防守=朝本方球门回撤深度），side 为横向
const ATT_OFFS: [number, number][] = [
  [-4, -4.5], [-4, 4.5],        // 后卫 ×2：球后一层
  [-2, 0], [-3, -8], [-3, 8],   // 中场 ×3：中路靠后 + 双边拉开
  [5, -6.5], [5, 6.5],          // 前腰 ×2：球前一层
  [10, 0],                      // 前锋 ×1：最前
];
const DEF_OFFS: [number, number][] = [
  [3, -3.5], [3, 3.5],          // 后卫线贴近球
  [7.5, 0], [9, -5.5], [9, 5.5],// 中场回撤
  [14, -4.5], [14, 4.5],        // 前腰更深
  [19, 0],                      // 前锋最深，护本方禁区
];
// 阵型随球的横向偏转权重：前场跟球、后场保持中轴（球在哪一侧阵型偏转）
const ATT_TILT = [0.5, 0.5, 0.6, 0.6, 0.6, 0.85, 0.85, 0.95];
const DEF_TILT = [0.8, 0.8, 0.6, 0.6, 0.6, 0.45, 0.45, 0.35];
// 长传/反击/球权转换类事件 → 触发无球前插与回追
const RUN_TRIGGERS = new Set([
  'pass', 'tackle', 'throwin', 'kickoff', 'goal',
  'penalty_goal', 'penalty_miss', 'shot', 'violation', 'offside',
]);

interface RunState {
  until: number; // 真实毫秒时间戳，到点自动回位
  tx: number;    // 跑位目标（游戏坐标）
  ty: number;
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
  private world?: RAPIER.World;
  private ballBody?: RAPIER.RigidBody;
  private playerBodies: RAPIER.RigidBody[] = [];
  private slowUntil = 0;   // 真实毫秒：大事件慢放窗口（推近镜头）
  private shakeUntil = 0;  // 真实毫秒：进球震动窗口
  private shakeAmp = 0;
  private followTarget = new THREE.Vector3(0, 0, 0);
  private prevBall = new THREE.Vector3(); // 上一帧球位（镜头提前量用有限差分速度）
  private clock = 0;
  private lastNow = 0;
  private interacting = false;
  private observer: ResizeObserver;
  private disposed = false;
  private disposables: { dispose(): void }[] = [];
  private actorNames: [string[], string[]];
  private runs: (RunState | null)[] = new Array(18).fill(null);
  private lastIdx = -1;

  constructor(container: HTMLElement, teams: [Team, Team], events: MatchEvent[]) {    this.events = events;
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
      this.prevBall.copy(this.ball.position);
      const layout = this.layoutTeams(e0.team === 0 ? 0 : 1, bx, by, 0);
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

  // ---------- 物理（Rapier 异步初始化） ----------

  static async create(container: HTMLElement, teams: [Team, Team], events: MatchEvent[]): Promise<MatchScene> {
    await RAPIER.init();
    const scene = new MatchScene(container, teams, events);
    scene.initPhysics();
    return scene;
  }

  private initPhysics(): void {
    this.world = new RAPIER.World({ x: 0, y: PHYS.GRAVITY, z: 0 });
    // 地面（略大防边界穿出；球被 PD 吸附回场内）
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(HALF_W + 4, 0.5, HALF_H + 4).setFriction(0.6), ground);
    // 球：动态刚体，弱线性阻尼（滚动滑行）
    const p = this.ball.position;
    this.ballBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, Math.max(BALL_R, p.y), p.z)
        .setLinearDamping(0.55)
        .setAngularDamping(0.85),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(BALL_R).setRestitution(PHYS.RESTITUTION).setFriction(0.5),
      this.ballBody,
    );
    // 球员：kinematic 胶囊（推球/卡位），位置每帧由 layout+软分离驱动
    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < 9; i++) {
        const g = this.players[t * 9 + i].group.position;
        const body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(g.x, PLAYER_COL.Y, g.z),
        );
        this.world.createCollider(
          RAPIER.ColliderDesc.capsule(PLAYER_COL.HALF, PLAYER_COL.RADIUS).setFriction(0.4),
          body,
        );
        this.playerBodies.push(body);
      }
    }
  }

  // 跨入新事件段：给球一个沿 起点→终点 的真实初速（踢出冲量，之后力驱动修正）；
  // 若所需速度超上限（跳节/大步进）→ 直接落位（干净跳转）
  private kickBall(from: MatchEvent, to?: MatchEvent): void {
    if (!to || !this.ballBody || !this.world) return;
    const fromP = this.ballBody.translation();
    const toP = new THREE.Vector3(wx(to.x), BALL_R, wz(to.y));
    const dist = Math.hypot(toP.x - fromP.x, toP.z - fromP.z);
    if (dist < 0.4) return;
    const span = Math.max(0.3, (to.t - from.t) / PLAYBACK.TIME_SCALE); // 真实秒
    const v = dist / span;
    if (v > PHYS.MAX_V * 0.92) {
      this.ballBody.setTranslation({ x: toP.x, y: BALL_R, z: toP.z }, true);
      this.ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      return;
    }
    const dx = toP.x - fromP.x, dz = toP.z - fromP.z;
    const len = Math.hypot(dx, dz);
    let vy = 0;
    if (PLAYBACK.ARC.TYPES.has(to.type) && dist >= PLAYBACK.ARC.MIN_DIST) {
      const h = Math.min(PLAYBACK.ARC.MAX_H, dist * PLAYBACK.ARC.RATE);
      vy = Math.sqrt(2 * -PHYS.GRAVITY * h);
    }
    this.ballBody.setLinvel({ x: (dx / len) * v, y: vy, z: (dz / len) * v }, true);
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

  // ---------- 阵型跑位（表现层） ----------

  // 确定性伪随机（由事件下标派生，回放稳定）
  private hash2(a: number, b: number): number {
    let h = (a * 374761393 + b * 668265263) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = (h * 1274126177) | 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  // 事件驱动无球跑位：进攻方前锋必插 + 一名边前腰前插，防守方 1 名后卫回追
  private maybeTriggerRuns(idx: number, e: MatchEvent, now: number): void {
    if (!RUN_TRIGGERS.has(e.type)) return;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const att: 0 | 1 = e.team === 0 ? 0 : 1;
    const def = (1 - att) as 0 | 1;
    const dirF = att === 0 ? 1 : -1; // 进攻推进方向
    const dur = 850 + (this.hash2(idx, 7) % 500); // 0.85~1.35 真实秒，任何倍速/暂停都可见
    const r01 = (k: number) => (this.hash2(idx, k) % 1000) / 1000;

    // 前锋前插（必触发），向对方球门冲刺
    this.runs[att * 9 + 8] = {
      until: now + dur,
      tx: clamp(e.x + dirF * (15 + r01(1) * 6), 2, FIELD_W - 2),
      ty: clamp(e.y + (r01(2) - 0.5) * 7, 2, FIELD_H - 2),
    };
    // 一名边前腰（左右交替）沿边路前插
    const wide = this.hash2(idx, 3) % 2 === 0 ? 6 : 7;
    this.runs[att * 9 + wide] = {
      until: now + dur * 0.85,
      tx: clamp(e.x + dirF * (10 + r01(5) * 5), 2, FIELD_W - 2),
      ty: clamp(e.y + (wide === 6 ? -6 : 6) + (r01(6) - 0.5) * 3, 2, FIELD_H - 2),
    };
    // 防守方 1 名后卫回追，向本方球门方向收
    const df = (this.hash2(idx, 9) % 2) + 1;
    this.runs[def * 9 + df] = {
      until: now + dur * 1.1,
      tx: clamp(e.x + dirF * 8, 2, FIELD_W - 2),
      ty: clamp(HALF_H + (e.y - HALF_H) * 0.4, 2, FIELD_H - 2),
    };
  }

  // 阵型落位：控球方以球为中心展开攻击阵型（纵深分层 + 横向拉开 + 随球偏转），
  // 防守方在球与己方球门之间压缩布防（保持 2-3-2-1 相对结构）；无球跑位覆盖对应球员，跑完回位
  private layoutTeams(possession: 0 | 1, bx: number, by: number, now: number): { x: number; y: number }[][] {
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const dirF = possession === 0 ? 1 : -1; // 控球方推进方向
    const out: { x: number; y: number }[][] = [[], []];
    for (const t of [0, 1] as const) {
      const isAtt = t === possession;
      const gkX = t === 0 ? 2.5 : FIELD_W - 2.5;
      // 门将永远留守本方球门，仅随球小幅横向移动
      out[t][0] = {
        x: gkX,
        y: clamp(HALF_H + (by - HALF_H) * 0.3, HALF_H - 3.5, HALF_H + 3.5),
      };
      const offs = isAtt ? ATT_OFFS : DEF_OFFS;
      const tilts = isAtt ? ATT_TILT : DEF_TILT;
      for (let i = 1; i <= 8; i++) {
        const [fo, so] = offs[i - 1];
        const ay = HALF_H + (by - HALF_H) * tilts[i - 1]; // 球在哪一侧，该层随之偏转
        let tx = bx + dirF * fo;
        let ty = ay + so;
        const run = this.runs[t * 9 + i];
        if (run && now < run.until) { tx = run.tx; ty = run.ty; }
        out[t][i] = { x: clamp(tx, 1.5, FIELD_W - 1.5), y: clamp(ty, 1.5, FIELD_H - 1.5) };
      }
    }
    return out;
  }

  // 球员间软分离（卡位推挤）：两轮迭代两两推开，原地修改 layout 目标
  private separatePlayers(layout: { x: number; y: number }[][]): void {
    const d = PLAYER_COL.SEP;
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < 18; a++) {
        const ta = a < 9 ? 0 : 1, ia = a % 9;
        for (let b = a + 1; b < 18; b++) {
          const tb = b < 9 ? 0 : 1, ib = b % 9;
          const pa = layout[ta][ia], pb = layout[tb][ib];
          const dx = pb.x - pa.x, dy = pb.y - pa.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 1e-4 && dist < d) {
            const push = (d - dist) / 2;
            const nx = dx / dist, ny = dy / dist;
            pa.x -= nx * push; pa.y -= ny * push;
            pb.x += nx * push; pb.y += ny * push;
          }
        }
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

    // 连续时间轴：段内比例 u∈[0,1]（时间间隔不均匀也按真实秒比例穿过），再用 easeInOut 缓动
    let u = 0;
    if (nxt) {
      const span = Math.max(1e-6, nxt.t - cur.t);
      u = Math.min(1, Math.max(0, (t - cur.t) / span));
    }
    const ease = PLAYBACK.EASE(u);

    // 球：Catmull-Rom 曲线过最近 3-4 个事件点 + 缓动采样 + 轻微高度弧（长传/空中球类）
    const p0 = events[Math.max(0, idx - 1)];
    const p3 = events[Math.min(events.length - 1, idx + 2)];
    const p1 = cur, p2 = nxt ?? cur;
    const bx = catmullRom1D(p0.x, p1.x, p2.x, p3.x, ease);
    const by = catmullRom1D(p0.y, p1.y, p2.y, p3.y, ease);
    let arc = 0;
    if (nxt) {
      const dist = Math.hypot(nxt.x - cur.x, nxt.y - cur.y);
      if (dist >= PLAYBACK.ARC.MIN_DIST && PLAYBACK.ARC.TYPES.has(nxt.type)) {
        arc = Math.min(PLAYBACK.ARC.MAX_H, dist * PLAYBACK.ARC.RATE) * Math.sin(Math.PI * ease);
      }
    }
    const pulse = Math.max(0, Math.min(5, Math.round(cur.pulse)));
    const possession: 0 | 1 = cur.team === 0 ? 0 : 1;

    // 事件驱动无球跑位 + 物理球踢出：跨入新事件时触发
    const dt = Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    this.clock += dt;

    if (idx !== this.lastIdx) {
      this.lastIdx = idx;
      this.maybeTriggerRuns(idx, cur, now);
      this.kickBall(cur, nxt);
      // 转播：大事件 → 慢放窗口（推近）+ 进球震动
      if (KEY_BIG.has(cur.type)) {
        this.slowUntil = now + BROADCAST.SLOW_MS;
        this.shakeUntil = now + BROADCAST.SHAKE_MS;
        this.shakeAmp = BROADCAST.SHAKE;
      }
    }

    // 物理球：目标 = 轨迹采样点；弹簧-阻尼力拉向目标（质量感/惯性），重力+反弹保弧线，
    // 近点吸附防漂移（保证事件起点精确）
    if (this.world && this.ballBody) {
      const target = new THREE.Vector3(wx(bx), BALL_R + arc, wz(by));
      const pos = this.ballBody.translation();
      const pv = this.ballBody.linvel();
      this.ballBody.addForce(
        {
          x: (target.x - pos.x) * PHYS.K_F - pv.x * PHYS.DAMP,
          y: (target.y - pos.y) * PHYS.K_FY - pv.y * PHYS.DAMP,
          z: (target.z - pos.z) * PHYS.K_F - pv.z * PHYS.DAMP,
        },
        true,
      );
      const steps = Math.max(1, Math.round(dt * 60));
      for (let i = 0; i < steps; i++) this.world.step();
      const bpos = this.ballBody.translation();
      const snap = u >= 0.985 || Math.hypot(target.x - bpos.x, target.z - bpos.z) < PHYS.SNAP_DIST;
      if (snap) {
        this.ballBody.setTranslation({ x: target.x, y: target.y, z: target.z }, true);
        this.ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
      this.ball.position.set(bpos.x, bpos.y, bpos.z);
      // 滚动自转：沿水平速度方向滚（角速度 = 线速度 / 半径）
      const hsp = Math.hypot(pv.x, pv.z);
      if (hsp > 0.3 && !snap) {
        const ang = (hsp / BALL_R) * dt;
        this.ball.rotateOnWorldAxis(new THREE.Vector3(-pv.z, 0, pv.x).normalize(), ang);
      }
    }

    const pc = new THREE.Color(PULSE_COLORS[pulse]);
    this.ballMat.emissive.copy(pc);
    this.haloMat.color.copy(pc);
    const hs = 1 + 0.3 * Math.sin(this.clock * 5);
    this.halo.scale.setScalar(hs);
    this.halo.position.copy(this.ball.position);

    // 球速（世界单位/秒，有限差分；镜头提前量用，跳转/步进时自然被钳制）
    const bdt = Math.max(1e-4, dt);
    const bvx = (this.ball.position.x - this.prevBall.x) / bdt;
    const bvz = (this.ball.position.z - this.prevBall.z) / bdt;
    this.prevBall.copy(this.ball.position);

    // 球员：目标 = 缓动球位上的阵型（随 easeInOut 球位滑动，段内加速-减速）
    // + 软分离卡位 + 位置缓动跟随 + 面向移动方向 + 摆腿 + kinematic 碰撞体同步（推球）
    const layout = this.layoutTeams(possession, bx, by, now);
    this.separatePlayers(layout);
    for (let t2 = 0; t2 < 2; t2++) {
      for (let i = 0; i < 9; i++) {
        const p = layout[t2][i];
        const rig = this.players[t2 * 9 + i];
        const g = rig.group.position;
        const tx = wx(p.x), tz = wz(p.y);
        const prev = rig.prevTarget;
        const v = dt > 1e-4 ? prev.distanceTo(new THREE.Vector3(tx, 0, tz)) / dt : 0;
        prev.set(tx, 0, tz);

        const runSt = this.runs[t2 * 9 + i];
        const isRun = !!runSt && now < runSt.until;
        const kP = 1 - Math.exp(-dt * (isRun ? 11 : 6));
        g.x += (tx - g.x) * kP;
        g.z += (tz - g.z) * kP;

        // 摆腿：sin 相位 × 速度
        const amp = Math.min(0.95, v * 0.2) * (isRun ? 1.25 : 1);
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

        // 同步 kinematic 碰撞体（推球/卡位）
        const body = this.playerBodies[t2 * 9 + i];
        if (body) body.setNextKinematicTranslation({ x: g.x, y: PLAYER_COL.Y, z: g.z });
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
      // 转播镜头：大事件慢放窗口内推近（更低更近），否则默认俯视
      const zoom = now < this.slowUntil;
      const ch = zoom ? BROADCAST.ZOOM_H : CAM_H;
      const cd = zoom ? BROADCAST.ZOOM_D : CAM_D;
      const ideal = new THREE.Vector3(this.followTarget.x, ch, this.followTarget.z + cd);
      this.camera.position.lerp(ideal, 1 - Math.exp(-dt * (zoom ? 6 : 3)));
      // 进球震动：相机加衰减随机偏移
      if (now < this.shakeUntil) {
        const t0 = this.shakeUntil - BROADCAST.SHAKE_MS;
        const a = this.shakeAmp * (1 - (now - t0) / BROADCAST.SHAKE_MS);
        this.camera.position.x += (Math.random() - 0.5) * a;
        this.camera.position.y += (Math.random() - 0.5) * a * 0.6;
      }
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
    if (this.world) { try { this.world.free(); } catch { /* 已释放 */ } }
    this.renderer.domElement.remove();
  }
}
