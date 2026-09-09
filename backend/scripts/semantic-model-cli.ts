import { mkdir } from 'node:fs/promises';
import { env as transformersEnv, pipeline } from '@huggingface/transformers';
import { env } from '../src/config/env.js';
import {
  SEMANTIC_MODEL_DTYPE,
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_REVISION,
  withPromptConvention,
} from '../src/modules/semantic/provider.js';

async function install(): Promise<void> {
  if (process.argv[2] !== 'install') {
    throw new Error('คำสั่งที่รองรับ: install');
  }

  await mkdir(env.EMBEDDING_MODEL_PATH, { recursive: true });
  // Remote access is allowed only in this explicit provisioning command.
  transformersEnv.allowRemoteModels = true;
  transformersEnv.allowLocalModels = true;
  transformersEnv.cacheDir = env.EMBEDDING_MODEL_PATH;

  console.log(`กำลังติดตั้ง ${SEMANTIC_MODEL_ID} (${SEMANTIC_MODEL_DTYPE})`);
  console.log(`ปลายทาง: ${env.EMBEDDING_MODEL_PATH}`);
  const extractor = await pipeline('feature-extraction', SEMANTIC_MODEL_ID, {
    revision: SEMANTIC_MODEL_REVISION,
    dtype: SEMANTIC_MODEL_DTYPE,
    cache_dir: env.EMBEDDING_MODEL_PATH,
  });
  const probe = await extractor([withPromptConvention('ค้นหาเอกสารงบประมาณ', 'query'), withPromptConvention('annual budget document', 'passage')], {
    pooling: 'mean',
    normalize: true,
  });
  if (probe.dims[0] !== 2 || probe.dims[1] !== 384) {
    throw new Error(`โมเดลคืนมิติผิด: ${probe.dims.join('x')}`);
  }
  await extractor.dispose();
  console.log('ติดตั้งและตรวจโมเดลสำเร็จ; runtime สามารถทำงานแบบ offline ได้');
}

install().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
