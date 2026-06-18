// signalsmith-stretch 没带类型,这里给最小声明(API 见其 README)。
declare module 'signalsmith-stretch' {
  export interface StretchNode extends AudioNode {
    inputTime: number;
    addBuffers(buffers: Float32Array[]): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<unknown>;
    schedule(opts: Record<string, number | boolean>): Promise<unknown>;
    start(when?: number): Promise<unknown>;
    stop(when?: number): Promise<unknown>;
    configure(opts: Record<string, unknown>): Promise<unknown>;
    latency(): Promise<number>;
    setUpdateInterval(seconds: number, cb?: (t: number) => void): Promise<unknown>;
  }
  const SignalsmithStretch: (
    ctx: BaseAudioContext,
    options?: AudioWorkletNodeOptions,
  ) => Promise<StretchNode>;
  export default SignalsmithStretch;
}
