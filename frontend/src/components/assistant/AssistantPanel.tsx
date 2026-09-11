import { useEffect, useRef, useState } from 'react';
import { Bot, Copy, FileText, History, Library, Send, Trash2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { assistantApi, type AssistantDiagnosticsDto, type AssistantMessageDto, type AssistantScope, type AssistantThreadDto } from '@/lib/api';

interface OpenDetail { resources?: Array<{ id: string; name: string }>; scope?: AssistantScope }
const quickPrompts = [
  ['สรุปเอกสาร', 'สรุปเอกสารนี้ให้หน่อย', 'SUMMARY'], ['ประเด็นสำคัญ', 'ประเด็นสำคัญมีอะไรบ้าง', 'EXTRACT'],
  ['วันที่สำคัญ', 'มีวันที่สำคัญอะไรบ้าง', 'EXTRACT'], ['จำนวนเงิน', 'มีจำนวนเงินอะไรระบุไว้บ้าง', 'EXTRACT'],
] as const;

export function AssistantPanel() {
  const [open, setOpen] = useState(false); const [scope, setScope] = useState<AssistantScope>('AUTHORIZED_LIBRARY');
  const [resources, setResources] = useState<Array<{ id: string; name: string }>>([]); const [threadId, setThreadId] = useState<string>();
  const [messages, setMessages] = useState<AssistantMessageDto[]>([]); const [question, setQuestion] = useState('');
  const [status, setStatus] = useState<'idle'|'retrieving'|'generating'|'error'>('idle'); const [error, setError] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<AssistantDiagnosticsDto>(); const [threads, setThreads] = useState<AssistantThreadDto[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null); const navigate = useNavigate();
  useEffect(() => { const handler = (event: Event) => { const detail = (event as CustomEvent<OpenDetail>).detail ?? {};
    const nextResources = detail.resources ?? []; setResources(nextResources); setScope(detail.scope ?? (nextResources.length === 1 ? 'CURRENT_RESOURCE' : nextResources.length ? 'SELECTED_RESOURCES' : 'AUTHORIZED_LIBRARY'));
    setThreadId(undefined); setMessages([]); setError(undefined); setHistoryOpen(false); setOpen(true);
    void loadStatusAndThreads(); setTimeout(() => inputRef.current?.focus(), 50); };
    window.addEventListener('s2-open-assistant', handler); return () => window.removeEventListener('s2-open-assistant', handler); }, []);
  async function loadStatusAndThreads() {
    const [healthResult, threadsResult] = await Promise.allSettled([assistantApi.health(), assistantApi.threads()]);
    if (healthResult.status === 'fulfilled') setDiagnostics(healthResult.value.data);
    if (threadsResult.status === 'fulfilled') setThreads(threadsResult.value.data);
  }
  async function openThread(thread: AssistantThreadDto) {
    try {
      const response = await assistantApi.thread(thread.id); const detail = response.data;
      setThreadId(detail.id); setScope(detail.scope); setResources(detail.resources);
      setMessages(detail.messages ?? []); setHistoryOpen(false); setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'เปิดการสนทนาไม่สำเร็จ'); }
  }
  async function removeThread(id: string) {
    try {
      await assistantApi.remove(id); setThreads((old) => old.filter((thread) => thread.id !== id));
      if (threadId === id) { setThreadId(undefined); setMessages([]); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ลบการสนทนาไม่สำเร็จ'); }
  }
  async function ask(text: string, mode: 'QA'|'SUMMARY'|'COMPARE'|'EXTRACT' = 'QA') {
    const value = text.trim(); if (!value || status === 'retrieving' || status === 'generating' || (diagnostics && (!diagnostics.enabled || diagnostics.status !== 'READY'))) return;
    const effectiveMode = mode === 'QA' && scope === 'SELECTED_RESOURCES' && /เปรียบเทียบ|compare|แตกต่าง/iu.test(value)
      ? 'COMPARE'
      : mode;
    const localUser: AssistantMessageDto = { id: crypto.randomUUID(), role: 'USER', content: value, createdAt: new Date().toISOString(), citations: [] };
    setMessages((old) => [...old, localUser]); setQuestion(''); setError(undefined); setStatus('retrieving');
    try { let id = threadId; if (!id) { const created = await assistantApi.create({ scope, resourceIds: scope === 'AUTHORIZED_LIBRARY' ? [] : resources.map((r) => r.id) }); id = created.data.id; setThreadId(id); }
      setStatus('generating'); const response = await assistantApi.ask(id, { question: value, clientRequestId: crypto.randomUUID(), mode: effectiveMode });
      setMessages((old) => [...old, response.data]); setStatus('idle');
    } catch (cause) { setStatus('error'); setError(cause instanceof Error ? cause.message : 'สร้างคำตอบไม่สำเร็จ'); }
  }
  if (!open) return null;
  return <aside className="fixed inset-0 z-[calc(var(--z-context)+2)] flex flex-col bg-[var(--s2-surface)] shadow-pop sm:left-auto sm:w-[440px] sm:border-l sm:border-line" aria-label="ผู้ช่วยเอกสาร">
    <header className="flex min-h-16 items-center gap-3 border-b border-line px-4"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-700"><Bot className="h-5 w-5" /></span>
      <div className="min-w-0 flex-1"><h2 className="text-[14px] font-semibold text-navy-900">ผู้ช่วยเอกสาร</h2><p className="text-[10.5px] text-navy-400">ตอบจากเอกสารที่คุณมีสิทธิ์เข้าถึงเท่านั้น · ทำงานในเครื่อง</p></div>
      <button className="rounded-lg p-2 text-navy-400 hover:bg-navy-50" onClick={() => setHistoryOpen((value) => !value)} aria-label="ประวัติการสนทนา"><History className="h-4 w-4" /></button>
      <button className="rounded-lg p-2 text-navy-400 hover:bg-navy-50" onClick={() => setOpen(false)} aria-label="ปิดผู้ช่วยเอกสาร"><X className="h-4 w-4" /></button></header>
    {historyOpen ? <section className="max-h-72 overflow-y-auto border-b border-line bg-[var(--s2-surface-soft)] p-3" aria-label="ประวัติการสนทนา">
      <p className="mb-2 text-[11px] font-semibold text-navy-600">การสนทนาของฉัน</p>
      {threads.length ? <div className="space-y-1">{threads.map((thread) => <div key={thread.id} className="flex items-center gap-1 rounded-lg border border-line bg-[var(--s2-surface)]">
        <button className="min-w-0 flex-1 p-2 text-left" onClick={() => void openThread(thread)}>
          <span className="block truncate text-[11.5px] font-medium text-navy-700">{thread.title}</span>
          <span className="text-[9.5px] text-navy-400">{thread.scope === 'CURRENT_RESOURCE' ? 'ไฟล์เดียว' : thread.scope === 'SELECTED_RESOURCES' ? 'ไฟล์ที่เลือก' : 'คลังเอกสาร'} · {new Date(thread.updatedAt).toLocaleString('th-TH')}</span>
        </button>
        <button className="m-1 rounded-md p-2 text-navy-300 hover:bg-red-50 hover:text-red-600" onClick={() => void removeThread(thread.id)} aria-label={`ลบการสนทนา ${thread.title}`}><Trash2 className="h-3.5 w-3.5" /></button>
      </div>)}</div> : <p className="text-[11px] text-navy-400">ยังไม่มีประวัติการสนทนา</p>}
    </section> : null}
    <div className="border-b border-line p-3"><label className="text-[11px] font-semibold text-navy-600">ขอบเขตคำถาม</label><select className="s2-input mt-1 w-full" value={scope} disabled={messages.length > 0} onChange={(e) => { const value=e.target.value as AssistantScope; setScope(value); if(value==='AUTHORIZED_LIBRARY') setResources([]); }}>
      {resources.length === 1 ? <option value="CURRENT_RESOURCE">ไฟล์นี้</option> : null}{resources.length > 0 ? <option value="SELECTED_RESOURCES">ไฟล์ที่เลือก ({resources.length})</option> : null}<option value="AUTHORIZED_LIBRARY">เอกสารทั้งหมดที่ฉันเข้าถึงได้</option></select>
      {resources.length > 0 && scope !== 'AUTHORIZED_LIBRARY' ? <div className="mt-2 flex max-h-16 flex-wrap gap-1 overflow-auto">{resources.map((r) => <span key={r.id} className="rounded-full bg-navy-50 px-2 py-1 text-[10px] text-navy-600"><FileText className="mr-1 inline h-3 w-3" />{r.name}</span>)}</div> : null}</div>
    <div className="flex-1 space-y-3 overflow-y-auto p-4">{diagnostics && (!diagnostics.enabled || diagnostics.status !== 'READY') ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11.5px] text-amber-800">ผู้ช่วยเอกสารยังไม่เปิดใช้งาน ผู้ดูแลระบบต้องติดตั้งโมเดลและเปิด feature flag ก่อน</div> : null}{messages.length === 0 ? <div className="space-y-4"><div className="rounded-xl border border-line bg-[var(--s2-surface-soft)] p-3 text-[12px] leading-relaxed text-navy-500"><Library className="mb-2 h-5 w-5 text-brand-600" />ถาม สรุป เปรียบเทียบ หรือดึงข้อเท็จจริง ระบบจะแสดงหลักฐานที่ตรวจสอบย้อนกลับได้</div>
      <div className="grid grid-cols-2 gap-2">{quickPrompts.map(([label,prompt,mode]) => <button key={label} className="s2-btn s2-btn-outline justify-start text-[11px]" onClick={() => void ask(prompt, mode)}>{label}</button>)}</div></div> : null}
      {messages.map((message) => <article key={message.id} className={message.role === 'USER' ? 'ml-8 rounded-xl bg-brand-600 px-3 py-2.5 text-[12.5px] text-white' : 'mr-3 rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-3 text-[12.5px] leading-relaxed text-navy-800'}>
        <p className="whitespace-pre-wrap">{message.content}</p>{message.role === 'ASSISTANT' ? <button className="mt-2 inline-flex items-center gap-1 text-[10px] text-navy-400 hover:text-navy-700" onClick={() => void navigator.clipboard.writeText(message.content)}><Copy className="h-3 w-3" />คัดลอกคำตอบ</button> : null}
        {message.citations.length ? <div className="mt-3 space-y-1.5 border-t border-line pt-2">{message.citations.map((c) => <button key={c.evidenceId} className="block w-full rounded-lg border border-line bg-[var(--s2-surface)] p-2 text-left hover:border-brand-300" onClick={() => { setOpen(false); navigate(`/files?focus=${encodeURIComponent(c.resourceId)}`); }}>
          <span className="block text-[10.5px] font-semibold text-brand-700">[{c.evidenceId}] {c.filename}{c.textSource === 'OCR' ? ' · OCR' : c.textSource === 'HUMAN_CORRECTED' ? ' · ตรวจแก้แล้ว' : ''}</span><span className="mt-1 line-clamp-2 block text-[10px] text-navy-400">{c.snippet}</span></button>)}</div> : null}</article>)}
      {status === 'retrieving' ? <p className="text-[11px] text-navy-400">กำลังค้นหาหลักฐาน…</p> : status === 'generating' ? <p className="text-[11px] text-navy-400">กำลังสร้างคำตอบ…</p> : null}{error ? <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-[11px] text-red-700">{error}</div> : null}</div>
    <form className="border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void ask(question); }}><textarea ref={inputRef} className="s2-input min-h-20 w-full resize-none" maxLength={4000} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="ถามเกี่ยวกับเอกสาร…" />
      <div className="mt-2 flex items-center justify-between"><span className="text-[10px] text-navy-400">{question.length}/4000</span><button className="s2-btn s2-btn-primary" disabled={!question.trim() || status === 'retrieving' || status === 'generating' || Boolean(diagnostics && (!diagnostics.enabled || diagnostics.status !== 'READY'))}><Send className="h-4 w-4" />ถาม</button></div></form></aside>;
}
