/**
 * 政治系统（v0.10，两大支柱）：
 * ①权力分配与行政体制 —— 政权结构（谁统治/合法性/行政效率）+ 行政力（容量 vs 消耗 → 效率修正）
 * ②改革与法律 —— 5 类法律谱系（政权/选举/人身自由/经济/权利），立法推进（支持率×合法性×行政效率）
 *
 * 设计要点：
 *  - 政权结构决定「执政联盟」：联盟权势占比 → 合法性；非联盟阶级反对改革
 *  - 选举法 6 档并列（无高低承接）：各服务不同利益集团，改写阶级政治权重
 *  - 人身自由 3 档：农奴制 / 债务奴隶（生活水平暴跌可沦为债务奴、可偿债脱离）/ 废奴
 *  - 经济 3 档并入现有 economicLaw；权利法影响生活水平下限与幸福度
 *  - 立法：玩家提出 → 月推进 = 支持率% × 合法性% × 行政效率 × 0.15 → 满 100 通过；支持率过低倒退
 */
import type { ClassId, JobId, NationId } from './types';
import { classPoliticalWeight } from './classes';
import type { GameMap } from './map';
import type { GameState } from './state';

// ---- ①政权结构 ----
export type GovStructure = 'autocracy' | 'monarchy' | 'merchantRepublic' | 'parliamentary' | 'presidential';

export interface GovDef {
  id: GovStructure;
  label: string;
  /** 执政联盟阶级（权势加权 → 合法性） */
  rulingClasses: ClassId[];
  /** 合法性基础系数（× 执政联盟权势占比） */
  legitimacyBase: number;
  /** 行政效率系数（官僚体系统治越集权越低效） */
  adminEff: number;
  /** 治理复杂度（行政消耗放大；法律越多越费） */
  complexity: number;
  desc: string;
}

export const GOV_DEFS: Record<GovStructure, GovDef> = {
  autocracy: {
    id: 'autocracy', label: '君主专制', rulingClasses: [1], legitimacyBase: 0.8, adminEff: 0.85, complexity: 1.1,
    desc: '君权神授，贵族附庸。行政靠私人效忠，效率低下但令行禁止。',
  },
  monarchy: {
    id: 'monarchy', label: '君主立宪', rulingClasses: [1, 3], legitimacyBase: 0.9, adminEff: 0.95, complexity: 1.0,
    desc: '君主统而不治，贵族与官僚共治。行政稍有效率。',
  },
  merchantRepublic: {
    id: 'merchantRepublic', label: '商人共和', rulingClasses: [2, 3], legitimacyBase: 0.85, adminEff: 1.0, complexity: 0.95,
    desc: '银行家与商贾执政，金钱开路，行政高效但重商轻民。',
  },
  parliamentary: {
    id: 'parliamentary', label: '议会共和', rulingClasses: [3, 4], legitimacyBase: 1.0, adminEff: 1.05, complexity: 1.0,
    desc: '中产与市民执掌议会。行政效率良好，合法性稳定。',
  },
  presidential: {
    id: 'presidential', label: '总统共和', rulingClasses: [3, 4, 5], legitimacyBase: 1.1, adminEff: 1.1, complexity: 1.05,
    desc: '广泛选举的共和国，庶民亦可入朝。行政高效，但众口难调。',
  },
};

/** 各国初始政权（按世界观） */
export const INITIAL_GOV: Record<NationId, GovStructure> = {
  empire: 'autocracy',
  lorraine: 'presidential',
  ianys: 'monarchy',
  orange: 'merchantRepublic',
  zalakN: 'monarchy',
  zalakS: 'monarchy',
  angland: 'merchantRepublic',
  normandy: 'autocracy',
};

// ---- ②法律谱系 ----
export type LawCategory = 'gov' | 'suffrage' | 'liberty' | 'economy' | 'rights' | 'education' | 'health' | 'military' | 'policing' | 'press' | 'ethnic' | 'religion';

export interface LawTier {
  id: string;
  label: string;
  desc: string;
}

/** 各法律类当前档位索引 → 档位定义 */
export const LAW_TIERS: Record<LawCategory, LawTier[]> = {
  gov: [
    { id: 'autocracy', label: '君主专制', desc: '君权至上' },
    { id: 'monarchy', label: '君主立宪', desc: '君统而不治' },
    { id: 'merchantRepublic', label: '商人共和', desc: '商贾执政' },
    { id: 'parliamentary', label: '议会共和', desc: '议会掌权' },
    { id: 'presidential', label: '总统共和', desc: '庶民参政权' },
  ],
  // 选举法 6 档并列：无高低承接，各服务不同利益集团
  suffrage: [
    { id: 'hereditary', label: '权力世袭', desc: '选权由血统决定' },
    { id: 'oligarchy', label: '寡头政治', desc: '少数豪门议政' },
    { id: 'landed', label: '土地选举', desc: '有地产者投票' },
    { id: 'wealth', label: '财富选举', desc: '纳税达标者投票' },
    { id: 'merit', label: '资格性选举', desc: '识字/职业资格投票' },
    { id: 'universal', label: '普选', desc: '全体成年公民投票' },
  ],
  // 人身自由 3 档：债务奴隶（生活水平暴跌可沦为债务奴、可偿债脱离）
  liberty: [
    { id: 'serfdom', label: '农奴制', desc: '奴隶世代为奴' },
    { id: 'debt', label: '债务奴隶', desc: '生活水平暴跌者可沦为债务奴，可偿债脱离' },
    { id: 'free', label: '废奴', desc: '无奴隶' },
  ],
  economy: [
    { id: 'traditionalism', label: '传统主义', desc: '政府分红 -10%，投资效率低' },
    { id: 'laissezFaire', label: '自由放任', desc: '中性，资本效率 +25%' },
    { id: 'draconian', label: '农本主义', desc: '政府分红 +15%，农地投资 +50%' },
  ],
  rights: [
    { id: 'none', label: '无保障', desc: '民如草芥' },
    { id: 'basic', label: '基本权利', desc: '人身财产受保护' },
    { id: 'labor', label: '劳工保护', desc: '工时/工资下限受保护' },
  ],
  // 教育 4 档：按财富阶级提供识字率/幸福度修正（私立=上层获益，公立=全民）
  education: [
    { id: 'none', label: '无教育', desc: '文盲遍地' },
    { id: 'church', label: '教会学校', desc: '教士传道识字，上层略受益' },
    { id: 'private', label: '私立学校', desc: '学费门槛，富者受益' },
    { id: 'public', label: '公立学校', desc: '全民义务教育' },
  ],
  // 医疗 4 档：按财富阶级提供健康/幸福度修正
  health: [
    { id: 'none', label: '无医疗', desc: '生死由天' },
    { id: 'church', label: '教会医疗', desc: '教士施药，聊胜于无' },
    { id: 'private', label: '私人医疗', desc: '名医只为有钱人' },
    { id: 'public', label: '公立医疗', desc: '全民公共医疗' },
  ],
  // 国防 4 档：影响征兵/军费/战争动员 + 军队贵族政治力量
  military: [
    { id: 'peasant', label: '农兵制度', desc: '战时征农，战力弱，贵胄掌军' },
    { id: 'professional', label: '职业军队', desc: '常备军，战力中' },
    { id: 'conscript', label: '义务兵役', desc: '全民皆兵，动员强' },
    { id: 'mass', label: '大规模征募', desc: '全面战争动员，代价高' },
  ],
  // 治安 6 档：影响动乱压制 + 军队/贵族/官僚/地主政治力量
  policing: [
    { id: 'none', label: '无治安警察', desc: '乡里自保' },
    { id: 'local', label: '地方警察', desc: '县衙捕快' },
    { id: 'professional', label: '职业警察', desc: '国家警察力量' },
    { id: 'militarized', label: '军事化警察', desc: '军警一体，高压' },
    { id: 'secret', label: '秘密警察', desc: '监控渗透，官僚权重' },
    { id: 'guard', label: '国民警卫队', desc: '民兵常备，动员储备' },
  ],
  // 言论 4 档：配合警察制度修正满意度/识字率/政治力量
  press: [
    { id: 'gag', label: '异议者禁言', desc: '反对声入狱' },
    { id: 'censor', label: '出版审查', desc: '特许审批出版' },
    { id: 'licensed', label: '特许出版', desc: '持牌人可出版' },
    { id: 'free', label: '出版自由', desc: '言论不受预审' },
  ],
  // 民族 4 档（v0.14）：异文化/异宗教 POP 资质与工资负修正；主体民族按档位幸福
  ethnic: [
    { id: 'nationState', label: '族裔国家', desc: '异文化异宗教受重罚' },
    { id: 'segregation', label: '种族隔离', desc: '异文化受中罚' },
    { id: 'exclusion', label: '文化排斥', desc: '异文化轻罚，宗教惩罚消失' },
    { id: 'pluralism', label: '文化多元', desc: '无异文化惩罚' },
  ],
  // 宗教 4 档（v0.14）：教士权势/教会建筑效率/异教幸福惩罚
  religion: [
    { id: 'state', label: '国教制', desc: '主流宗教国教化' },
    { id: 'freedom', label: '信仰自由', desc: '各教平等' },
    { id: 'separation', label: '政教分离', desc: '教会脱离国家资助' },
    { id: 'atheism', label: '国家无神论', desc: '压制宗教，教士移民' },
  ],
};

export const LAW_CATEGORY_LABEL: Record<LawCategory, string> = {
  gov: '政权', suffrage: '选举', liberty: '人身自由', economy: '经济', rights: '权利',
  education: '教育', health: '医疗', military: '国防', policing: '治安', press: '言论',
  ethnic: '民族', religion: '宗教',
};

/** 初始法律（洛林：总统共和+财富选举+农奴制+自由放任+基本权利；他国按世界观） */
export const INITIAL_LAWS: Record<NationId, Record<LawCategory, number>> = {
  empire: { gov: 0, suffrage: 0, liberty: 0, economy: 0, rights: 0, education: 0, health: 0, military: 0, policing: 0, press: 0, ethnic: 0, religion: 0 },
  lorraine: { gov: 4, suffrage: 3, liberty: 0, economy: 1, rights: 1, education: 1, health: 1, military: 1, policing: 1, press: 2, ethnic: 3, religion: 1 },
  ianys: { gov: 1, suffrage: 2, liberty: 0, economy: 1, rights: 1, education: 1, health: 1, military: 1, policing: 1, press: 1, ethnic: 2, religion: 1 },
  orange: { gov: 2, suffrage: 3, liberty: 0, economy: 1, rights: 1, education: 2, health: 1, military: 1, policing: 1, press: 2, ethnic: 2, religion: 1 },
  zalakN: { gov: 1, suffrage: 1, liberty: 0, economy: 0, rights: 0, education: 0, health: 0, military: 0, policing: 0, press: 0, ethnic: 1, religion: 0 },
  zalakS: { gov: 1, suffrage: 2, liberty: 0, economy: 0, rights: 0, education: 1, health: 0, military: 0, policing: 0, press: 0, ethnic: 1, religion: 0 },
  angland: { gov: 2, suffrage: 4, liberty: 0, economy: 1, rights: 1, education: 2, health: 2, military: 1, policing: 2, press: 3, ethnic: 3, religion: 2 },
  normandy: { gov: 0, suffrage: 0, liberty: 0, economy: 0, rights: 0, education: 0, health: 0, military: 0, policing: 0, press: 0, ethnic: 0, religion: 0 },
};

// ---- 阶级对法律的立场（-2 强烈反对 ~ +2 强烈支持；权势加权 → 支持率） ----
type Stance = -2 | -1 | 0 | 1 | 2;

/** 选举法各档 × 阶级立场 */
export const SUFFRAGE_STANCE: Record<string, Record<ClassId, Stance>> = {
  hereditary: { 1: 2, 2: 1, 3: -1, 4: -2, 5: -2, 6: -2, 7: -2 },
  oligarchy: { 1: 1, 2: 2, 3: 0, 4: -1, 5: -1, 6: -1, 7: -1 },
  landed: { 1: 2, 2: 1, 3: 1, 4: -1, 5: -2, 6: -2, 7: -2 },
  wealth: { 1: 1, 2: 2, 3: 2, 4: 0, 5: -1, 6: -2, 7: -2 },
  merit: { 1: 0, 2: 1, 3: 2, 4: 1, 5: -1, 6: -2, 7: -2 },
  universal: { 1: -2, 2: -1, 3: 1, 4: 2, 5: 2, 6: 2, 7: 2 },
};

/** 人身自由各档 × 阶级立场 */
export const LIBERTY_STANCE: Record<string, Record<ClassId, Stance>> = {
  serfdom: { 1: 2, 2: 1, 3: 0, 4: -1, 5: -1, 6: -2, 7: -2 },
  debt: { 1: 1, 2: 1, 3: 0, 4: -1, 5: -2, 6: -1, 7: -2 },
  free: { 1: -2, 2: -1, 3: 1, 4: 1, 5: 2, 6: 2, 7: 2 },
};

/** 权利法各档 × 阶级立场 */
export const RIGHTS_STANCE: Record<string, Record<ClassId, Stance>> = {
  none: { 1: 2, 2: 1, 3: 0, 4: -1, 5: -2, 6: -2, 7: -2 },
  basic: { 1: -1, 2: 0, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 },
  labor: { 1: -2, 2: -2, 3: 0, 4: 1, 5: 2, 6: 2, 7: 2 },
};

/** 政权法各档 × 阶级立场（执政联盟支持 +2，被排斥旧贵族反对） */
export const GOV_STANCE: Record<string, Record<ClassId, Stance>> = {
  autocracy: { 1: 2, 2: 1, 3: 0, 4: -1, 5: -2, 6: -2, 7: -2 },
  monarchy: { 1: 1, 2: 1, 3: 2, 4: 0, 5: -1, 6: -2, 7: -2 },
  merchantRepublic: { 1: -1, 2: 2, 3: 2, 4: 0, 5: -1, 6: -2, 7: -2 },
  parliamentary: { 1: -2, 2: -1, 3: 2, 4: 2, 5: 0, 6: -1, 7: -2 },
  presidential: { 1: -2, 2: -1, 3: 1, 4: 2, 5: 2, 6: 1, 7: 1 },
};

/** 经济法各档立场（保守 → 自由）：农本=旧贵地主支持，自由=资本支持 */
export const ECONOMY_STANCE: Record<string, Record<ClassId, Stance>> = {
  traditionalism: { 1: 2, 2: -1, 3: 0, 4: -1, 5: -1, 6: -1, 7: -1 },
  laissezFaire: { 1: 0, 2: 2, 3: 1, 4: 0, 5: -1, 6: -1, 7: -1 },
  draconian: { 1: 2, 2: 0, 3: 1, 4: 0, 5: 0, 6: -1, 7: -1 },
};

/** 教育法立场：无教育/教会=上层支持；公立=下层强烈支持、上层纳税不满 */
export const EDUCATION_STANCE: Record<string, Record<ClassId, Stance>> = {
  none: { 1: 2, 2: 1, 3: 0, 4: -1, 5: -2, 6: -2, 7: -2 },
  church: { 1: 1, 2: 1, 3: 1, 4: 0, 5: -1, 6: -1, 7: -1 },
  private: { 1: 1, 2: 2, 3: 1, 4: -1, 5: -2, 6: -2, 7: -2 },
  public: { 1: -2, 2: -1, 3: 1, 4: 2, 5: 2, 6: 2, 7: 1 },
};

/** 医疗法立场 */
export const HEALTH_STANCE: Record<string, Record<ClassId, Stance>> = {
  none: { 1: 2, 2: 1, 3: 0, 4: -1, 5: -2, 6: -2, 7: -2 },
  church: { 1: 1, 2: 1, 3: 1, 4: 0, 5: -1, 6: -1, 7: -1 },
  private: { 1: 1, 2: 2, 3: 1, 4: -1, 5: -2, 6: -2, 7: -2 },
  public: { 1: -2, 2: -1, 3: 1, 4: 2, 5: 2, 6: 2, 7: 1 },
};

/** 国防法立场：农兵=贵族拥兵自重；义务兵役/大规模征募=平民被征（下层反对）、民族主义上层支持 */
export const MILITARY_STANCE: Record<string, Record<ClassId, Stance>> = {
  peasant: { 1: 2, 2: 0, 3: 0, 4: -1, 5: -1, 6: -1, 7: -1 },
  professional: { 1: 1, 2: 2, 3: 1, 4: 0, 5: -1, 6: -1, 7: -1 },
  conscript: { 1: -1, 2: 1, 3: 2, 4: 1, 5: 0, 6: 0, 7: -1 },
  mass: { 1: -2, 2: 0, 3: 1, 4: 1, 5: 1, 6: 1, 7: 0 },
};

/** 治安法立场：高压警察=上层支持下层反对 */
export const POLICING_STANCE: Record<string, Record<ClassId, Stance>> = {
  none: { 1: 0, 2: -1, 3: 0, 4: 1, 5: 1, 6: 1, 7: 1 },
  local: { 1: 1, 2: 1, 3: 1, 4: 0, 5: -1, 6: -1, 7: -1 },
  professional: { 1: 1, 2: 2, 3: 2, 4: 0, 5: -1, 6: -1, 7: -1 },
  militarized: { 1: 2, 2: 1, 3: 0, 4: -1, 5: -2, 6: -2, 7: -2 },
  secret: { 1: 2, 2: 1, 3: -1, 4: -2, 5: -2, 6: -2, 7: -2 },
  guard: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 0, 6: 0, 7: 0 },
};

/** 言论法立场：审查=上层支持；自由=中产/下层支持 */
export const PRESS_STANCE: Record<string, Record<ClassId, Stance>> = {
  gag: { 1: 2, 2: 1, 3: -1, 4: -2, 5: -2, 6: -2, 7: -2 },
  censor: { 1: 1, 2: 1, 3: 0, 4: -1, 5: -1, 6: -1, 7: -1 },
  licensed: { 1: 0, 2: 1, 3: 1, 4: 0, 5: 0, 6: 0, 7: 0 },
  free: { 1: -2, 2: -1, 3: 2, 4: 2, 5: 1, 6: 1, 7: 1 },
};

/** 民族法立场（阶级维度：族裔政策按财富利害）：文化多元下 中产支持（无失业压力）、温饱/挣扎反对（失业焦虑） */
export const ETHNIC_STANCE: Record<string, Record<ClassId, Stance>> = {
  nationState: { 1: 2, 2: 1, 3: 0, 4: -1, 5: -2, 6: -2, 7: -2 },
  segregation: { 1: 1, 2: 1, 3: 0, 4: 0, 5: -1, 6: -1, 7: -1 },
  exclusion: { 1: 2, 2: 1, 3: -1, 4: -1, 5: -1, 6: -1, 7: -1 },
  pluralism: { 1: -2, 2: -1, 3: 1, 4: -1, 5: -1, 6: 0, 7: 0 },
};

/** 宗教法立场（职业维度：观念随生产方式，不随财富）：资本家/银行家反教权；底层喜安慰剂 */
export const RELIGION_STANCE_JOB: Record<string, Record<JobId, Stance>> = {
  state: {
    slave: 1, peasant: 1, worker: 1, technician: -1, clerk: 0, engineer: -1,
    shopkeeper: 0, soldier: 1, sailor: 1, marine: 1, bureaucrat: 1, teacher: -1, priest: 2,
    merchant: -1, capitalist: -1, banker: -1,
  },
  freedom: {
    slave: 1, peasant: 1, worker: 1, technician: 1, clerk: 1, engineer: 1,
    shopkeeper: 1, soldier: 0, sailor: 1, marine: 0, bureaucrat: 1, teacher: 1, priest: 0,
    merchant: 1, capitalist: 1, banker: 0,
  },
  separation: {
    slave: 0, peasant: 0, worker: 0, technician: 1, clerk: 0, engineer: 1,
    shopkeeper: 0, soldier: 0, sailor: 0, marine: 0, bureaucrat: 0, teacher: 1, priest: -1,
    merchant: 1, capitalist: 2, banker: 1,
  },
  atheism: {
    slave: -1, peasant: -1, worker: -1, technician: 1, clerk: 0, engineer: 1,
    shopkeeper: 0, soldier: -1, sailor: -1, marine: -1, bureaucrat: 0, teacher: 1, priest: -2,
    merchant: 0, capitalist: 1, banker: 1,
  },
};

/** 民族法效果：异文化资质/工资惩罚（档位索引 → 乘数） */
export const ETHNIC_QUALITY_PENALTY: Record<string, number> = {
  nationState: 0.7, segregation: 0.8, exclusion: 0.9, pluralism: 1.0,
};
export const ETHNIC_WAGE_PENALTY: Record<string, number> = {
  nationState: 0.8, segregation: 0.88, exclusion: 0.94, pluralism: 1.0,
};
/** 民族法异宗教幸福惩罚（仅国教制宗教法下叠加；档位 → 惩罚值） */
export const ETHNIC_RELIGION_HAPPY: Record<string, number> = {
  nationState: -10, segregation: -6, exclusion: 0, pluralism: 0,
};
/** 民族法主体民族幸福修正（档位 → 不同阶级加成；中产 vs 上层分化） */
export const ETHNIC_MAJORITY_HAPPY: Record<string, Record<ClassId, number>> = {
  nationState: { 1: 0, 2: 0, 3: 4, 4: 2, 5: 1, 6: 0, 7: 0 },
  segregation: { 1: 0, 2: 0, 3: 2, 4: 2, 5: 1, 6: 0, 7: 0 },
  exclusion: { 1: 3, 2: 2, 3: -2, 4: -1, 5: -1, 6: 0, 7: 0 },
  pluralism: { 1: -2, 2: -1, 3: -2, 4: -3, 5: -3, 6: 0, 7: 0 },
};

/** 宗教法效果：教士政治权重修正（×） / 教会建筑效率（×） / 主流宗教幸福 / 异教幸福 */
export interface ReligionEffect {
  clergyPower: number;
  churchEff: number;
  majorityHappy: number;
  minorityHappy: number;
  /** 教士月移民率（无神论触发） */
  clergyEmigrate: number;
}
export const RELIGION_EFFECT: Record<string, ReligionEffect> = {
  state: { clergyPower: 1.1, churchEff: 1.2, majorityHappy: 2, minorityHappy: -4, clergyEmigrate: 0 },
  freedom: { clergyPower: 1.0, churchEff: 1.0, majorityHappy: 0, minorityHappy: 0, clergyEmigrate: 0 },
  separation: { clergyPower: 0.92, churchEff: 0.9, majorityHappy: 0, minorityHappy: 0, clergyEmigrate: 0 },
  atheism: { clergyPower: 0.85, churchEff: 0.7, majorityHappy: 0, minorityHappy: 0, clergyEmigrate: 0.02 },
};

/** 获取某法律类某档的阶级立场表 */
export function stanceOf(cat: LawCategory, tierId: string): Record<ClassId, Stance> {
  switch (cat) {
    case 'gov': return GOV_STANCE[tierId] ?? GOV_STANCE.autocracy;
    case 'suffrage': return SUFFRAGE_STANCE[tierId] ?? SUFFRAGE_STANCE.hereditary;
    case 'liberty': return LIBERTY_STANCE[tierId] ?? LIBERTY_STANCE.serfdom;
    case 'economy': return ECONOMY_STANCE[tierId] ?? ECONOMY_STANCE.traditionalism;
    case 'rights': return RIGHTS_STANCE[tierId] ?? RIGHTS_STANCE.none;
    case 'education': return EDUCATION_STANCE[tierId] ?? EDUCATION_STANCE.none;
    case 'health': return HEALTH_STANCE[tierId] ?? HEALTH_STANCE.none;
    case 'military': return MILITARY_STANCE[tierId] ?? MILITARY_STANCE.peasant;
    case 'policing': return POLICING_STANCE[tierId] ?? POLICING_STANCE.none;
    case 'press': return PRESS_STANCE[tierId] ?? PRESS_STANCE.gag;
    case 'ethnic': return ETHNIC_STANCE[tierId] ?? ETHNIC_STANCE.nationState;
    case 'religion': {
      // 宗教法按职业立场：把职业立场表转成阶级加权（每个阶级取其代表职业的立场）
      const jobSt = RELIGION_STANCE_JOB[tierId] ?? RELIGION_STANCE_JOB.freedom;
      const out: Record<ClassId, Stance> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
      out[1] = (jobSt.capitalist ?? 0) as Stance; // 富裕：资本家代表
      out[2] = (jobSt.banker ?? 0) as Stance; // 安逸：银行家代表
      out[3] = (jobSt.teacher ?? 0) as Stance; // 中产：教师代表
      out[4] = (jobSt.clerk ?? 0) as Stance; // 温饱：职员代表
      out[5] = (jobSt.worker ?? 0) as Stance; // 挣扎：工人代表
      out[6] = (jobSt.peasant ?? 0) as Stance; // 赤贫：无业/自耕农代表
      out[7] = (jobSt.slave ?? 0) as Stance; // 奴役
      return out;
    }
  }
}

// ---- 民生/国防法律效果表（v0.10）：教育/医疗按阶级修正；国防/治安/言论影响系统系数 ----

/** 教育法各档 × 阶级：识字率增速修正（× 基础增速；0=不识字，1=正常） */
export const EDUCATION_LITERACY: Record<string, Record<ClassId, number>> = {
  none: { 1: 0.2, 2: 0.2, 3: 0.1, 4: 0.05, 5: 0, 6: 0, 7: 0 },
  church: { 1: 0.9, 2: 0.8, 3: 0.6, 4: 0.4, 5: 0.2, 6: 0.1, 7: 0.05 },
  private: { 1: 1.3, 2: 1.5, 3: 1.0, 4: 0.4, 5: 0.1, 6: 0, 7: 0 },
  public: { 1: 1.2, 2: 1.3, 3: 1.4, 4: 1.5, 5: 1.5, 6: 1.3, 7: 0.8 },
};

/** 教育法各档 × 阶级：幸福度修正 */
export const EDUCATION_HAPPY: Record<string, Record<ClassId, number>> = {
  none: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
  church: { 1: 1, 2: 0.5, 3: 0.5, 4: 0, 5: -1, 6: -1, 7: -1 },
  private: { 1: 1, 2: 2, 3: 0.5, 4: -1, 5: -1, 6: -1, 7: -1 },
  public: { 1: -2, 2: -1, 3: 1, 4: 2, 5: 2, 6: 2, 7: 1 },
};

/** 医疗法各档 × 阶级：健康增速修正 */
export const HEALTH_GROWTH: Record<string, Record<ClassId, number>> = {
  none: { 1: 0.3, 2: 0.3, 3: 0.2, 4: 0.1, 5: 0, 6: 0, 7: 0 },
  church: { 1: 0.8, 2: 0.7, 3: 0.6, 4: 0.5, 5: 0.3, 6: 0.2, 7: 0.1 },
  private: { 1: 1.4, 2: 1.5, 3: 1.0, 4: 0.3, 5: 0.1, 6: 0, 7: 0 },
  public: { 1: 1.1, 2: 1.2, 3: 1.3, 4: 1.4, 5: 1.5, 6: 1.4, 7: 1.0 },
};

/** 医疗法各档 × 阶级：幸福度修正 */
export const HEALTH_HAPPY: Record<string, Record<ClassId, number>> = {
  none: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
  church: { 1: 1, 2: 0.5, 3: 0.5, 4: 0, 5: -0.5, 6: -0.5, 7: -0.5 },
  private: { 1: 1, 2: 2, 3: 0.5, 4: -1, 5: -1, 6: -1, 7: -1 },
  public: { 1: -2, 2: -1, 3: 1, 4: 2, 5: 2, 6: 2, 7: 1.5 },
};

/** 国防法效果：征兵率/军费效率/动员系数/贵族政治权重修正 */
export interface MilitaryEffect {
  /** 战时征兵月率（× 政体基础） */
  conscriptRate: number;
  /** 军费效率（× 军事支出效果） */
  milEff: number;
  /** 战争动员系数（未来战争系统用） */
  mobilization: number;
  /** 军队/贵族政治权重修正 */
  noblePower: number;
}
export const MILITARY_EFFECT: Record<string, MilitaryEffect> = {
  peasant: { conscriptRate: 0.004, milEff: 0.7, mobilization: 0.6, noblePower: 1.3 },
  professional: { conscriptRate: 0.002, milEff: 1.0, mobilization: 1.0, noblePower: 1.1 },
  conscript: { conscriptRate: 0.006, milEff: 1.1, mobilization: 1.4, noblePower: 0.9 },
  mass: { conscriptRate: 0.012, milEff: 1.3, mobilization: 1.8, noblePower: 0.7 },
};

/** 治安法效果：动乱压制/下层幸福惩罚/官僚政治权重修正 */
export interface PolicingEffect {
  /** 动乱压制（× 动乱指数惩罚；越高压制越强） */
  suppress: number;
  /** 下层（4-7 级）幸福度惩罚（高压社会压抑） */
  unhappy: number;
  /** 官僚/地主政治权重修正 */
  power: number;
}
export const POLICING_EFFECT: Record<string, PolicingEffect> = {
  none: { suppress: 0.5, unhappy: 0, power: 1.0 },
  local: { suppress: 0.8, unhappy: -0.5, power: 1.0 },
  professional: { suppress: 1.2, unhappy: -1, power: 1.05 },
  militarized: { suppress: 1.8, unhappy: -2, power: 1.15 },
  secret: { suppress: 2.2, unhappy: -3, power: 1.3 },
  guard: { suppress: 1.5, unhappy: -1.5, power: 1.1 },
};

/** 言论法效果：识字率传播/稳定度/下层满意/政治权重修正 */
export interface PressEffect {
  /** 识字率传播（× 全国识字率增速） */
  literacy: number;
  /** 稳定度修正 */
  stability: number;
  /** 中产/下层幸福度修正 */
  happy: number;
  /** 中产/官僚政治权重修正 */
  power: number;
}
export const PRESS_EFFECT: Record<string, PressEffect> = {
  gag: { literacy: 0.6, stability: 3, happy: -2, power: 0.9 },
  censor: { literacy: 0.8, stability: 1.5, happy: -1, power: 1.0 },
  licensed: { literacy: 1.0, stability: 0, happy: 0, power: 1.05 },
  free: { literacy: 1.3, stability: -2, happy: 1.5, power: 1.15 },
};

// ---- 行政力 ----
/** 行政容量 = 行政支出 × 容量系数（万₭/月 → 容量） */
const ADMIN_CAP_PER_SPEND = 12;
/** 行政消耗 = 人口 × 人均 × 治理复杂度 */
const ADMIN_PER_WAN = 0.45;

export function adminCapacityOf(spendingAdmin: number): number {
  return spendingAdmin * ADMIN_CAP_PER_SPEND;
}

export function adminUsedOf(popWan: number, gov: GovStructure, lawCount: number): number {
  const def = GOV_DEFS[gov];
  return Math.max(1, popWan * ADMIN_PER_WAN * def.complexity * (1 + lawCount * 0.04));
}

export function adminEfficiencyOf(spendingAdmin: number, popWan: number, gov: GovStructure, lawCount: number): number {
  const cap = adminCapacityOf(spendingAdmin);
  const used = adminUsedOf(popWan, gov, lawCount);
  return clamp(cap / used, 0.3, 1.2);
}

// ---- 合法性 ----
export function legitimacyOf(n: {
  stability: number;
  policies: { gov: GovStructure };
  classPower?: Record<ClassId, number>;
}): number {
  const def = GOV_DEFS[n.policies.gov];
  // 执政联盟权势占比（无 classPower 时按稳定度兜底）
  let coalition = 0.5;
  if (n.classPower) {
    const total = (Object.values(n.classPower) as number[]).reduce((s, v) => s + v, 0);
    if (total > 1e-9) {
      coalition = def.rulingClasses.reduce((s, c) => s + (n.classPower?.[c] ?? 0), 0) / total;
    }
  }
  const fromCoalition = coalition * 100 * def.legitimacyBase;
  const fromStability = n.stability * 0.3;
  return clamp(fromCoalition + fromStability, 0, 100);
}

// ---- 立法推进 ----
export interface LawProgress {
  cat: LawCategory;
  target: number; // 目标档位索引
  progress: number; // 0-100
  momentum: number; // 上月推进（UI 显示）
}

/** 支持率：阶级立场 × 阶级权势占比（-2~+2 → 0~100） */
export function supportOf(
  cat: LawCategory,
  tierId: string,
  classPower: Record<ClassId, number>,
): number {
  const st = stanceOf(cat, tierId);
  const total = (Object.values(classPower) as number[]).reduce((s, v) => s + v, 0);
  if (total <= 1e-9) return 50;
  let weighted = 0;
  for (const c of Object.keys(st) as unknown as ClassId[]) {
    weighted += st[c] * (classPower[c] ?? 0);
  }
  weighted /= total; // -2 ~ +2
  return clamp(50 + weighted * 30, 0, 100);
}

/** 月度立法推进：支持率% × 合法性% × 行政效率 × 0.15 → 累计；支持率 < 15% 倒退 */
export function advanceLaw(
  p: LawProgress,
  classPower: Record<ClassId, number>,
  legitimacy: number,
  adminEff: number,
): { progress: number; momentum: number } {
  const tier = LAW_TIERS[p.cat][p.target];
  const support = supportOf(p.cat, tier.id, classPower);
  if (support < 15) {
    // 反对激烈：倒退
    return { progress: Math.max(0, p.progress - 4), momentum: -4 };
  }
  const momentum = support * (legitimacy / 100) * adminEff * 0.15;
  return { progress: Math.min(100, p.progress + momentum), momentum };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 阶级权势（由 nationClassPower 计算；供政治系统复用；v0.10 国防/治安/言论修正） */
export function nationClassPowerOf(state: GameState, map: GameMap, id: NationId): Record<ClassId, number> {
  const power: Record<ClassId, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  const n = state.nations[id];
  const suffrage = n.policies.suffrage === 5; // 普选档
  // v0.10 法律对政治力量的修正
  const milEff = MILITARY_EFFECT[LAW_TIERS.military[n.policies.military]?.id ?? 'peasant'] ?? MILITARY_EFFECT.peasant;
  const policeEff = POLICING_EFFECT[LAW_TIERS.policing[n.policies.policing]?.id ?? 'none'] ?? POLICING_EFFECT.none;
  const pressEff = PRESS_EFFECT[LAW_TIERS.press[n.policies.press]?.id ?? 'censor'] ?? PRESS_EFFECT.censor;
  // v0.14 宗教法：教士权势修正（国教 +10% / 无神论 -15%）
  const religEff = RELIGION_EFFECT[LAW_TIERS.religion[n.policies.religion]?.id ?? 'freedom'] ?? RELIGION_EFFECT.freedom;
  for (const p of map.provinces) {
    if (p.owner !== id || p.isUndiscovered) continue;
    const ps = state.provinces[p.id];
    if (!ps?.pops) continue;
    for (const pop of ps.pops) {
      let w = classPoliticalWeight(pop.class, suffrage);
      // 贵族：国防法（农兵/职业军队→贵族军权更重）
      if (pop.class === 1) w *= milEff.noblePower;
      // 官僚/中产：治安法（秘密警察→官僚权重）与言论法（出版自由→中产权重）
      if (pop.class === 3) w *= policeEff.power * pressEff.power;
      // v0.14 教士：宗教法权势修正 + 教士职业本身权重提升（教团组织）
      if (pop.job === 'priest') w *= religEff.clergyPower * 1.5;
      power[pop.class] += pop.size * w;
    }
  }
  return power;
}