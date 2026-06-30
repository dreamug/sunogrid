// SunoGrid 桌面宿主 —— Electron 主进程。
// 形态见 PRODUCT.md §19(2026-06-22 云端化复核):
//   桌面 = 「指向云端 web 后端的原生客户端 + 内嵌 Suno」。**不做本地存储/本地库/本地服务**。
//   - dev :窗口指向本地 next dev(localhost:3007,连 web/.env 的 MySQL);没起则按需拉起。
//   - prod:窗口直接 loadURL 云端部署(SUNOGRID_URL),数据/存储/账号全在云端。
//   桌面唯一的实体差异 = 内嵌 suno.com 驱动生成(C 案):隐藏窗口 + suno-preload + IPC,退役 Chrome 插件。
const { app, BrowserWindow, shell, ipcMain, Menu, session } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const isDev = !app.isPackaged;
const APP_URL = isDev
  ? process.env.APP_URL || 'http://localhost:3007'
  : process.env.SUNOGRID_URL || 'https://sunogrid.com';
const SUNO_URL = process.env.SUNO_URL || 'https://suno.com/create';
const WEB_DIR = path.join(__dirname, '..', 'web'); // 仅 dev 拉子进程用
const ICON_PNG = path.join(__dirname, 'build', 'icon.png'); // dock(mac dev)/ 窗口(win+linux)用;打包走 build/icon.icns

// dev 下 dock / 菜单默认显示 "Electron";显式定名 → 处处显示 SunoGrid(打包则走 electron-builder 的 productName)。
// 注意:改 app.name 也改了 userData 路径,故首次启动后内嵌 Suno 需重新登录一次。
app.setName('SunoGrid');

let win = null;
let sunoWin = null;
let devServerProc = null;
let quitting = false;

// ── 工具:URL 探活 ───────────────────────────────────────────────
function isUrlUp(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}
function waitForUrl(url, timeoutMs = 90000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await isUrlUp(url)) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('等待超时:' + url));
      setTimeout(tick, 500);
    };
    tick();
  });
}

/** dev 专用:拉起 web 的 next dev 子进程(若用户没自己起)。prod 无此步——直接连云端。 */
function startDevServer() {
  console.log('[desktop] 启动 web dev server @', WEB_DIR);
  devServerProc = spawn('npm', ['run', 'dev'], {
    cwd: WEB_DIR,
    env: { ...process.env, PORT: '3007' },
    stdio: 'inherit',
    shell: true,
  });
  devServerProc.on('exit', (code) => console.log('[desktop] web dev server 退出', code));
}

// §31 音频输出设备选择(setSinkId + 枚举设备名)需要媒体/设备权限。
// 桌面端自动授予 → 下拉框直接显示真实声卡名、切换免弹窗(比 web 更原生:省掉「为看设备名先授权麦克风」那步)。
// 仅桌面、零碰 web;只放行媒体/扬声器相关,其它权限照常拒。
function grantMediaAccess(ses) {
  const ok = (p) => p === 'media' || p === 'audioCapture' || p === 'speaker-selection';
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ok(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ok(permission));
  ses.setDevicePermissionHandler(() => true);
}

// ── 主窗口:加载云端/本地的 SunoGrid app ─────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0b0b0d',
    title: 'SunoGrid',
    icon: ICON_PNG, // win/linux 窗口与任务栏图标;mac 忽略此项,走下面的 dock.setIcon
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // §19:开
      nodeIntegration: false, // §19:关
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  win.loadURL(APP_URL);

  win.webContents.on('did-finish-load', async () => {
    try {
      const probe = await win.webContents.executeJavaScript(
        `(async () => {
          let outs = [];
          try { outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput'); } catch (_) {}
          return JSON.stringify({
            url: location.pathname,
            isDesktop: !!window.sunogrid,
            sunoBtn: !!document.getElementById('__sg_suno_btn'),
            audioOuts: outs.length,
            audioLabels: outs.filter((d) => d.label).length,
          });
        })()`,
      );
      console.log('[desktop] 加载完成 probe:', probe);
    } catch (e) {
      console.log('[desktop] probe 失败:', e && e.message);
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

// ── 内嵌 Suno:隐藏窗口 + suno-preload(C 案) ────────────────────
function createSunoWindow() {
  // 独立持久 session 分区 → 登录一次、重启不丢(替代插件「自带活会话」)。
  const ses = session.fromPartition('persist:suno');
  sunoWin = new BrowserWindow({
    width: 1100,
    height: 820,
    show: false, // 默认隐藏;只在需要登录时露出
    title: '连接 Suno',
    backgroundColor: '#0b0b0d',
    webPreferences: {
      session: ses,
      preload: path.join(__dirname, 'suno-preload.js'),
      // 关键:contextIsolation 关 → suno-preload 与页面共享 MAIN world,
      // 才能在反爬之前 patch fetch、暴露 window.__sunoDrive(executeJavaScript 调得到)。
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // 隐藏/后台时也要正常跑定时器(DOM 驱动靠 setTimeout)
    },
  });
  sunoWin.loadURL(SUNO_URL);

  // 关闭=隐藏(保活,别销毁,否则丢驱动器与会话上下文)。
  sunoWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      sunoWin.hide();
    }
  });

  // 首启若未登录,自动弹出登录窗;Clerk 异步加载,稍等再查。
  sunoWin.webContents.on('did-finish-load', async () => {
    try {
      for (let i = 0; i < 8; i++) {
        const st = await callDrive('status', false).catch((e) => ({ _err: String(e && e.message || e) }));
        console.log('[desktop] suno status probe:', JSON.stringify(st));
        if (st && st.hasAuth) {
          if (sunoWin.isVisible()) sunoWin.hide();
          return;
        }
        await new Promise((r) => setTimeout(r, 600));
      }
      showSunoLogin(); // 8 次还没登上 → 露出来让用户登
    } catch (_) {}
  });
}

function showSunoLogin() {
  if (!sunoWin || sunoWin.isDestroyed()) createSunoWindow();
  sunoWin.show();
  sunoWin.focus();
}

/** 在隐藏 suno 窗口里直接调 window.__sunoDrive.<method>(arg)。 */
function callDrive(method, hasArg, arg) {
  if (!sunoWin || sunoWin.isDestroyed()) return Promise.reject(new Error('Suno 窗口未就绪'));
  const argStr = hasArg ? JSON.stringify(arg === undefined ? null : arg) : '';
  const js =
    `(window.__sunoDrive` +
    ` ? window.__sunoDrive.${method}(${argStr})` +
    ` : Promise.reject(new Error('Suno 还没准备好:请在菜单「Suno → 登录」里登录,并停在 Create 页')))`;
  return sunoWin.webContents.executeJavaScript(js, true);
}

// ── 文本输入弹窗:Electron 没有原生 window.prompt(web 仍用原生,见 promptText.ts) ──
function promptDialog(message, def) {
  return new Promise((resolve) => {
    const pw = new BrowserWindow({
      width: 440,
      height: 210,
      parent: win || undefined,
      modal: !!win,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: '',
      backgroundColor: '#16161a',
      webPreferences: {
        preload: path.join(__dirname, 'prompt-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    let done = false;
    const onResult = (_e, val) => finish(val === undefined ? null : val);
    function finish(val) {
      if (done) return;
      done = true;
      ipcMain.removeListener('ui:prompt:result', onResult);
      if (!pw.isDestroyed()) pw.close();
      resolve(val);
    }
    ipcMain.on('ui:prompt:result', onResult);
    pw.on('closed', () => finish(null)); // 关窗 = 取消
    pw.loadFile(path.join(__dirname, 'prompt.html'), {
      query: { message: String(message == null ? '' : message), def: String(def == null ? '' : def) },
    });
    pw.once('ready-to-show', () => pw.show());
  });
}

// ── IPC:渲染页(经 preload 的 window.sunogrid.*)→ 主进程 → suno 驱动 / 弹窗 ──
function registerIpc() {
  ipcMain.handle('suno:status', () => callDrive('status', false));
  ipcMain.handle('suno:generate', async (_e, args) => {
    try {
      return await callDrive('generate', true, args);
    } catch (e) {
      // 生成失败/超时,最常见原因是 Suno 弹了验证码 / 人机校验,而隐藏窗口里用户看不到。
      // → 自动把 Suno 窗口露出来让用户处理(解完验证码再点 Retry 即可)。
      showSunoLogin();
      throw e;
    }
  });
  ipcMain.handle('suno:poll', (_e, clipIds) => callDrive('poll', true, clipIds));
  ipcMain.handle('suno:download', (_e, url) => callDrive('download', true, url));
  ipcMain.handle('suno:show-login', () => {
    showSunoLogin();
    return true;
  });
  ipcMain.handle('ui:prompt', (_e, opts) => promptDialog((opts || {}).message, (opts || {}).def));
}

// ── 菜单:保留默认编辑/视图(复制粘贴等),加一个 Suno 登录入口 ──
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Suno',
      submenu: [
        {
          label: '打开 Suno 窗口(登录 / 解验证码)',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => showSunoLogin(),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot() {
  if (isDev && !(await isUrlUp(APP_URL))) {
    startDevServer();
    await waitForUrl(APP_URL);
  } else if (isDev) {
    console.log('[desktop] 检测到', APP_URL, '已在跑,直接附着。');
  } else {
    console.log('[desktop] 连接云端:', APP_URL);
  }
  // mac dev:dock 默认是 Electron 原子图标 → 换成 SunoGrid 图标。打包后由 .icns 接管,此步只为 dev。
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(ICON_PNG); } catch (_) {}
  }
  buildMenu();
  registerIpc();
  grantMediaAccess(session.defaultSession); // §31 音频设备选择:建窗口前先放行媒体/设备权限
  createWindow();
  createSunoWindow(); // 后台预热 Suno(隐藏);未登录会自动弹出
}

app.whenReady().then(boot);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  if (devServerProc && !devServerProc.killed) {
    try {
      devServerProc.kill();
    } catch (_) {}
  }
});
