// 无头模拟：seed 42 跑一场，断言规则落地 + 确定性
// 运行：cmd /c "npx.cmd tsx scripts/sim.ts"
import { simulateMatch } from '../src/game/engine';

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failed = true;
    console.error(`✗ FAIL: ${msg}`);
  } else {
    console.log(`✓ ${msg}`);
  }
}

const seed = 42;
const r1 = simulateMatch(seed);
const r2 = simulateMatch(seed);

// ---- 确定性 ----
assert(JSON.stringify(r1.events) === JSON.stringify(r2.events), '确定性：同种子两次事件序列完全一致');

// ---- 数据合法性 ----
assert(Number.isFinite(r1.finalScore[0]) && Number.isFinite(r1.finalScore[1]), '比分无 NaN');
assert(r1.events.length > 0, '事件流非空');

let noNaN = true, mono = true, pulseOk = true, posOk = true;
for (let i = 0; i < r1.events.length; i++) {
  const e = r1.events[i];
  if (!Number.isFinite(e.t) || !Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.pulse)) noNaN = false;
  if (e.pulse < 0 || e.pulse > 5) pulseOk = false;
  if (e.x < 0 || e.x > 65 || e.y < 0 || e.y > 40) posOk = false;
  if (i > 0 && e.t < r1.events[i - 1].t) mono = false;
}
assert(noNaN, '所有事件字段无 NaN');
assert(mono, '事件时间单调不减');
assert(pulseOk, '脉冲始终 ∈ [0, 5]');
assert(posOk, '事件坐标在场地内');

// ---- 节末规则 ----
assert(r1.periods.length >= 1 && r1.periods.length <= 3, '节数合法（金球可提前结束）');
const otStarts = r1.events.filter((e) => e.type === 'overtime_start').length;
const tiedPeriods = r1.periods.filter((p) => p.overtime !== undefined).length;
assert(otStarts === tiedPeriods, '每个平局节末都触发了加时检查点');
if (r1.finalScore[0] === r1.finalScore[1]) {
  assert(r1.shootout !== null, '终场平局 → 必有加时/点球');
}
assert(r1.winner !== null, '比赛必有胜者（金球或点球决出）');
assert(
  r1.events.some((e) => e.period === 3) || r1.finalScore[0] !== r1.finalScore[1],
  '三节结束规则生效（平局 → 加时/点球 或 分差定胜负）',
);

// ---- 终场一致 ----
const last = r1.events[r1.events.length - 1];
assert(JSON.stringify(r1.finalScore) === JSON.stringify(last.score), '终场比分与最后事件一致');
assert(r1.stats.maxPulse >= 0 && r1.stats.maxPulse <= 5, '统计最高脉冲合法');

// ---- 打印结果 ----
console.log('\n===== 无头模拟结果（seed 42）=====');
console.log(
  `比分：${r1.teams[0].name} ${r1.finalScore[0]} : ${r1.finalScore[1]} ${r1.teams[1].name}` +
  `（胜者：${r1.winner === null ? '无' : r1.teams[r1.winner].name}）`,
);
console.log(
  `事件数：${r1.events.length}　最高脉冲：${r1.stats.maxPulse}　` +
  `射门：${r1.stats.shots[0] + r1.stats.shots[1]}（${r1.stats.shots[0]}/${r1.stats.shots[1]}）　` +
  `成功传球：${r1.stats.passes[0] + r1.stats.passes[1]}　犯规：${r1.stats.fouls[0] + r1.stats.fouls[1]}`,
);
console.log(
  `各节：${r1.periods.map((p) => `${p.name} ${p.score[0]}:${p.score[1]}${p.overtime ? '(' + p.overtime + ')' : ''}`).join('　')}`,
);
console.log(`加时：${r1.events.some((e) => e.period === 3) ? '有' : '无'}　点球大战：${r1.shootout ? '有' : '无'}${r1.shootout ? `（${r1.shootout.score[0]} : ${r1.shootout.score[1]}，${r1.shootout.kicks.length} 罚）` : ''}`);
console.log(`脉冲范围：[${Math.min(...r1.events.map((e) => e.pulse))}, ${Math.max(...r1.events.map((e) => e.pulse))}]`);

if (failed) {
  console.error('\n✗ 存在失败的断言');
  process.exit(1);
} else {
  console.log('\n✓✓✓ 全部断言通过');
}
