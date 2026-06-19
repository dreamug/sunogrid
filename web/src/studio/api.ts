'use client';
// 前端 → 后端持久化 API 的薄客户端。
import type { FxConfig } from '@/contracts';
const J = async (r: Response) => {
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`);
  return r.json();
};
const post = (p: string, b: unknown) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(J);
const patch = (p: string, b: unknown) => fetch(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(J);
const del = (p: string) => fetch(p, { method: 'DELETE' }).then(J);

export interface ApiGenPrefs { mode: 'sound' | 'advanced'; loop: boolean; bpm: number }
export interface ApiGridPrefs { arrange: number; warp: number; snap: boolean }
export interface ApiProject { id: string; name: string; masterBpm: number; masterKey: string | null; genPrefs: ApiGenPrefs | null; gridPrefs: ApiGridPrefs | null; fx: FxConfig | null; quantize: string; beatsPerBar: number }
export interface ApiAsset { id: string; path: string; contentType: string }
export interface ApiSound {
  id: string; name: string; mode: string; sourceBpm: number; musicalKey: string | null;
  durationSec: number; sampleRate: number; channels: number;
  analysis: unknown; warp: unknown; assetId: string; asset?: ApiAsset; originProjectId: string | null; genId: string | null;
  parentSoundId?: string | null; stemKind?: string | null; stemStatus?: string | null; stems?: ApiSound[];
}
export interface ApiPad {
  id: string; projectId: string; bank: number; padIndex: number;
  sourceSoundId: string | null; assetId: string; warp: unknown; label: string | null; gainDb: number;
  asset?: ApiAsset; sourceSound?: ApiSound;
}
export interface ApiGen { id: string; status: string; mode: string; prompt: string; bpm: number; musicalKey?: string | null; loop?: boolean; error: string | null; sunoClipIds: unknown; sounds?: ApiSound[] }

export const cdnUrl = (assetId: string) => `/api/cdn/${assetId}`;

export const api = {
  projects: {
    list: (): Promise<ApiProject[]> => fetch('/api/projects').then(J),
    create: (b: Partial<ApiProject>): Promise<ApiProject> => post('/api/projects', b),
    update: (id: string, b: Partial<ApiProject>): Promise<ApiProject> => patch(`/api/projects/${id}`, b),
  },
  gens: {
    list: (projectId: string): Promise<ApiGen[]> => fetch(`/api/gens?projectId=${projectId}`).then(J),
    create: (b: Record<string, unknown>): Promise<ApiGen> => post('/api/gens', b),
    patch: (id: string, b: Record<string, unknown>): Promise<ApiGen> => patch(`/api/gens/${id}`, b),
    remove: (id: string): Promise<{ ok: boolean }> => del(`/api/gens/${id}`),
  },
  sounds: {
    list: (): Promise<ApiSound[]> => fetch('/api/sounds').then(J),
    create: (b: Record<string, unknown>): Promise<ApiSound> => post('/api/sounds', b),
    patch: (id: string, b: Record<string, unknown>): Promise<ApiSound> => patch(`/api/sounds/${id}`, b),
    remove: (id: string): Promise<{ ok: boolean }> => del(`/api/sounds/${id}`),
    separate: (id: string): Promise<{ ok: boolean; stems?: ApiSound[]; error?: string }> => post(`/api/sounds/${id}/separate`, {}),
  },
  stemService: (): Promise<{ up: boolean; device?: string; sources?: string[] }> => fetch('/api/stem-service').then(J),
  pads: {
    list: (projectId: string): Promise<ApiPad[]> => fetch(`/api/pads?projectId=${projectId}`).then(J),
    place: (b: Record<string, unknown>): Promise<ApiPad> => post('/api/pads', b),
    patch: (id: string, b: Record<string, unknown>): Promise<ApiPad> => patch(`/api/pads/${id}`, b),
    remove: (id: string): Promise<unknown> => del(`/api/pads/${id}`),
  },
  warpRender: {
    get: (signature: string): Promise<{ assetId: string; cdn: string } | null> => fetch(`/api/warp-render?signature=${encodeURIComponent(signature)}`).then(J),
    put: (b: Record<string, unknown>): Promise<{ assetId: string; cdn: string }> => post('/api/warp-render', b),
  },
};
