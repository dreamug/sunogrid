// §34 文件名元数据解析单测(纯逻辑,无 DOM/引擎)。跑:  npx tsx src/audio/detect.test.ts
import { parseNameMeta } from './detect.ts';

let fails = 0;
const eq = (name: string, got: unknown, exp: unknown) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) console.log('ok   ', name);
  else { fails++; console.error('FAIL ', name, `→ got ${g}, expected ${e}`); }
};

// —— 真机样本(本人 Splice 库实测过的文件名)——
eq('NH 电吉他: 100 / D 大', parseNameMeta('NH_IAP_100_electric_guitar_slick_Dmaj.wav'), { bpm: 100, key: 'D' });
eq('SS 叠层: 111 / D# 小(AXR2 的 2 不误判)', parseNameMeta('SS_AXR2_111_melodic_stack_grease_bass_synth_vocals_D#m.wav'), { bpm: 111, key: 'D#m' });
eq('VOX adlib: 95 / D 大', parseNameMeta('VOX_BRUNER_95_vocal_adlib_lalala_Dmaj.wav'), { bpm: 95, key: 'D' });

// —— 调式后缀变体 + 降号归一到升号(对齐 estimateKey 的 ROOTS)——
eq('min 后缀 → 小调', parseNameMeta('loop_90_pad_Amin.wav'), { bpm: 90, key: 'Am' });
eq('降号 Eb → D#', parseNameMeta('artist_120_keys_Ebmin.wav'), { bpm: 120, key: 'D#m' });
eq('降号 Bb 大 → A#', parseNameMeta('x_128_lead_Bbmaj.wav'), { bpm: 128, key: 'A#' });
eq('降号 Cb 大 → B(跨白键)', parseNameMeta('y_100_pad_Cbmaj.wav'), { bpm: 100, key: 'B' });
eq('降号 Fb 小 → Em(跨白键)', parseNameMeta('z_92_keys_Fbm.wav'), { bpm: 92, key: 'Em' });

// —— 兜底:解析不出留 undefined(→ 调用方 DSP)——
eq('无 BPM/无 key', parseNameMeta('random_texture_sample.wav'), {});
eq('裸根音无后缀不当 key(C)', parseNameMeta('take_C_clean.wav'), {});
eq('4 位数不当 BPM(2020)', parseNameMeta('session_2020_idea_Gmaj.wav'), { key: 'G' });
eq('超范围数(240>220)不当 BPM', parseNameMeta('fast_240_riff.wav'), {});
eq('英文词 am 不误判成 A 小调', parseNameMeta('morning_85_vibe.wav'), { bpm: 85 });

if (fails) { console.error(`\n${fails} test(s) failed`); process.exit(1); }
else console.log('\nall parseNameMeta tests passed');
