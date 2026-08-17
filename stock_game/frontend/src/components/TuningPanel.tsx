import { useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { DEFAULT_PARAMS, PARAM_LABELS, paramDisplay, paramFromDisplay } from "../game/params";
import type { TunableParams } from "../game/types";

interface Props {
  current: TunableParams;
  pending: TunableParams | null;
  onApply: (params: TunableParams) => void;
  onClose: () => void;
}

export default function TuningPanel({ current, pending, onApply, onClose }: Props) {
  const [draft, setDraft] = useState<TunableParams>({ ...(pending ?? current) });

  const setField = (key: keyof TunableParams, displayValue: number) => {
    setDraft((d) => ({ ...d, [key]: paramFromDisplay(key, displayValue) }));
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">
          调参面板
          <button className="btn small modal-x" onClick={onClose}>
            <X size={12} /> 关闭
          </button>
        </h2>
        <div className="tuning-note">
          改动保存在本地并从<b>下一交易日</b>开始生效。当前生效值见括号。
        </div>
        <div className="tuning-grid">
          {PARAM_LABELS.map((p) => {
            const display = paramDisplay(p.key, draft[p.key]);
            const curDisplay = paramDisplay(p.key, current[p.key]);
            const changed = display !== curDisplay;
            return (
              <label key={p.key} className={`tuning-field ${changed ? "tuning-changed" : ""}`}>
                <span className="tf-label">
                  {p.label}
                  <em>当前 {curDisplay}{p.unit}</em>
                </span>
                <input
                  type="number"
                  step={p.step}
                  min={0}
                  value={display}
                  onChange={(e) => setField(p.key, parseFloat(e.target.value) || 0)}
                />
                <span className="tf-unit">{p.unit}</span>
              </label>
            );
          })}
        </div>
        <div className="modal-actions tuning-actions">
          <button
            className="btn"
            onClick={() => setDraft({ ...DEFAULT_PARAMS })}
          >
            <RotateCcw size={13} /> 恢复默认
          </button>
          <button className="btn primary" onClick={() => onApply(draft)}>
            保存（下一交易日生效）
          </button>
        </div>
      </div>
    </div>
  );
}
