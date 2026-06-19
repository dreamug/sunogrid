// 播放/停止图标 —— 用 SVG 取代 ▶/■ 字形:两态严格等大且居中、方块按视觉重量配平。
// (字形 ■ 在多数字体里比 ▶ 偏小且基线偏移,所以原来停止键看着小又没对齐。)
export function TransportIcon({ stop = false, size = 11 }: { stop?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ display: 'block', flex: 'none' }}>
      {stop ? <rect x="6" y="6" width="12" height="12" rx="1.5" /> : <path d="M8 5v14l11-7z" />}
    </svg>
  );
}
