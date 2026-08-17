/**
 * 国家数据（v0.4）：8 国全可玩。数值取自《世界观-卡尔特.md》与 render_admin.py 配色。
 *  - 人口/识字率/政体/经济特征/初始资源禀赋按世界观；
 *  - 初始阶级分布见 classes.ts INITIAL_CLASS_MIX；种族构成见 pops.ts NATION_RACE_MIX；
 *  - 初始资源禀赋由地图资源（data/resources.json 按大陆块）自动派生；
 *  - 税率默认值（taxDefaults）按国家经济特征（帝国/诺曼尼亚重地税、奥兰治/盎格伦撒重关税与特别税）。
 */
import type { NationId } from './types';
import type { TaxKind } from './tax';

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
  /** 五税种默认税率（0-0.3） */
  taxDefaults: Partial<Record<TaxKind, number>>;
}

export const NATIONS: Record<NationId, NationDef> = {
  empire: {
    id: 'empire',
    name: '申斯戈维克帝国',
    gov: '君主专制',
    race: '乌萨斯族 80% / 德拉科族 15%',
    popWan: 2000,
    literacy: 0.1,
    treasury: 5000,
    stability: 65,
    foodMonths: 6,
    rgb: [150, 40, 45],
    color: '#96282d',
    economy: '最大国家，农奴制；煤铁毛皮并称帝国双宝',
    description: '广袤而寒冷的帝国，铁脊山脉的煤铁与北境毛皮支撑其霸权。农奴制下的乌萨斯底层与德拉科官僚暗流涌动，识字率极低。',
    sliderMax: 500,
    defaultSpending: { military: 80, admin: 40, infra: 30 },
    taxDefaults: { land: 0.2, poll: 0.15, consumption: 0.1, tariff: 0.1, other: 0.05 },
  },
  lorraine: {
    id: 'lorraine',
    name: '洛林共和国',
    gov: '总统共和',
    race: '菲林族 95%',
    popWan: 1200,
    literacy: 0.3,
    treasury: 800,
    stability: 70,
    foodMonths: 6,
    rgb: [70, 110, 200],
    color: '#466ec8',
    economy: '最先进思想中心，工业化起步；暖流渔场与良港希米尔',
    description: '南大陆西岸的共和制国家，菲林族的家园。启蒙思想与新兴工业在此交汇，市民与工人阶层主导议会。',
    sliderMax: 300,
    defaultSpending: { military: 40, admin: 30, infra: 20 },
    taxDefaults: { land: 0.1, poll: 0.12, consumption: 0.12, tariff: 0.15, other: 0.1 },
  },
  ianys: {
    id: 'ianys',
    name: '伊尼亚斯王国',
    gov: '君主立宪',
    race: '黎博利族 90%',
    popWan: 1300,
    literacy: 0.24,
    treasury: 1200,
    stability: 55,
    foodMonths: 6,
    rgb: [200, 170, 60],
    color: '#c8aa3c',
    economy: '工业革命肇始地，宪政传统；东岸煤铁与棉田',
    description: '南大陆东岸的宪政王国。纺织业萌芽与议会传统并立，工人/工匠/资本家势力崛起，与帝国争夺铁脊煤矿。',
    sliderMax: 300,
    defaultSpending: { military: 40, admin: 25, infra: 20 },
    taxDefaults: { land: 0.12, poll: 0.12, consumption: 0.12, tariff: 0.12, other: 0.08 },
  },
  orange: {
    id: 'orange',
    name: '奥兰治亲王国',
    gov: '立宪首相制',
    race: '阿戈尔族 80%',
    popWan: 130,
    literacy: 0.36,
    treasury: 400,
    stability: 66,
    foodMonths: 6,
    rgb: [230, 140, 40],
    color: '#e68c28',
    economy: '造船与贸易立国，殖民新大陆的先锋；海峡地利',
    description: '盐海东南岸的滨海亲王国，阿戈尔航海民族的家园。船坞、商船队与殖民航线是它的命脉，商业税基厚重。',
    sliderMax: 120,
    defaultSpending: { military: 20, admin: 15, infra: 15 },
    taxDefaults: { land: 0.08, poll: 0.1, consumption: 0.12, tariff: 0.18, other: 0.15 },
  },
  zalakN: {
    id: 'zalakN',
    name: '北扎拉克选帝侯国',
    gov: '选帝侯制',
    race: '扎拉克族 95%',
    popWan: 500,
    literacy: 0.18,
    treasury: 600,
    stability: 60,
    foodMonths: 6,
    rgb: [90, 160, 90],
    color: '#5aa05a',
    economy: '工业萌芽+民族主义；河谷粮仓与盐税',
    description: '扎拉克诸邦之北，河谷粮仓哺育的选帝侯国。民族主义思潮兴起，与南扎拉克争夺迈森自由市，工业刚刚萌芽。',
    sliderMax: 200,
    defaultSpending: { military: 30, admin: 20, infra: 15 },
    taxDefaults: { land: 0.15, poll: 0.14, consumption: 0.1, tariff: 0.12, other: 0.08 },
  },
  zalakS: {
    id: 'zalakS',
    name: '南扎拉克选帝侯国',
    gov: '选帝侯制',
    race: '扎拉克族 95%',
    popWan: 500,
    literacy: 0.3,
    treasury: 600,
    stability: 58,
    foodMonths: 6,
    rgb: [60, 140, 140],
    color: '#3c8c8c',
    economy: '工业萌芽+民族主义；识字率高于北方，迈森之争',
    description: '扎拉克诸邦之南，工商业与识字率略胜北方。与北扎拉克的选帝侯之争、对洛林/奥兰治的"外族压迫"叙事，让民族主义成为双刃剑。',
    sliderMax: 200,
    defaultSpending: { military: 30, admin: 25, infra: 15 },
    taxDefaults: { land: 0.15, poll: 0.14, consumption: 0.1, tariff: 0.12, other: 0.08 },
  },
  angland: {
    id: 'angland',
    name: '盎格伦撒自由城邦',
    gov: '商人共和',
    race: '阿戈尔 45% / 萨卡兹 20% / 各族混居',
    popWan: 36,
    literacy: 0.44,
    treasury: 400,
    stability: 72,
    foodMonths: 6,
    rgb: [140, 90, 180],
    color: '#8c5ab4',
    economy: '世界金融中心，证券交易发祥；扼守海峡要冲',
    description: '东部群岛上的商人共和城邦，阿戈尔与各族混居。银行家与商人执掌权柄，识字率冠绝卡尔特，资源依赖进口而资本雄厚。',
    sliderMax: 120,
    defaultSpending: { military: 12, admin: 20, infra: 12 },
    taxDefaults: { land: 0.05, poll: 0.08, consumption: 0.12, tariff: 0.2, other: 0.15 },
  },
  normandy: {
    id: 'normandy',
    name: '诺曼尼亚帝国',
    gov: '君主独裁',
    race: '诺曼族 85%',
    popWan: 1500,
    literacy: 0.18,
    treasury: 900,
    stability: 52,
    foodMonths: 6,
    rgb: [120, 30, 60],
    color: '#781e3c',
    economy: '守旧落后；精耕农业与南岸渔场，农奴残留',
    description: '南大陆南端的古老帝国，诺曼族的故土。地主与官僚把持朝政，农奴制残留，技术革新缓慢，萨卡兹问题悬而未决。',
    sliderMax: 300,
    defaultSpending: { military: 50, admin: 20, infra: 15 },
    taxDefaults: { land: 0.2, poll: 0.16, consumption: 0.08, tariff: 0.08, other: 0.05 },
  },
};

export const NATION_LIST: NationDef[] = [
  NATIONS.empire,
  NATIONS.lorraine,
  NATIONS.ianys,
  NATIONS.orange,
  NATIONS.zalakN,
  NATIONS.zalakS,
  NATIONS.angland,
  NATIONS.normandy,
];

export const UNDISCOVERED_RGB: [number, number, number] = [34, 44, 60];
export const UNDISCOVERED_COLOR = '#222c3c';
