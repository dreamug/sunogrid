-- §43 音频采样率域宪法:Asset 加原生采样率诊断列(可见性,非约束;源资产允许任意 SR,解码实时 SRC 到 48k）。
ALTER TABLE `Asset`
  ADD COLUMN `sampleRate` INT NULL;
