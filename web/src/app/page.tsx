import { redirect } from 'next/navigation';

// 根路由 → 工作台(未登录会被 middleware 拦到 /login)。
export default function Home() {
  redirect('/projects');
}
