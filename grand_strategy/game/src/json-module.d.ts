/**
 * 允许导入 JSON（含 2.7MB 地图数据）。
 * 用宽松类型绕过 TS 对巨型 JSON 的深度类型推导。
 */
declare module '*.json' {
  const value: any;
  export default value;
}
