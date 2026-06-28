// §35 AI 提示词助手:自然语言 idea → 一行 Suno 风格提示词。
// 走阿里云百炼 DashScope 的 OpenAI 兼容接口,用最便宜的 qwen 档。
// key 只在服务端读(DASHSCOPE_API_KEY),绝不下发前端;未配置则 503(前端据此提示)。
import { getCurrentUser, unauthorized } from '@/lib/auth';
import { rateLimit } from '@/lib/rateLimit';

const BASE = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MODEL = process.env.QWEN_MODEL || 'qwen-flash';

// 两种模式不是一回事:Sound = 单一乐器/音色的片段 loop;Song = 一整首器乐曲。系统提示词分开写。
const COMMON_RULES = `Rules:
- Output ONLY the prompt — one line of comma-separated descriptors. No preamble, no quotes, no explanation, no trailing period.
- These tracks are instrumental: never request vocals; end the line with "instrumental".
- Do NOT write a BPM number or a musical key in the text — Suno has separate fields for those.
- ALWAYS write the prompt in English, no matter what language the idea is written in. Never output Chinese or any non-English words — translate the intent into English descriptors.`;

const SYSTEM_SOUND = `You are a prompt engineer for Suno, an AI music generator. The user wants a SHORT LOOP or one-shot SAMPLE of a SINGLE sound or instrument — NOT a full song. Convert their idea into one concise Suno prompt describing that one sound: the instrument/source, its timbre and character, the groove or articulation, and the production texture. Keep it tight (~6–12 descriptors) and focused on that single element.

${COMMON_RULES}`;

const SYSTEM_SONG = `You are a prompt engineer for Suno, an AI music generator. The user wants a FULL instrumental TRACK — a complete song. Convert their idea into one Suno prompt describing the whole piece: genre, mood, the main instruments, the arrangement and energy, and the overall production. It can be a little fuller and more cinematic than a single-loop prompt.

${COMMON_RULES}`;

const systemFor = (mode: string) => (mode === 'advanced' ? SYSTEM_SONG : SYSTEM_SOUND);

function userMessage(idea: string, bpm?: number, key?: string): string {
  const ctx = [bpm ? `${bpm} BPM` : '', key || ''].filter(Boolean).join(', ');
  const feel = ctx ? `\n\nTarget feel (for your judgement only — do NOT put these words in the prompt): ${ctx}.` : '';
  return `Idea: ${idea}${feel}`;
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return Response.json({ error: 'AI prompt assist is not configured' }, { status: 503 });

  // 防滥用:按用户,30 次 / 分钟。只用 user.id 做键 —— 不掺 IP,否则同一用户换 IP 即可把额度翻倍刷成本。
  const rl = rateLimit(`ai-prompt:${user.id}`, 30, 60_000);
  if (!rl.ok) return Response.json({ error: 'Too many requests — slow down a moment' }, { status: 429 });

  const b = await req.json().catch(() => ({}));
  const idea = String(b?.idea ?? '').trim();
  if (!idea) return Response.json({ error: 'Write an idea first' }, { status: 400 });
  if (idea.length > 1000) return Response.json({ error: 'Idea is too long' }, { status: 400 });
  const mode = b?.mode === 'advanced' ? 'advanced' : 'sound';

  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.7,
        max_tokens: 200,
        messages: [
          { role: 'system', content: systemFor(mode) },
          { role: 'user', content: userMessage(idea, Number(b?.bpm) || undefined, b?.key ? String(b.key) : undefined) },
        ],
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('[ai/prompt] upstream', r.status, detail.slice(0, 300));
      return Response.json({ error: 'The model service returned an error — try again' }, { status: 502 });
    }
    const j = await r.json();
    // 去掉模型偶发的包裹引号/前后空白/句末标点。
    const prompt = String(j?.choices?.[0]?.message?.content ?? '')
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/[。.]\s*$/, '')
      .trim();
    if (!prompt) return Response.json({ error: 'The model returned nothing — try again' }, { status: 502 });
    return Response.json({ prompt });
  } catch (e) {
    console.error('[ai/prompt]', e);
    return Response.json({ error: 'Could not reach the model service' }, { status: 502 });
  }
}
