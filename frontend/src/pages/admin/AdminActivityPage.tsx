import { ScrollText } from 'lucide-react';
import { Panel, PanelBody, PanelHeader, Badge } from '@/components/ui/Panel';
import { EmptyState } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';

export default function AdminActivityPage() {
  return (
    <div className="space-y-4">
      <PageTitle title="Activity Log" description="บันทึกการใช้งานทั้งหมดในระบบ" />
      <Panel>
        <PanelHeader
          title="บันทึกกิจกรรม"
          description="การเข้าสู่ระบบ อัปโหลด ดาวน์โหลด แชร์ และลบไฟล์"
          action={<Badge tone="neutral">Phase 5</Badge>}
        />
        <PanelBody className="p-0">
          <EmptyState
            icon={<ScrollText className="h-6 w-6" aria-hidden />}
            title="ยังไม่มีบันทึกกิจกรรม"
            description="ระบบจะเริ่มบันทึกเมื่อเปิดใช้งานผู้ใช้งานและการจัดการไฟล์"
          />
        </PanelBody>
      </Panel>
    </div>
  );
}
