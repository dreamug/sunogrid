// §43 音频采样率域宪法 —— 全仓唯一合法采样率。
// 所有偏移量(Clip.startSample/endSample、WarpPoint.src、Sound.warp/analysis、PadClip)都活在这个域;
// 所有 AudioContext / OfflineAudioContext 一律以此创建,永不跟随输出设备;入库音频写盘前一律 conform 到此。
// 病根与设计见 PRODUCT.md §43。
export const CANONICAL_SR = 48000;
