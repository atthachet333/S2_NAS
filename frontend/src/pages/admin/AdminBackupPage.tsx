import { Database } from 'lucide-react';
import { Panel, PanelBody, PanelHeader, Badge } from '@/components/ui/Panel';
import { EmptyState } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';

export default function AdminBackupPage() {
  return (
    <div className="space-y-4">
      <PageTitle title="Backup" description="การสำรองฐานข้อมูลและไฟล์บนเซิร์ฟเวอร์" />
      <Panel>
        <PanelHeader
          title="ประวัติการสำรองข้อมูล"
          description="ครอบคลุมทั้ง database และ file storage"
          action={<Badge tone="neutral">Phase 6</Badge>}
        />
        <PanelBody className="p-0">
          <EmptyState
            icon={<Database className="h-6 w-6" aria-hidden />}
            title="ยังไม่มีการสำรองข้อมูล"
            description="เมื่อระบบ Backup เปิดใช้งาน ประวัติและสถานะล่าสุดจะแสดงที่นี่"
          />
        </PanelBody>
      </Panel>
    </div>
  );
}
