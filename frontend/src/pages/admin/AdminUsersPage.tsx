import { Users } from 'lucide-react';
import { Panel, PanelBody, PanelHeader, Badge } from '@/components/ui/Panel';
import { EmptyState } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';

export default function AdminUsersPage() {
  return (
    <div className="space-y-4">
      <PageTitle title="ผู้ใช้งาน" description="จัดการบัญชีผู้ใช้และบทบาทในระบบ" />
      <Panel>
        <PanelHeader
          title="รายชื่อผู้ใช้งาน"
          description="ผู้ใช้ทั้งหมดที่เข้าถึง S2 NAS ได้"
          action={<Badge tone="neutral">Phase 2</Badge>}
        />
        <PanelBody className="p-0">
          <EmptyState
            icon={<Users className="h-6 w-6" aria-hidden />}
            title="ยังไม่มีผู้ใช้งานในระบบ"
            description="รายชื่อผู้ใช้จะปรากฏหลังเชื่อมต่อฐานข้อมูลและเปิดใช้งานระบบยืนยันตัวตน"
          />
        </PanelBody>
      </Panel>
    </div>
  );
}
