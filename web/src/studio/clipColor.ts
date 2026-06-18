// 每个 clip 一个色。**只用于 pad 网格**(库里走灰)。要明显区分:
// stem 按乐器固定鲜明色,全混按 id hash。
const STEM: Record<string, string> = {
  drums: '#d8754f', bass: '#4f8fd0', other: '#9b6fc8',
  vocals: '#d56f9b', guitar: '#46b88a', piano: '#d6a84a',
};
const PALETTE = ['#d8754f', '#4f8fd0', '#9b6fc8', '#46b88a', '#d6a84a', '#d56f9b', '#4fbcc4', '#c98a5a'];

export function clipColor(opts: { stemKind?: string | null; id?: string | null }): string {
  if (opts.stemKind && STEM[opts.stemKind]) return STEM[opts.stemKind];
  const id = opts.id || '';
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
