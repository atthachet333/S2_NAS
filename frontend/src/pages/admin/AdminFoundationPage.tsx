import type { LucideIcon } from 'lucide-react';
import { EmptyState } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { Panel, PanelBody, PanelHeader, Badge } from '@/components/ui/Panel';

export function AdminFoundationPage({ title, description, icon: Icon, emptyTitle, emptyDescription }: { title: string; description: string; icon: LucideIcon; emptyTitle: string; emptyDescription: string }) {
  return <div className="space-y-4"><PageTitle title={title} description={description} /><Panel><PanelHeader title={title} description={description} action={<Badge tone="neutral">Foundation</Badge>} /><PanelBody className="p-0"><EmptyState compact icon={<Icon className="h-6 w-6" />} title={emptyTitle} description={emptyDescription} /></PanelBody></Panel></div>;
}
