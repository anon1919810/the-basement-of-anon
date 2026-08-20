import { useEffect, useRef, useState } from 'react';
import type { GameMap } from './game/map';
import { applyBorderOverrides, loadMap } from './game/map';
import type { GameState } from './game/state';
import { loadGame, newGameState, tickDay, saveGame, clearSave, setPolicy, setEconomicLaw, abolishSerfdom, hasOldSave, scaledNationPop, proposeReform, withdrawReform } from './game/state';
import type { LawCatType } from './game/state';
import { issueDebt, repayDebt, setMintRate } from './game/finance';
import { establish, improve, aid, tradePact, investRight, armsSale, armsRequest, takeLoan, embargo, coEmbargo, threatTariff, vassalize, borderFriction, insult, declareWar, peace } from './game/diplomacy';
import type { NationId, ProvinceOwner, Speed } from './game/types';
import type { TaxKind } from './game/tax';
import type { GoodId } from './game/types';
import { monthIndex, daysPerSecond } from './game/clock';
import { retrainPop } from './game/labor';
import { cancelInvestment, startInvestment, nationalizeProject } from './game/buildings';
import type { BuildingKind } from './game/buildings';
import { NATIONS, NATION_LIST } from './game/nations';
import { clampTax } from './game/tax';
import { sfxClick, sfxPanel, sfxSlider } from './game/sound';
import WorldMap from './components/WorldMap';
import TopBar from './components/TopBar';
import GovernancePanel from './components/GovernancePanel';
import ProvincePanel from './components/ProvincePanel';
import BorderEditor from './components/BorderEditor';

/** v0.6 国界编辑 localStorage 键（保存/加载覆盖表 {provinceId: nationId}） */
export const BORDER_EDIT_KEY = 'kalt-border-edits';

function loadBorderEdits(): Record<number, ProvinceOwner> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const text = localStorage.getItem(BORDER_EDIT_KEY);
    if (!text) return {};
    const parsed = JSON.parse(text) as Record<number, ProvinceOwner>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveBorderEdits(o: Record<number, ProvinceOwner>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(BORDER_EDIT_KEY, JSON.stringify(o));
  } catch {
    // 忽略（隐私模式等）
  }
}

export default function App() {
  const mapRef = useRef<GameMap | null>(null);
  if (!mapRef.current) mapRef.current = loadMap();
  const map = mapRef.current;

  const [game, setGame] = useState<GameState>(() =>
    loadGame() ?? newGameState('lorraine', (Date.now() >>> 0) % 0x7fffffff, map),
  );
  const gameRef = useRef(game);
  gameRef.current = game;

  const [selectedProvince, setSelectedProvince] = useState<number | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [oldSaveNotice, setOldSaveNotice] = useState<boolean>(() => hasOldSave());
  const [staleBorderNotice, setStaleBorderNotice] = useState(false); // v0.7：旧国界编辑因省 id 重构失效
  const [showNationPicker, setShowNationPicker] = useState(false);
  const [govCollapsed, setGovCollapsed] = useState(false); // v0.5 左侧治理面板可折叠
  const flashTimer = useRef<number | null>(null);

  // ---- v0.7 全局音效：按钮点击（data-sfx 覆盖）/ 滑块轻响 ----
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const btn = t?.closest?.('button');
      if (!btn) return;
      const sfx = btn.getAttribute('data-sfx');
      if (sfx === 'panel') sfxPanel();
      else if (sfx !== 'none') sfxClick();
    };
    const onInput = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'range') sfxSlider();
    };
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('input', onInput);
    };
  }, []);

  // ---- v0.6 独立编辑模式（国界重绘） ----
  const [editMode, setEditMode] = useState(false);
  const editModeRef = useRef(editMode);
  editModeRef.current = editMode;
  const [editNation, setEditNation] = useState<ProvinceOwner>('empire');
  const [borderOverrides, setBorderOverrides] = useState<Record<number, ProvinceOwner>>(() => loadBorderEdits());
  const [history, setHistory] = useState<Record<number, ProvinceOwner>[]>(() => [loadBorderEdits()]);
  const [histIndex, setHistIndex] = useState(0);
  const [editStamp, setEditStamp] = useState(0);
  // 开局应用 localStorage 覆盖（仅一次；map 为进程内单例）
  // v0.7：省份 id 重构 → 旧覆盖全部失效（任一 id 匹配当前省份才应用，否则提示清空重建）
  const appliedRef = useRef(false);
  useEffect(() => {
    if (appliedRef.current) return;
    appliedRef.current = true;
    const saved = loadBorderEdits();
    if (Object.keys(saved).length > 0) {
      let anyMatch = false;
      for (const key of Object.keys(saved)) {
        if (map.provinceById.get(Number(key))) {
          anyMatch = true;
          break;
        }
      }
      if (anyMatch) {
        applyBorderOverrides(map, saved);
        setEditStamp((x) => x + 1); // 触发画布按覆盖后归属重绘
      } else {
        try {
          localStorage.removeItem(BORDER_EDIT_KEY);
        } catch {
          // 忽略
        }
        setStaleBorderNotice(true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 实时时钟：rAF + dt 驱动（暂停 / 1x / 2x / 3x；编辑模式下不推进）
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const s = gameRef.current;
      if (s.speed > 0 && !editModeRef.current) {
        acc += dt * daysPerSecond(s.speed);
        while (acc >= 1) {
          tickDay(s, map);
          acc -= 1;
        }
        // 每月自动存档
        const mi = monthIndex(s.day);
        if (mi > 0 && mi !== s.lastAutosaveMonth) {
          s.lastAutosaveMonth = mi;
          saveGame(s);
        }
        setGame({ ...s });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [map]);

  const flash = () => {
    setSavedFlash(true);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1600);
  };

  const actions = {
    setSpeed(s: Speed) {
      const g = gameRef.current;
      if (s > 0) g.prevSpeed = s;
      g.speed = s;
      setGame({ ...g });
    },
    togglePause() {
      const g = gameRef.current;
      actions.setSpeed(g.speed === 0 ? (g.prevSpeed || 1) : 0);
    },
    setNation(id: NationId) {
      const g = gameRef.current;
      g.playerNation = id;
      setGame({ ...g });
    },
    /** v0.4 五税种连续滑块（0%-30%） */
    setTaxRate(kind: TaxKind, value: number) {
      const g = gameRef.current;
      g.nations[g.playerNation].tax.rates[kind] = clampTax(value);
      setGame({ ...g });
    },
    /** v0.4 单一商品税滑块（全部商品可选，0%-30%） */
    setGoodsTax(good: GoodId, value: number) {
      const g = gameRef.current;
      g.nations[g.playerNation].tax.goods[good] = clampTax(value);
      setGame({ ...g });
    },
    setSpending(kind: 'military' | 'admin' | 'infra' | 'court' | 'health', value: number) {
      const g = gameRef.current;
      g.nations[g.playerNation].spending[kind] = value;
      setGame({ ...g });
    },
    retrain(provId: number, popIndex: number) {
      const g = gameRef.current;
      retrainPop(g, map, provId, popIndex);
      setGame({ ...g });
    },
    invest(kind: BuildingKind, provId: number) {
      const g = gameRef.current;
      startInvestment(g, map, kind, provId);
      setGame({ ...g });
    },
    cancelInvest(projectId: number) {
      const g = gameRef.current;
      cancelInvestment(g, projectId);
      setGame({ ...g });
    },
    nationalize(projectId: number) {
      const g = gameRef.current;
      nationalizeProject(g, projectId);
      setGame({ ...g });
    },
    togglePolicy(policy: 'progressiveTax' | 'universalSuffrage', on: boolean) {
      const g = gameRef.current;
      setPolicy(g, policy, on);
      setGame({ ...g });
    },
    setEconomicLaw(law: 'traditionalism' | 'laissezFaire' | 'draconian') {
      const g = gameRef.current;
      setEconomicLaw(g, law);
      setGame({ ...g });
    },
    /** v0.10 政治：提出改革 / 撤回 */
    proposeReform(cat: LawCatType, target: number) {
      const g = gameRef.current;
      proposeReform(g, cat, target);
      setGame({ ...g });
    },
    withdrawReform() {
      const g = gameRef.current;
      withdrawReform(g);
      setGame({ ...g });
    },
    /** v0.11 金融：发行/归还国债、设定铸币率 */
    issueDebt(amount: number) {
      const g = gameRef.current;
      issueDebt(g, amount);
      setGame({ ...g });
    },
    repayDebt(amount: number) {
      const g = gameRef.current;
      repayDebt(g, amount);
      setGame({ ...g });
    },
    setMintRate(rate: number) {
      const g = gameRef.current;
      setMintRate(g, rate);
      setGame({ ...g });
    },
    /** v0.16 外交行动 */
    diplo(action: string, oid: NationId, extra?: number | string) {
      const g = gameRef.current;
      let r;
      switch (action) {
        case 'establish': r = establish(g, oid); break;
        case 'improve': r = improve(g, oid); break;
        case 'aid': r = aid(g, oid); break;
        case 'pact': r = tradePact(g, oid, (extra ?? 1) as 1 | 2 | 3); break;
        case 'invest': r = investRight(g, oid, (extra ?? 3) as 1 | 2 | 3); break;
        case 'armsSale': r = armsSale(g, oid); break;
        case 'armsRequest': r = armsRequest(g, oid); break;
        case 'loan': r = takeLoan(g, oid); break;
        case 'embargo': r = embargo(g, oid); break;
        case 'coEmbargo': r = coEmbargo(g, oid, (extra ?? '') as NationId); break;
        case 'threat': r = threatTariff(g, oid, (extra ?? 'coal') as string); break;
        case 'vassalize': r = vassalize(g, oid); break;
        case 'border': r = borderFriction(g, oid); break;
        case 'insult': r = insult(g, oid); break;
        case 'war': r = declareWar(g, oid); break;
        case 'peace': r = peace(g, oid, (extra ?? 'statusQuo') as string); break;
        default: r = { ok: false, reason: '未知行动' };
      }
      if (r.ok) setGame({ ...g });
      return r;
    },
    /** v0.8 开放贸易（国家开关：false=自给不贸易；true=按世界价进出口+关税） */
    setOpenTrade(on: boolean) {
      const g = gameRef.current;
      g.nations[g.playerNation].openTrade = on;
      setGame({ ...g });
    },
    /** v0.8 出口权（省授予/收回：获权省商品可入国际市场） */
    setExportRight(provId: number, on: boolean) {
      const g = gameRef.current;
      g.nations[g.playerNation].exportRights[provId] = on;
      setGame({ ...g });
    },
    abolish() {
      const g = gameRef.current;
      if (abolishSerfdom(g, map)) {
        setGame({ ...g });
        flash();
      } else {
        window.alert('废农奴制不可用：当前无奴隶或已废除。');
      }
    },
    save() {
      if (saveGame(gameRef.current)) flash();
    },
    newGame() {
      if (!window.confirm('开始新游戏？当前进度将被覆盖。')) return;
      setShowNationPicker(true);
    },
    startNewGame(nation: NationId) {
      const g = newGameState(nation, (Date.now() >>> 0) % 0x7fffffff, map);
      clearSave();
      setOldSaveNotice(false);
      setSelectedProvince(null);
      setShowNationPicker(false);
      setGame(g);
    },
  };

  // ---- v0.6 编辑模式操作 ----
  const applySnapshot = (snap: Record<number, ProvinceOwner>) => {
    applyBorderOverrides(map, snap);
    setBorderOverrides(snap);
    setEditStamp((x) => x + 1);
  };
  const pushSnapshot = (snap: Record<number, ProvinceOwner>) => {
    const h = history.slice(0, histIndex + 1);
    h.push(snap);
    setHistory(h);
    setHistIndex(h.length - 1);
    applySnapshot(snap);
  };
  const paintProvince = (provId: number) => {
    if (editNation === 'undiscovered') return; // 迷雾锁：不绘制
    const prov = map.provinceById.get(provId);
    if (!prov || prov.isUndiscovered) return; // 迷雾省份不可点
    if (prov.owner === editNation) return;
    // 改回默认归属时删除覆盖条目（保持导出配置最小）
    const next = { ...borderOverrides };
    if (editNation === map.defaultOwners.get(provId)) delete next[provId];
    else next[provId] = editNation;
    pushSnapshot(next);
  };
  const undoEdits = () => {
    if (histIndex <= 0) return;
    const prev = history[histIndex - 1];
    setHistIndex(histIndex - 1);
    applySnapshot(prev);
  };
  const redoEdits = () => {
    if (histIndex >= history.length - 1) return;
    const next = history[histIndex + 1];
    setHistIndex(histIndex + 1);
    applySnapshot(next);
  };
  const clearEdits = () => {
    const base: Record<number, ProvinceOwner> = {};
    for (const [pid, owner] of map.defaultOwners) base[pid] = owner;
    applyBorderOverrides(map, base);
    pushSnapshot({});
  };
  const saveEdits = () => {
    saveBorderEdits(borderOverrides);
    flash();
  };
  const exportEdits = () => {
    const blob = new Blob([JSON.stringify(borderOverrides, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kalt-border-edits.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    flash();
  };
  const toggleEdit = () => {
    const g = gameRef.current;
    if (!editModeRef.current) {
      // 进入编辑模式：游戏时钟暂停（记住原速度），防误触
      if (g.speed > 0) g.prevSpeed = g.speed;
      g.speed = 0;
      setGame({ ...g });
      setEditMode(true);
    } else {
      // 退出：恢复游戏
      g.speed = g.prevSpeed || 1;
      setGame({ ...g });
      setEditMode(false);
      setSelectedProvince(null);
    }
  };

  // v0.5 键盘快捷键：空格=暂停/继续、1/2/3=速度、S=存档、N=新游戏（带确认）
  // v0.6 编辑模式下：Ctrl+Z=撤销 / Ctrl+Y=重做；其余快捷键禁用（防误触）
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const editActionsRef = useRef({ undoEdits, redoEdits });
  editActionsRef.current = { undoEdits, redoEdits };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (editModeRef.current) {
        if (e.ctrlKey || e.metaKey) {
          const key = e.key.toLowerCase();
          if (key === 'z' && !e.shiftKey) {
            e.preventDefault();
            editActionsRef.current.undoEdits();
          } else if (key === 'z' && e.shiftKey) {
            e.preventDefault();
            editActionsRef.current.redoEdits();
          } else if (key === 'y') {
            e.preventDefault();
            editActionsRef.current.redoEdits();
          }
        }
        return;
      }
      const a = actionsRef.current;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          a.togglePause();
          break;
        case '1':
          a.setSpeed(1);
          break;
        case '2':
          a.setSpeed(2);
          break;
        case '3':
          a.setSpeed(3);
          break;
        case 's':
        case 'S':
          a.save();
          break;
        case 'n':
        case 'N':
          a.newGame();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <TopBar
        game={game}
        onSpeed={actions.setSpeed}
        onNation={actions.setNation}
        onSave={actions.save}
        onNewGame={actions.newGame}
        editMode={editMode}
        onToggleEdit={toggleEdit}
      />
      <main className="main">
        <GovernancePanel
          game={game}
          map={map}
          onTaxRate={actions.setTaxRate}
          onGoodsTax={actions.setGoodsTax}
          onSpending={actions.setSpending}
          onRetrain={actions.retrain}
          onInvest={actions.invest}
          onCancelInvest={actions.cancelInvest}
          onNationalize={actions.nationalize}
          onTogglePolicy={actions.togglePolicy}
          onEconomicLaw={actions.setEconomicLaw}
          onProposeReform={actions.proposeReform}
          onWithdrawReform={actions.withdrawReform}
          onIssueDebt={actions.issueDebt}
          onRepayDebt={actions.repayDebt}
          onSetMintRate={actions.setMintRate}
          onDiplo={actions.diplo}
          onAbolish={actions.abolish}
          onToggleTrade={actions.setOpenTrade}
          onExportRight={actions.setExportRight}
          collapsed={govCollapsed}
          onToggleCollapse={() => setGovCollapsed((c) => !c)}
        />
        <div className="map-area">
          {editMode && (
            <>
              <div className="edit-banner">
                ⚠ 编辑模式：游戏时钟已暂停 · 选择国家后点击地图省份改属 · 迷雾区锁定不可编辑 · Ctrl+Z/Y 撤销/重做
              </div>
              <BorderEditor
                nation={editNation}
                onNation={setEditNation}
                canUndo={histIndex > 0}
                canRedo={histIndex < history.length - 1}
                onUndo={undoEdits}
                onRedo={redoEdits}
                onClear={clearEdits}
                onSave={saveEdits}
                onExport={exportEdits}
                overrideCount={Object.keys(borderOverrides).length}
              />
            </>
          )}
          <WorldMap
            map={map}
            game={game}
            selectedProvince={selectedProvince}
            onSelect={setSelectedProvince}
            editMode={editMode}
            editNation={editNation}
            onPaintProvince={paintProvince}
            editStamp={editStamp}
          />
        </div>
        <ProvincePanel map={map} game={game} selectedProvince={selectedProvince} />
      </main>
      {savedFlash && <div className="toast">已保存到本机</div>}
      {oldSaveNotice && (
        <div className="toast old-save-toast" onClick={() => setOldSaveNotice(false)}>
          ⚠ 检测到 v0.6 及更早旧存档（不兼容 v0.7：山川形便省界重划/省份 id 重构/存档 v8），已开启新局；点击关闭
        </div>
      )}
      {staleBorderNotice && (
        <div className="toast old-save-toast" onClick={() => setStaleBorderNotice(false)}>
          ⚠ 检测到旧版国界编辑（v0.7 省份 id 已重构，原覆盖失效），已清空重建；可在「编辑模式」重新绘制后保存；点击关闭
        </div>
      )}
      {showNationPicker && (
        <div className="modal-overlay" onClick={() => setShowNationPicker(false)}>
          <div className="nation-picker" onClick={(e) => e.stopPropagation()}>
            <h3>选择你的国家（8 国全可玩）</h3>
            <p className="dim">新历 1023 年 · 工业革命前夜。人口按地图住房容量缩放，各国政体/识字率/资源禀赋各异</p>
            <div className="nation-picker-grid">
              {NATION_LIST.map((d) => (
                <button key={d.id} className="nation-pick-card" onClick={() => actions.startNewGame(d.id)}>
                  <span className="nation-pick-dot" style={{ background: d.color }} />
                  <b>{d.name}</b>
                  <em className="dim">{d.gov} · 开局 {Math.round(scaledNationPop(map, d.id))} 万 · 识字 {(d.literacy * 100).toFixed(0)}%</em>
                  <span className="dim">{NATIONS[d.id].economy}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
