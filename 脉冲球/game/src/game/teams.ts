// 球队：9 人制 2-3-2-1（门将/后卫2/中场3/前腰2/前锋1），端明ちゃん风格队名
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

export const FORMATION: Position[] = ['GK', 'DF', 'DF', 'MF', 'MF', 'MF', 'AM', 'AM', 'FW'];

const IMPERIAL = ['洛伦茨', '卡尔海因茨', '迪特里希', '施特凡', '弗里德里希', '汉斯', '沃尔夫冈', '康拉德', '奥托'];
const LORRAINE = ['让', '皮埃尔', '吕克', '米歇尔', '安托万', '克洛德', '菲利普', '巴蒂斯特', '阿尔诺'];

export function createTeam(rng: RNG, name: string, short: string, names: string[]): Team {
  const players: Player[] = FORMATION.map((pos, i) => ({
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

export function createDefaultTeams(seed: number): [Team, Team] {
  const rng = mulberry32(seed);
  const a = createTeam(rng, '帝国', '帝国', IMPERIAL);
  const b = createTeam(rng, '洛林', '洛林', LORRAINE);
  return [a, b];
}
