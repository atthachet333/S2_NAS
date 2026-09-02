import { ShieldCheck } from 'lucide-react';
import { Panel, PanelBody, PanelHeader, Badge } from '@/components/ui/Panel';
import { EmptyState } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';

export default function AdminPermissionsPage() {
  return (
    <div className="space-y-4">
      <PageTitle title="สิทธิ์" description="กำหนดสิทธิ์การเข้าถึงไฟล์และโฟลเดอร์" />
      <Panel>
        <PanelHeader
          title="สิทธิ์การเข้าถึง"
          description="รูปแบบสิทธิ์: OWNER, EDITOR, VIEWER"
          action={<Badge tone="neutral">Phase 2</Badge>}
        />
        <PanelBody className="p-0">
          <EmptyState
            icon={<ShieldCheck className="h-6 w-6" aria-hidden />}
            title="ยังไม่มีการกำหนดสิทธิ์"
            description="เมื่อมีผู้ใช้งานในระบบแล้ว จะกำหนดสิทธิ์ระดับโฟลเดอร์และไฟล์ได้ที่นี่"
          />
        </PanelBody>
      </Panel>
    </div>
  );
}
