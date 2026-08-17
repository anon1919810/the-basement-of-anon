/**
 * 人工事件预留（v0.2，端明ちゃん 指示：先移除自动事件，人工填入）。
 *
 * 自动事件生成/触发已在 v0.2 移除；此文件仅保留「人工事件池」的接口与填写格式，
 * 供日后人工（或后端）填入具体事件。state.ts 的月度结算中保留一个休眠检查点
 * （列表为空则 no-op），填充后即可按 triggerMonth 派发，无需改动结算框架。
 *
 * ── ManualEvent 字段说明 ──
 *  - id:           唯一标识（如 'harvest_1023'），用于日志/去重
 *  - title:        事件标题（中文，如「丰收之年」）
 *  - desc:         事件正文（描述性文字）
 *  - triggerMonth: 0 基月份序号（自新历 1023 年 1 月起；如 12 = 1024 年 1 月）
 *                  或 -1 表示「任意月触发」（届时由结算框架决定时机）
 *  - options:      玩家选项列表（可空：空数组表示纯告知性事件，仅记入大事记）
 *      - label:  选项文案
 *      - hint:   提示/代价说明（可省略）
 *      - effect: 事件效果（与 v0.1 一致的比例/绝对系数，应用时按国家规模缩放）
 *          - treasuryFrac?:  × 月税收收入（万₭，正=增收）
 *          - stability?:      稳定度绝对增减（0-100）
 *          - popFrac?:        × 当前人口的比例增减（0.01 = +1%）
 *          - literacy?:       识字率绝对增减（0-1）
 *          - health?:         健康绝对增减（0-1）
 *          - happiness?:      全国平均幸福度增减（0-100）
 *          - foodFrac?:       × 年耗粮（万吨）的增减
 *          - stockFrac?:      各商品库存比例增减（{ food: 0.25 } = 粮库存 +25%）
 *
 * 填入示例：
 * {
 *   id: 'harvest_1023',
 *   title: '丰收之年',
 *   desc: '今年雨水适时，田野一片金黄，各地粮仓告满。',
 *   triggerMonth: 9,
 *   options: [
 *     { label: '开仓平粜，惠及黎民', hint: '稳定民心', effect: { foodFrac: 0.45, stability: 4 } },
 *     { label: '囤粮待价而沽', hint: '充实国库', effect: { treasuryFrac: 1.8, stability: -2 } },
 *   ],
 * },
 */
import type { GoodId } from './types';

export interface ManualEventEffects {
  /** × 月税收收入（万₭） */
  treasuryFrac?: number;
  /** 绝对稳定度增减（0-100） */
  stability?: number;
  /** × 当前人口的比例增减（0.01 = +1%） */
  popFrac?: number;
  /** 绝对识字率增减（0-1） */
  literacy?: number;
  /** 绝对健康增减（0-1） */
  health?: number;
  /** 全国平均幸福度增减（0-100） */
  happiness?: number;
  /** × 年耗粮（万吨）的增减 */
  foodFrac?: number;
  /** 各商品库存比例增减（0.25 = +25%） */
  stockFrac?: Partial<Record<GoodId, number>>;
}

export interface ManualEventOption {
  label: string;
  hint?: string;
  effect: ManualEventEffects;
}

export interface ManualEvent {
  id: string;
  title: string;
  desc: string;
  /** 0 基月份序号；-1 = 任意月（由结算框架决定） */
  triggerMonth: number;
  /** 空数组 = 纯告知性事件，仅记入大事记 */
  options: ManualEventOption[];
}

/** 人工事件池：v0.2 为空（休眠），按上述格式人工填入即可生效 */
export const MANUAL_EVENTS: ManualEvent[] = [];
