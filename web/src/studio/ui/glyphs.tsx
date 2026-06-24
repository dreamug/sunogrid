// 播放/停止图标 —— 用 SVG 取代 ▶/■ 字形:两态严格等大且居中、方块按视觉重量配平。
// (字形 ■ 在多数字体里比 ▶ 偏小且基线偏移,所以原来停止键看着小又没对齐。)
export function TransportIcon({ stop = false, size = 11 }: { stop?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ display: 'block', flex: 'none' }}>
      {stop ? <rect x="6" y="6" width="12" height="12" rx="1.5" /> : <path d="M8 5v14l11-7z" />}
    </svg>
  );
}

// §35 AI 提示词助手:单点 sparkle(monochrome,吃 currentColor → 跟随按钮态变色,不像 emoji 那样扎眼)。
export function SparkleIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ display: 'block', flex: 'none' }}>
      <path d="M12 1 Q13 10 23 12 Q13 14 12 23 Q11 14 1 12 Q11 10 12 1 Z" />
    </svg>
  );
}
