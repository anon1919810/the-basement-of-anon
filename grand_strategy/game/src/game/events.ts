/**
 * 事件系统：内置模板池（12 条），每 1-3 月随机触发 1 条。
 * 每条事件含若干选项，选项效果作用于：国库 / 稳定度 / 人口 / 识字率 / 粮食。
 * 效果以「比例系数」定义，应用时按国家规模（月收入 / 年耗粮 / 人口）缩放，保证小国大国都合理。
 */

export interface EventEffects {
  /** × 月税收收入（万₭） */
  treasuryFrac?: number;
  /** 绝对稳定度增减（0-100） */
  stability?: number;
  /** × 当前人口（万人）的增减比例（0.01 = +1%） */
  popFrac?: number;
  /** 绝对识字率增减（0-1） */
  literacy?: number;
  /** × 年耗粮（万吨）的增减 */
  foodFrac?: number;
}

export interface EventOption {
  label: string;
  hint?: string;
  effects: EventEffects;
}

export interface EventTemplate {
  id: string;
  title: string;
  text: string;
  weight: number;
  options: EventOption[];
}

export interface EventInstance {
  uid: number;
  templateId: string;
  title: string;
  text: string;
  options: EventOption[];
  month: number; // 触发时的 0 基月份序号
}

export const EVENT_TEMPLATES: EventTemplate[] = [
  {
    id: 'harvest',
    title: '风调雨顺',
    text: '今年雨水适时，田野一片金黄，各地粮仓告满，商贩纷纷压低粮价。',
    weight: 10,
    options: [
      { label: '开仓平粜，惠及黎民', hint: '稳定民心', effects: { foodFrac: 0.45, stability: 4 } },
      { label: '囤粮待价而沽', hint: '充实国库', effects: { treasuryFrac: 1.8, stability: -2 } },
      { label: '照常征购', effects: { treasuryFrac: 0.8, foodFrac: 0.2 } },
    ],
  },
  {
    id: 'famine',
    title: '灾年歉收',
    text: '旱涝无常，庄稼大片枯死，乡间已有流民聚于官道。',
    weight: 9,
    options: [
      { label: '开仓赈灾', hint: '消耗存粮', effects: { foodFrac: -0.35, stability: 5 } },
      { label: '减税纾困', hint: '损耗税收', effects: { treasuryFrac: -1.2, stability: 3 } },
      { label: '任其自生自灭', hint: '民怨沸腾', effects: { stability: -8, popFrac: -0.01 } },
    ],
  },
  {
    id: 'plague',
    title: '瘟疫流行',
    text: '一场热病自港口蔓延开来，医师束手，死者相枕，市井萧条。',
    weight: 6,
    options: [
      { label: '隔离疫区，出钱购药', effects: { treasuryFrac: -2.5, popFrac: -0.012, stability: 2 } },
      { label: '征发劳役，掩埋尸骸', effects: { popFrac: -0.02, stability: -4 } },
      { label: '封锁消息', hint: '纸包不住火', effects: { popFrac: -0.025, stability: -7 } },
    ],
  },
  {
    id: 'rebellion',
    title: '民变蜂起',
    text: '流民与心怀不满者揭竿而起，占据了数座集镇，官府告急。',
    weight: 8,
    options: [
      { label: '调兵镇压', hint: '耗费军费', effects: { treasuryFrac: -3, stability: -6, popFrac: -0.008 } },
      { label: '招抚首领，许以粮饷', effects: { treasuryFrac: -2, stability: 3 } },
      { label: '轻徭薄赋，以安人心', effects: { treasuryFrac: -1.5, stability: 5, literacy: 0.001 } },
    ],
  },
  {
    id: 'diplomacy',
    title: '外交照会',
    text: '邻国使节递来国书，就边境商路通行税一事提出交涉，语气不卑不亢。',
    weight: 7,
    options: [
      { label: '接受条款，换取邦谊', effects: { treasuryFrac: -1.2, stability: 1 } },
      { label: '婉言拒绝', effects: { stability: -1, treasuryFrac: 0.8 } },
      { label: '借机索要互惠', hint: '关税谈判', effects: { treasuryFrac: 1.5, stability: -2 } },
    ],
  },
  {
    id: 'immigration',
    title: '移民潮涌',
    text: '听闻此地税轻地广，邻国的工匠与农户携家带口迁入，城郊渐有人烟。',
    weight: 6,
    options: [
      { label: '敞开国门接纳', hint: '人口增长', effects: { popFrac: 0.015, stability: 2 } },
      { label: '发放路引，择优接纳', effects: { popFrac: 0.008, literacy: 0.001 } },
      { label: '驱逐流民', hint: '人言可畏', effects: { stability: -4 } },
    ],
  },
  {
    id: 'religious',
    title: '宗教躁动',
    text: '一介布衣在广场宣讲末世之兆，信众越聚越多，旧神祭司与新派修士争执不下。',
    weight: 6,
    options: [
      { label: '默许教义传播', effects: { literacy: 0.002, stability: -3 } },
      { label: '出面调停，维持秩序', effects: { stability: 2 } },
      { label: '取缔集会', hint: '压制言论', effects: { stability: -5, literacy: -0.001 } },
    ],
  },
  {
    id: 'scandal',
    title: '宫廷丑闻',
    text: '朝中传出私相授受、买卖官职的流言，民间小报竞相刊载，议论纷纷。',
    weight: 5,
    options: [
      { label: '下令彻查，严惩不贷', effects: { treasuryFrac: -1, stability: 3, literacy: 0.001 } },
      { label: '压下消息，冷处理', effects: { stability: -3 } },
      { label: '借机整顿吏治', effects: { treasuryFrac: -2, stability: 4, literacy: 0.002 } },
    ],
  },
  {
    id: 'coldwave',
    title: '北地寒潮',
    text: '入冬以来寒潮早至，河流封冻，牲畜冻毙，边地百姓苦不堪言。',
    weight: 6,
    options: [
      { label: '拨粮赈济边民', effects: { foodFrac: -0.3, stability: 3 } },
      { label: '征调柴炭，以工代赈', effects: { treasuryFrac: -1.5, stability: 2 } },
      { label: '坐视不管', hint: '边地离心', effects: { stability: -6, popFrac: -0.006 } },
    ],
  },
  {
    id: 'trade_boom',
    title: '商路繁荣',
    text: '海陆商路连日繁忙，商会账簿上的数字节节攀升，港口帆樯如林。',
    weight: 7,
    options: [
      { label: '加征关税', hint: '充实国库', effects: { treasuryFrac: 3, stability: -2 } },
      { label: '整顿市舶，薄征广纳', effects: { treasuryFrac: 1.8, stability: 2, literacy: 0.001 } },
      { label: '放任自由', effects: { treasuryFrac: 1, stability: 1 } },
    ],
  },
  {
    id: 'corruption',
    title: '官僚贪腐',
    text: '审计官查出数省税银被层层盘剥，账目黑洞触目惊心。',
    weight: 6,
    options: [
      { label: '雷厉风行反腐', effects: { treasuryFrac: -2, stability: 3, literacy: 0.002 } },
      { label: '杀一儆百', hint: '治标不治本', effects: { treasuryFrac: -0.8, stability: 1 } },
      { label: '睁一只眼闭一只眼', hint: '上下分肥', effects: { treasuryFrac: 1.2, stability: -4 } },
    ],
  },
  {
    id: 'enlightenment',
    title: '启蒙之风吹拂',
    text: '一家新式学堂落成，印刷坊赶印的书籍被争相抢购，青年们聚谈天下大势。',
    weight: 5,
    options: [
      { label: '资助学堂与出版', effects: { treasuryFrac: -1.5, literacy: 0.004 } },
      { label: '听之任之', effects: { literacy: 0.002 } },
      { label: '查禁新书', hint: '愚民政策', effects: { literacy: -0.002, stability: -3 } },
    ],
  },
];

export function templateById(id: string): EventTemplate | undefined {
  return EVENT_TEMPLATES.find((t) => t.id === id);
}
