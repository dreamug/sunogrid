// Suno 桥接插件安装说明:登录页 block 变体(横排三段)+ 工作台右上角弹层 popover 变体(竖排)。
// 没上商店 → 下载未打包扩展 + 开发者模式加载;声明仅供学习、账号风险自负。下载链接/文案只此一处维护。
import { Fragment } from 'react';

const ZIP = '/suno-bridge.zip';
const ICON = '/suno.png';

const STEPS: { pre: string; em: string; post: string }[] = [
  { pre: 'open ', em: 'chrome://extensions', post: '' },
  { pre: 'turn on ', em: 'Developer mode', post: '' },
  { pre: '', em: 'Load unpacked', post: ' → pick the folder' },
];

const DownloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
  </svg>
);
const WarnIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l9 16H3z" /><path d="M12 10v4M12 17.4v.01" />
  </svg>
);
const warning = (
  <><b>For learning &amp; research only.</b> Replaying Suno&apos;s private API can get your account rate-limited or banned — your account, your risk.</>
);

export function BridgeInstall({ variant = 'block' }: { variant?: 'block' | 'popover' }) {
  if (variant === 'popover') {
    return (
      <>
        <div className="bx-head">
          <img src={ICON} alt="Suno" width={30} height={30} />
          <div>
            <div className="bx-tt">Suno Bridge extension</div>
            <div className="bx-ts">Runs in your browser · install once</div>
          </div>
        </div>
        <a className="bx-dl" href={ZIP} download><DownloadIcon />Download .zip</a>
        <div className="bx-steps">
          {STEPS.map((s, i) => (
            <div className="bx-step" key={i}><span className="bx-n">{i + 1}</span><span>{s.pre}<em>{s.em}</em>{s.post}</span></div>
          ))}
        </div>
        <div className="bx-warn"><WarnIcon /><p>{warning}</p></div>
      </>
    );
  }
  return (
    <div className="auth-ext">
      <div className="ax-main">
        <span className="ax-icon"><img src={ICON} alt="Suno" width={34} height={34} /></span>
        <div className="ax-t">
          <div className="ax-tt">Suno Bridge extension</div>
          <div className="ax-ts">Needed to generate — it runs in your own browser. Install once.</div>
        </div>
        <a className="ax-dl" href={ZIP} download><DownloadIcon />Download .zip</a>
      </div>
      <div className="ax-steps">
        {STEPS.map((s, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="ax-sep">→</span>}
            <span><span className="ax-n">{i + 1}</span>{s.pre}<em>{s.em}</em>{s.post}</span>
          </Fragment>
        ))}
      </div>
      <div className="ax-warn"><WarnIcon /><p>{warning}</p></div>
    </div>
  );
}
