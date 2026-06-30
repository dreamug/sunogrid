'use client';

/** 空状态:沿用素材编辑器(ClipEditor compact)的外壳,数据为空、禁用。 */
export function EmptyEditor({ hint }: { hint?: string }) {
  const cells: [string, string][] = [['Tempo', '—'], ['Length', '—'], ['Pitch', '—'], ['Stretch', '—']];
  return (
    <div className="ed-wrap">
      <div className="we we-compact" style={{ opacity: 0.72 }}>
        <div className="we-ctrl">
          <div className="we-ctrl-body">
            <div className="we-rail">
              <div className="we-grid">
                {cells.map(([l, v]) => (<div className="we-cell" key={l}><span className="we-lab">{l}</span><div className="we-box">{v}</div></div>))}
              </div>
              <div className="we-gridrow"><div className="seg we-gseg">{['1/1', '1/2', '1/4', '1/8', '1/16'].map((g, i) => (<button key={g} className={i === 2 ? 'on' : ''} disabled>{g}</button>))}</div></div>
            </div>
          </div>
        </div>
        <div className="we-main">
          <div className="we-stage" style={{ cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="muted small" style={{ textAlign: 'center', padding: '0 20px' }}>{hint ?? 'Click a sample on the left to pre-adjust · or click a stage instrument'}</span>
          </div>
          <div className="we-scroll"><div className="we-thumb" style={{ left: 0, width: '100%' }} /></div>
        </div>
      </div>
    </div>
  );
}
