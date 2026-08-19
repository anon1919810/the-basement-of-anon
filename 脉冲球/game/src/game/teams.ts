// 球队：9 人制（1 门将 + 8 场上），位置四类 GK/DF/MF/FW
// 阵型预设：平衡 1-3-3-2 / 中场控制 1-2-4-1 / 防守 1-4-3-1 / 快反 1-2-3-2
import type { RNG } from './rng';
import { mulberry32 } from './rng';
import type { Position } from './attributes';
import { randomAttributes, type Attributes } from './attributes';

export interface Player {
  id: number;
  name: string;
  number: number;
  position: Position;
  attrs: Attributes;
}

export interface Team {
  name: string;
  short: string;
  players: Player[];
  tactics: { aerial: number; pressing: number; line: number };
}

export type FormationName = '平衡' | '中场控制' | '防守' | '快反';

export const FORMATIONS: Record<FormationName, Position[]> = {
  '平衡': ['GK', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW', 'FW'],
  '中场控制': ['GK', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'FW'],
  '防守': ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW'],
  '快反': ['GK', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW', 'FW'],
};

const IMPERIAL = ['洛伦茨', '卡尔海因茨', '迪特里希', '施特凡', '弗里德里希', '汉斯', '沃尔夫冈', '康拉德', '奥托'];
const LORRAINE = ['让', '皮埃尔', '吕克', '米歇尔', '安托万', '克洛德', '菲利普', '巴蒂斯特', '阿尔诺'];

export function createTeam(
  rng: RNG,
  name: string,
  short: string,
  names: string[],
  formation: Position[] = FORMATIONS['平衡'],
): Team {
  const players: Player[] = formation.map((pos, i) => ({
    id: i,
    name: names[i],
    number: i + 1,
    position: pos,
    attrs: randomAttributes(rng, pos),
  }));
  return {
    name,
    short,
    players,
    tactics: {
      aerial: 0.62 + rng() * 0.2,
      pressing: 0.4 + rng() * 0.35,
      line: 0.45 + rng() * 0.3,
    },
  };
}

export function createDefaultTeams(seed: number, formation?: Position[]): [Team, Team] {
  const rng = mulberry32(seed);
  const a = createTeam(rng, '帝国', '帝国', IMPERIAL, formation);
  const b = createTeam(rng, '洛林', '洛林', LORRAINE, formation);
  return [a, b];
}
