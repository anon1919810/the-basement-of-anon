// v0.0.0 兼容垫片：AI 交易者逻辑已迁移至 traders.ts（散户/机构/游资分层）
export { createInstitutions, createPools, simulateTraders } from "./traders";
export type { TraderImpact } from "./traders";
