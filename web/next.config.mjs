/** @type {import('next').NextConfig} */
const nextConfig = {
  // 核心是客户端实时应用;SSR 不参与音频/MIDI 核心。
  // 后续 M2 的 AudioWorklet / WASM、M5 的 MySQL 在各自阶段再加配置。
};

export default nextConfig;
