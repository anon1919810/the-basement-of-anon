/**
 * 实时暂停时钟：1 年 = 12 月 = 360 日（30 日/月）。
 * 纪年：新历 1023 年 1 月起（day 0 = 1023 年 1 月 1 日）。
 */

export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR; // 360
export const START_YEAR = 1023;

/** 1x 速度下每秒推进的游戏日数（UI 用，模拟脚本逐日驱动不经此） */
export const DAYS_PER_SECOND_BASE = 1.5;

/** 由 speed 档位得到每秒推进天数 */
export function daysPerSecond(speed: 0 | 1 | 2 | 3): number {
  return DAYS_PER_SECOND_BASE * speed;
}

/** 年份（新历） */
export function yearOf(day: number): number {
  return START_YEAR + Math.floor(day / DAYS_PER_YEAR);
}

/** 月份 1-12 */
export function monthOf(day: number): number {
  return (Math.floor(day / DAYS_PER_MONTH) % MONTHS_PER_YEAR) + 1;
}

/** 0 基月份序号（自新历 1023 年 1 月起） */
export function monthIndex(day: number): number {
  return Math.floor(day / DAYS_PER_MONTH);
}

/** 日（月内 1-30） */
export function dayOfMonth(day: number): number {
  return (day % DAYS_PER_MONTH) + 1;
}

export const MONTH_NAMES = [
  '霜月', '雪月', '融月', '芽月', '花月', '雨月',
  '麦月', '穗月', '谷月', '枫月', '雾月', '冰月',
] as const;

/** 「新历 1023 年 · 霜月 3 日」 */
export function dateLabel(day: number): string {
  const y = yearOf(day);
  const m = monthOf(day);
  return `新历 ${y} 年 · ${MONTH_NAMES[m - 1]} ${dayOfMonth(day)} 日`;
}

/** 简易「新历 1023 年 · 霜月」 */
export function monthLabel(day: number): string {
  return `新历 ${yearOf(day)} 年 · ${MONTH_NAMES[monthOf(day) - 1]}`;
}

export const SPEED_LABEL: Record<0 | 1 | 2 | 3, string> = {
  0: '⏸',
  1: '1×',
  2: '2×',
  3: '3×',
};
