export const SEMANTIC_MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const SEMANTIC_MODEL_REVISION = 'main';
export const SEMANTIC_MODEL_DTYPE = 'q8';
export const SEMANTIC_DIMENSIONS = 384;

/**
 * รูปแบบคำนำหน้าของข้อความก่อนเข้าโมเดล
 *
 * ตระกูล E5 ต้องการ "query: " / "passage: " เพราะถูกฝึกแบบไม่สมมาตร
 * ส่วนตระกูล paraphrase-multilingual เป็นแบบสมมาตร ฝึกจากคู่ประโยคที่แปลกันข้ามภาษา
 * การเติมคำนำหน้าให้โมเดลสมมาตรคือการใส่ข้อความที่มันไม่เคยเห็นตอนฝึก
 */
export type PromptConvention = 'e5-prefix' | 'none';
export const SEMANTIC_PROMPT_CONVENTION: PromptConvention = 'none';

/** Changes whenever model, quantization, prompt convention, or pooling changes. */
export const SEMANTIC_MODEL_VERSION =
  `${SEMANTIC_MODEL_ID}@${SEMANTIC_MODEL_REVISION}:${SEMANTIC_MODEL_DTYPE}:symmetric-mean-v1`;

export type EmbeddingPurpose = 'query' | 'passage';

export interface EmbeddingModelInfo {
  provider: 'local-onnx';
  modelId: string;
  revision: string;
  modelVersion: string;
  dimensions: number;
  dtype: string;
  offlineRuntime: true;
  modelPath: string;
}

export interface EmbeddingProvider {
  readonly info: EmbeddingModelInfo;
  initialize(): Promise<void>;
  countTokens(text: string, purpose?: EmbeddingPurpose): Promise<number>;
  embed(text: string, purpose: EmbeddingPurpose): Promise<number[]>;
  embedBatch(texts: string[], purpose: EmbeddingPurpose): Promise<number[][]>;
  dispose(): Promise<void>;
}

export class SemanticModelNotConfiguredError extends Error {
  readonly code = 'SEMANTIC_MODEL_NOT_CONFIGURED';

  constructor(message = 'ยังไม่ได้ติดตั้งโมเดล semantic search ในเครื่อง') {
    super(message);
    this.name = 'SemanticModelNotConfiguredError';
  }
}

/**
 * เตรียมข้อความตามรูปแบบที่โมเดลปัจจุบันคาดหวัง
 *
 * ชื่อฟังก์ชันไม่ผูกกับตระกูลโมเดลใดโมเดลหนึ่ง เพราะการเปลี่ยนโมเดลคือสิ่งที่
 * เกิดขึ้นจริงแล้วหนึ่งครั้ง และจะเกิดอีกได้
 */
export function withPromptConvention(text: string, purpose: EmbeddingPurpose): string {
  return SEMANTIC_PROMPT_CONVENTION === 'e5-prefix' ? `${purpose}: ${text}` : text;
}
