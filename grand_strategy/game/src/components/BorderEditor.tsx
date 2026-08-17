/**
 * v0.6 国界编辑工具栏（独立编辑模式）：
 *  - 国家选择列表（8 国 + 迷雾锁）：选中国家后点击地图省份改属
 *  - 撤销/重做（历史栈）、清空到默认、保存（localStorage）、导出 JSON（{provinceId: nationId}）
 * 编辑模式与游戏模式隔离（进入时游戏时钟暂停，退出恢复）。
 */
import { Undo2, Redo2, Trash2, Save, Download, Lock } from 'lucide-react';
import { NATION_LIST } from '../game/nations';
import type { ProvinceOwner } from '../game/types';

interface Props {
  /** 当前选中的归属目标（'undiscovered' = 迷雾锁：点击无效，仅提示） */
  nation: ProvinceOwner;
  onNation: (n: ProvinceOwner) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onSave: () => void;
  onExport: () => void;
  overrideCount: number;
}

export default function BorderEditor({
  nation,
  onNation,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
  onSave,
  onExport,
  overrideCount,
}: Props) {
  return (
    <div className="edit-bar">
      <span className="edit-bar-title">国界编辑</span>
      <div className="edit-nations">
        {NATION_LIST.map((d) => (
          <button
            key={d.id}
            className={`edit-nation-btn ${nation === d.id ? 'active' : ''}`}
            onClick={() => onNation(d.id)}
            title={`点击省份归属到 ${d.name}`}
          >
            <i className="edit-dot" style={{ background: d.color }} />
            {d.name}
          </button>
        ))}
        <button
          className={`edit-nation-btn ${nation === 'undiscovered' ? 'active' : ''}`}
          onClick={() => onNation('undiscovered')}
          title="迷雾新大陆锁定：不可编辑（防误触）"
        >
          <Lock size={12} />
          迷雾锁
        </button>
      </div>
      <div className="edit-actions">
        <button className="edit-btn" onClick={onUndo} disabled={!canUndo} title="撤销 (Ctrl+Z)">
          <Undo2 size={13} />
          撤销
        </button>
        <button className="edit-btn" onClick={onRedo} disabled={!canRedo} title="重做 (Ctrl+Y)">
          <Redo2 size={13} />
          重做
        </button>
        <button className="edit-btn" onClick={onClear} title="清空全部编辑，恢复代码内默认归属">
          <Trash2 size={13} />
          清空
        </button>
        <button className="edit-btn" onClick={onSave} title="保存到本机（localStorage: kalt-border-edits，开局自动加载）">
          <Save size={13} />
          保存
        </button>
        <button className="edit-btn" onClick={onExport} title="导出 JSON（格式 {provinceId: nationId}，与 PROVINCE_OWNER_OVERRIDES 兼容）">
          <Download size={13} />
          导出
        </button>
      </div>
      <span className="edit-count">已改 {overrideCount} 省</span>
    </div>
  );
}
