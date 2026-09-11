import type { DocumentAssistantProvider, GroundedGenerationInput, GroundedOutput } from './provider.js';

/** Deterministic provider for security/lifecycle tests; never presented as real-model QA. */
export class FakeDocumentAssistantProvider implements DocumentAssistantProvider {
  getModelInfo() { return { provider: 'fake', model: 'deterministic-test', quantization: 'none', contextTokens: 8192, offline: true as const }; }
  async health(): Promise<{ status: 'READY'; reason?: string }> { return { status: 'READY' }; }
  async countTokens(text: string) { return Math.ceil(text.length / 3); }
  async generateGroundedAnswer(input: GroundedGenerationInput): Promise<GroundedOutput> {
    if (!input.evidence.length) return { answer: 'ไม่พบข้อมูลนี้ในเอกสารที่คุณมีสิทธิ์เข้าถึง', usedEvidenceIds: [] };
    const first = input.evidence[0]!;
    const answer = input.language === 'en'
      ? `According to the available document: ${first.text.slice(0, 240)} [${first.id}]`
      : `จากเอกสารที่พบ: ${first.text.slice(0, 240)} [${first.id}]`;
    return { answer, usedEvidenceIds: [first.id] };
  }
}
