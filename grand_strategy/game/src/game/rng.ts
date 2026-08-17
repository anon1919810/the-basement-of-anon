/**
 * 确定性随机数：mulberry32（同种子 → 同序列）。
 * 所有游戏逻辑的随机性必须经由 Rng，禁止 Math.random / Date.now。
 */
export class Rng {
  /** 32 位有符号状态，可 JSON 序列化后复原 */
  state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  /** 下一个 [0,1) 均匀随机数 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, maxExclusive) 整数 */
  int(min: number, maxExclusive: number): number {
    return min + Math.floor(this.next() * (maxExclusive - min));
  }

  /** 概率判定 */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** 从数组中按权重取一 */
  pickWeighted<T>(items: readonly T[], weight: (item: T) => number): T {
    let total = 0;
    for (const it of items) total += Math.max(0, weight(it));
    let roll = this.next() * total;
    for (const it of items) {
      roll -= Math.max(0, weight(it));
      if (roll <= 0) return it;
    }
    return items[items.length - 1];
  }
}
