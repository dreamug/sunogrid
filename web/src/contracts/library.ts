// M5 库 / 工程后端 API 契约 —— Next Route Handlers 实现,MySQL 落库,音频存盘。
import type { LibraryLoop, MusicalKey, Project, SampleType } from './models';

export interface LoopFilter {
  q?: string;
  type?: SampleType;
  key?: MusicalKey;
  bpmMin?: number;
  bpmMax?: number;
  tags?: string[];
  favorite?: boolean;
  sort?: 'recent' | 'name' | 'bpm';
}

/** 从 Suno mp3 入库所需信息(后端服务端下载,绕 CORS)。 */
export interface IngestFromSunoInput {
  audioUrl: string;
  name: string;
  type: SampleType;
  nativeBpm: number | null;
  nativeKey: MusicalKey | null;
  sunoClipId?: string;
  prompt?: string;
}

export type ProjectSummary = Pick<Project, 'id' | 'name' | 'updatedAt'>;
export type LoopPatch = Partial<Pick<LibraryLoop, 'name' | 'tags' | 'favorite'>>;

export interface LibraryApi {
  listLoops(filter?: LoopFilter): Promise<LibraryLoop[]>;
  getLoop(id: string): Promise<LibraryLoop | null>;
  updateLoop(id: string, patch: LoopPatch): Promise<LibraryLoop>;
  deleteLoop(id: string): Promise<void>;

  /** 从 Suno mp3 地址下载入库。 */
  ingestFromSuno(input: IngestFromSunoInput): Promise<LibraryLoop>;
  /** 导入本地文件入库。 */
  importLocal(file: File): Promise<LibraryLoop>;

  listProjects(): Promise<ProjectSummary[]>;
  loadProject(id: string): Promise<Project>;
  saveProject(p: Project): Promise<void>;
}
