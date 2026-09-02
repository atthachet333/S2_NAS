import type { IntegrationAppDto, IntegrationScope } from './api';

export const INTEGRATION_SCOPE_OPTIONS: IntegrationScope[] = [
  'resources:read', 'resources:create', 'resources:upload',
  'resources:update', 'resources:download', 'resources:metadata',
];

export function integrationStatus(app: Pick<IntegrationAppDto, 'isActive' | 'credentials'>) {
  if (!app.isActive) return { code: 'DISABLED' as const, label: 'ปิดใช้งาน' };
  if (!app.credentials.some((credential) => !credential.revokedAt)) return { code: 'NO_CREDENTIAL' as const, label: 'ยังไม่มี Credential' };
  return { code: 'ACTIVE' as const, label: 'ใช้งานอยู่' };
}

export function activeCredentialCount(app: Pick<IntegrationAppDto, 'credentials'>) {
  return app.credentials.filter((credential) => !credential.revokedAt).length;
}
