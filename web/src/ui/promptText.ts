'use client';
// 文本输入弹窗。
//   - web → 原生 window.prompt(行为与改动前一字不差)。
//   - desktop(Electron)→ 经 window.sunogrid.promptText 走 app 自带弹窗,
//     因为 Chromium 在 Electron 里禁用了 window.prompt(会抛 "prompt() is not supported")。
// 见 PRODUCT.md §19 铁律:web 分支保持原状,仅桌面加分支。
export async function promptText(message: string, def = ''): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const sg = (window as unknown as {
    sunogrid?: { promptText?: (m: string, d: string) => Promise<string | null> };
  }).sunogrid;
  if (sg?.promptText) return sg.promptText(message, def);
  return window.prompt(message, def);
}
