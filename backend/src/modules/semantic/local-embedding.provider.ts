import { access } from 'node:fs/promises';
import path from 'node:path';
import { env as transformersEnv, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { env } from '../../config/env.js';
import { PriorityInferenceQueue, type InferencePriority } from './inference-queue.js';
import {
  SEMANTIC_DIMENSIONS,
  SEMANTIC_MODEL_DTYPE,
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_REVISION,
  SEMANTIC_MODEL_VERSION,
  SemanticModelNotConfiguredError,
  withPromptConvention,
  type EmbeddingModelInfo,
  type EmbeddingProvider,
  type EmbeddingPurpose,
} from './provider.js';

type TokenizerCallResult = { input_ids?: { dims?: number[]; data?: ArrayLike<number | bigint> } };
type RuntimePipeline = FeatureExtractionPipeline & {
  tokenizer: (text: string, options?: Record<string, unknown>) => TokenizerCallResult;
};

/**
 * Local-only provider. This module deliberately disables every remote model read
 * before a pipeline can be constructed. Provisioning lives in a separate CLI.
 */
export class LocalOnnxEmbeddingProvider implements EmbeddingProvider {
  readonly info: EmbeddingModelInfo;
  private extractor: RuntimePipeline | null = null;
  private initializing: Promise<void> | null = null;
  /**
   * ONNX session/tokenizer เป็นสถานะร่วม จึงต้องรันทีละงานเพื่อให้ผลคงที่
   *
   * แต่ "ทีละงาน" ไม่จำเป็นต้องแปลว่า "มาก่อนได้ก่อน" - คิวนี้ให้คำค้นของผู้ใช้
   * แซงงานทำดัชนีเบื้องหลังที่รออยู่ได้
   */
  private readonly queue = new PriorityInferenceQueue(env.S2_NAS_SEMANTIC_QUEUE_LIMIT);

  /** สถานะคิว - ใช้โดยหน้าจอผู้ดูแลและชุดทดสอบ */
  queueStats(): ReturnType<PriorityInferenceQueue['stats']> {
    return this.queue.stats();
  }

  constructor(private readonly modelPath = env.EMBEDDING_MODEL_PATH) {
    this.info = {
      provider: 'local-onnx',
      modelId: SEMANTIC_MODEL_ID,
      revision: SEMANTIC_MODEL_REVISION,
      modelVersion: SEMANTIC_MODEL_VERSION,
      dimensions: SEMANTIC_DIMENSIONS,
      dtype: SEMANTIC_MODEL_DTYPE,
      offlineRuntime: true,
      modelPath,
    };
  }

  async initialize(): Promise<void> {
    if (this.extractor) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeOnce();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  private async initializeOnce(): Promise<void> {
    try {
      await access(this.modelPath);
    } catch {
      throw new SemanticModelNotConfiguredError(
        `ไม่พบโมเดล semantic ที่ ${this.modelPath}; ใช้ npm run semantic:model-install ก่อน`,
      );
    }

    // Both switches are intentional defense in depth. Runtime must stay offline.
    transformersEnv.allowRemoteModels = false;
    transformersEnv.allowLocalModels = true;
    transformersEnv.cacheDir = this.modelPath;
    transformersEnv.localModelPath = path.join(this.modelPath, 'local');

    try {
      this.extractor = await pipeline('feature-extraction', SEMANTIC_MODEL_ID, {
        revision: SEMANTIC_MODEL_REVISION,
        dtype: SEMANTIC_MODEL_DTYPE,
        cache_dir: this.modelPath,
        local_files_only: true,
      }) as RuntimePipeline;
    } catch (error) {
      throw new SemanticModelNotConfiguredError(
        `เปิดโมเดล semantic ในเครื่องไม่ได้: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async countTokens(text: string, purpose: EmbeddingPurpose = 'passage'): Promise<number> {
    await this.initialize();
    const encoded = this.extractor!.tokenizer(withPromptConvention(text, purpose), {
      padding: false,
      truncation: false,
    });
    const dims = encoded.input_ids?.dims;
    if (dims?.length) return dims[dims.length - 1] ?? 0;
    return encoded.input_ids?.data?.length ?? 0;
  }

  async embed(
    text: string,
    purpose: EmbeddingPurpose,
    priority: InferencePriority = 'BACKGROUND',
  ): Promise<number[]> {
    const [vector] = await this.embedBatch([text], purpose, priority);
    return vector!;
  }

  async embedBatch(
    texts: string[],
    purpose: EmbeddingPurpose,
    priority: InferencePriority = 'BACKGROUND',
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.initialize();
    return this.queue.submit(priority, async () => {
      const tensor = await this.extractor!(texts.map((text) => withPromptConvention(text, purpose)), {
        pooling: 'mean',
        normalize: true,
      });
      const nested = tensor.tolist() as number[][];
      for (const vector of nested) {
        if (vector.length !== SEMANTIC_DIMENSIONS || vector.some((value) => !Number.isFinite(value))) {
          throw new Error(`โมเดล semantic คืน vector ไม่ถูกต้อง (ต้องเป็น ${SEMANTIC_DIMENSIONS} มิติ)`);
        }
      }
      return nested;
    });
  }

  async dispose(): Promise<void> {
    if (!this.extractor) return;
    await this.extractor.dispose();
    this.extractor = null;
  }
}

let sharedProvider: LocalOnnxEmbeddingProvider | null = null;

export function localEmbeddingProvider(): LocalOnnxEmbeddingProvider {
  sharedProvider ??= new LocalOnnxEmbeddingProvider();
  return sharedProvider;
}
