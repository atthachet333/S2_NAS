import { env } from '../../config/env.js';
import { FakeDocumentAssistantProvider } from './fake.provider.js';
import { LlamaCppDocumentAssistantProvider } from './llama-cpp.provider.js';
import type { DocumentAssistantProvider } from './provider.js';

let instance: DocumentAssistantProvider | undefined;
export function documentAssistantProvider() {
  return instance ??= env.S2_NAS_ASSISTANT_PROVIDER === 'FAKE'
    ? new FakeDocumentAssistantProvider()
    : new LlamaCppDocumentAssistantProvider();
}

/** Test-only dependency seam; production code never calls this. */
export function setDocumentAssistantProviderForTests(provider?: DocumentAssistantProvider) { instance = provider; }
