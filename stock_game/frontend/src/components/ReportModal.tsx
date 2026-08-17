import { BarChart3 } from "lucide-react";
import { fmtMoney, fmtPct } from "../game/util";
import type { GameState, ReportData } from "../game/types";

interface Props {
  state: GameState;
  report: ReportData;
  onNewGame: () => void;
}

export default function ReportModal({ state, report, onNewGame }: Props) {
  const top = report.attribution.slice(0, 3);
  const bottom = report.attribution.slice(-3).reverse();

  return (
    <div className="modal-mask">
      <div className="modal modal-wide">
        <h2 className="modal-title">
          <BarChart3 size={18} /> 结算复盘 · {state.day} 个交易日结束
        </h2>

        <div className="report-summary">
          <div className="report-card">
            <div className="rc-label">总资产</div>
            <div className="rc-value num">{fmtMoney(report.totalAssets)}</div>
          </div>
          <div className="report-card">
            <div className="rc-label">总收益率</div>
            <div className={`rc-value num ${report.ret >= 0 ? "up" : "down"}`}>{fmtPct(report.ret)}</div>
          </div>
          <div className="report-card">
            <div className="rc-label">覆巢指数</div>
            <div className={`rc-value num ${report.indexRet >= 0 ? "up" : "down"}`}>{fmtPct(report.indexRet)}</div>
          </div>
          <div className="report-card">
            <div className="rc-label">跑赢指数</div>
            <div className={`rc-value num ${report.alpha >= 0 ? "up" : "down"}`}>{fmtPct(report.alpha)}</div>
          </div>
          <div className="report-card">
            <div className="rc-label">机构平均</div>
            <div className={`rc-value num ${report.instAvgRet >= 0 ? "up" : "down"}`}>{fmtPct(report.instAvgRet)}</div>
          </div>
        </div>

        <div className="report-grid">
          <div className="report-block">
            <h3 className="sub-title">收益归因（按标的盈亏）</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>标的</th>
                  <th className="num">盈亏贡献</th>
                </tr>
              </thead>
              <tbody>
                {top.map((a) => (
                  <tr key={`t_${a.code}`}>
                    <td>{a.name}</td>
                    <td className={`num ${a.pnl >= 0 ? "up" : "down"}`}>{fmtMoney(a.pnl)}</td>
                  </tr>
                ))}
                {report.attribution.length > 6 && (
                  <tr>
                    <td colSpan={2} className="flat">… 共 {report.attribution.length} 个标的</td>
                  </tr>
                )}
                {bottom.map((a) => (
                  <tr key={`b_${a.code}`}>
                    <td>{a.name}</td>
                    <td className={`num ${a.pnl >= 0 ? "up" : "down"}`}>{fmtMoney(a.pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="report-block">
            <h3 className="sub-title">交易统计</h3>
            <table className="table">
              <tbody>
                <tr>
                  <td>总成交次数</td>
                  <td className="num">{report.tradeStats.totalTrades}</td>
                </tr>
                <tr>
                  <td>买入 / 卖出</td>
                  <td className="num">
                    {report.tradeStats.buyCount} / {report.tradeStats.sellCount}
                  </td>
                </tr>
                <tr>
                  <td>做空 / 平仓</td>
                  <td className="num">
                    {report.tradeStats.shortCount} / {report.tradeStats.coverCount}
                  </td>
                </tr>
                <tr>
                  <td>手续费 + 借券费合计</td>
                  <td className="num">{fmtMoney(report.tradeStats.totalFee)}</td>
                </tr>
                <tr>
                  <td>胜率</td>
                  <td className="num">{fmtPct(report.winRate)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn primary" onClick={onNewGame}>
            重新开始
          </button>
        </div>
      </div>
    </div>
  );
}
