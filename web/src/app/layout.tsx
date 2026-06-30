import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'SunoGrid',
  description: 'SunoGrid — browser AI loop machine, any style (Suno generation + 16-pad bank)',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // suppressHydrationWarning:翻译类浏览器扩展(如沉浸式翻译)会在 React 前给 <html>/<body> 注入属性,造成无害的 hydration 不匹配警告。
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
