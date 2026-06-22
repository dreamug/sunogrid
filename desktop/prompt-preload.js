// 文本输入弹窗(prompt.html)的 preload。只暴露一个 submit 回传结果。
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('promptAPI', {
  submit: (value) => ipcRenderer.send('ui:prompt:result', value),
});
