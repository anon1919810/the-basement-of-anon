/**
 * 国家数据：取自《世界观-卡尔特.md》与 render_admin.py 配色。
 * 数值为 v0.0.0 初稿（经济数值在 economy.ts 定标）。
 */
import type { NationId } from './types';

export interface NationDef {
  id: NationId;
  name: string;
  gov: string; // 政体
  race: string; // 主体种族
  popWan: number; // 初始人口（万人）
  literacy: number; // 初始识字率 0-1
  treasury: number; // 初始国库（万₭）
  stability: number; // 初始稳定度 0-100
  foodMonths: number; // 初始粮食储备（月消耗倍数）
  rgb: [number, number, number]; // 地图色
  color: string; // CSS 色
  economy: string; // 经济特点（世界观）
  description: string;
  sliderMax: number; // 支出滑杆上限（万₭/月）
  defaultSpending: { military: number; admin: number; infra: number };
}

export const NATIONS: Record<NationId, NationDef> = {
  lorraine: {
    id: 'lorraine',
    name: '洛林共和国',
    gov: '总统共和',
    race: '菲林族 95%',
    popWan: 1200,
    literacy: 0.55,
    treasury: 800,
    stability: 70,
    foodMonths: 6,
    rgb: [70, 110, 200],
    color: '#466ec8',
    economy: '最先进思想中心，工业化起步；暖流渔场与良港希米尔',
    description: '南大陆西岸的共和制国家，菲林族的家园。启蒙思想与新兴工业在此交汇，识字率冠绝卡尔特。',
    sliderMax: 300,
    defaultSpending: { military: 40, admin: 30, infra: 20 },
  },
  ianys: {
    id: 'ianys',
    name: '伊尼亚斯王国',
    gov: '君主立宪',
    race: '黎博利族 90%',
    popWan: 1300,
    literacy: 0.48,
    treasury: 1200,
    stability: 55,
    foodMonths: 6,
    rgb: [200, 170, 60],
    color: '#c8aa3c',
    economy: '工业革命肇始地，宪政传统；季风雨与棉田',
    description: '南大陆东岸的宪政王国。纺织业萌芽与议会传统并立，但领土狭小、人口稠密，季风年景决定仓廪盈虚。',
    sliderMax: 300,
    defaultSpending: { military: 40, admin: 25, infra: 20 },
  },
  empire: {
    id: 'empire',
    name: '申斯戈维克帝国',
    gov: '君主专制',
    race: '乌萨斯族 80% / 德拉科族 15%',
    popWan: 2000,
    literacy: 0.32,
    treasury: 5000,
    stability: 65,
    foodMonths: 6,
    rgb: [150, 40, 45],
    color: '#96282d',
    economy: '最大国家，农奴制；煤铁毛皮并称帝国双宝',
    description: '广袤而寒冷的帝国，铁脊山脉的煤铁与北境毛皮支撑其霸权。农奴制下的乌萨斯底层与德拉科官僚暗流涌动。',
    sliderMax: 500,
    defaultSpending: { military: 80, admin: 40, infra: 30 },
  },
};

export const NATION_LIST: NationDef[] = [NATIONS.lorraine, NATIONS.ianys, NATIONS.empire];

export const UNDISCOVERED_RGB: [number, number, number] = [34, 44, 60];
export const UNDISCOVERED_COLOR = '#222c3c';
