# UX / INFORMATION ARCHITECTURE

## Redesign V2 (Phase B)

Main file manager ใช้ glass-like top header, top navigation แบบ scrollable, workspace เป็นพื้นที่หลัก
และไม่มี permanent sidebar ส่วน Admin แยกเป็น management shell ที่มี side navigation ได้

Global shortcuts: `/` โฟกัส global search, `Ctrl/Cmd + K` เปิด command palette และ `Escape`
ปิด menu, palette และ dialog ที่ไม่บังคับ

เมื่อ Resource API ยังไม่พร้อม ทุกหน้าจะแสดง premium empty state และ quick-start guidance
โดยไม่สร้างข้อมูลไฟล์ ผู้ใช้ หรือ connected status จำลอง Mobile ใช้ header แบบย่อ,
top navigation เลื่อนแนวนอน, grid 1–2 คอลัมน์ และ details drawer เป็น full-screen sheet

## Product direction

S2 NAS คือ **พื้นที่จัดเก็บไฟล์ของบริษัท** (private company file storage)
ลักษณะการใช้งานใกล้เคียง Google Drive / OneDrive / Dropbox แต่ไฟล์ทั้งหมดอยู่บนเซิร์ฟเวอร์ขององค์กร

S2 NAS **ไม่ใช่** ERP และไม่ใช่ระบบ workflow บัญชี

เส้นทางที่ผู้ใช้ต้องทำได้เร็วที่สุด

```
Login → สร้างโฟลเดอร์ → อัปโหลดไฟล์ → เปิดดู → ดาวน์โหลด → แชร์
```

ห้ามบังคับกรอกบริษัท ปีบัญชี เดือนบัญชี ประเภทภาษี checklist หรือ approval ก่อนอัปโหลด
**โฟลเดอร์คือโมเดลการจัดระเบียบหลัก**

## IA เดิม (ถอดออกแล้ว)

```
Sidebar ถาวร
├── แดชบอร์ด (summary cards จำนวนมาก)
├── เอกสาร: เอกสารทั้งหมด / โฟลเดอร์ / อัปโหลด
├── งานบัญชี: บริษัท-ลูกค้า / เอกสารรายเดือน / Checklist
├── ตรวจสอบ: อนุมัติเอกสาร / คำขอเอกสาร / แชร์ไฟล์
└── ระบบ: ผู้ใช้งาน / สิทธิ์ / Activity Log / Backup / ตั้งค่า
```

ปัญหา: ผู้ใช้เจอ dashboard แบบ ERP ก่อนเจอไฟล์ และเมนูงานบัญชีปนกับเมนูระบบ

## IA ใหม่

```
Header (แบรนด์ · ค้นหา · + ใหม่ · สถานะเซิร์ฟเวอร์ · แจ้งเตือน · ผู้ใช้)
│
├── Top navigation
│   ├── ไฟล์ของฉัน      /files, /files/:folderId   ← หน้าแรก
│   ├── แชร์กับฉัน       /shared
│   ├── ล่าสุด          /recent
│   ├── รายการโปรด      /favorites
│   └── ถังขยะ          /trash
│
├── File workspace (breadcrumb · toolbar · grid/list · คลิกขวา · ลากวาง)
├── Details drawer (ปิดเป็นค่าเริ่มต้น เปิดจากปุ่ม Information)
│
└── Admin area (เข้าจากเมนูผู้ใช้เท่านั้น)  /admin
    ├── ผู้ใช้งาน /admin/users
    ├── สิทธิ์ /admin/permissions
    ├── Activity Log /admin/activity
    ├── Storage /admin/storage
    ├── Backup /admin/backup
    └── ตั้งค่า /admin/settings
```

หลักการ

1. พื้นที่ไฟล์ **ห้ามมี sidebar ถาวร** ใช้ top navigation แทน
2. งานผู้ดูแลระบบแยกออกจากพื้นที่ไฟล์อย่างชัดเจน (คนละ shell คนละ route)
3. Admin area ใช้ side navigation ภายในได้
4. ไม่มี dashboard card กองใหญ่มาแย่งพื้นที่ไฟล์ ข้อมูล utility อยู่ใน `/admin/storage`

## Component structure

| Component | ไฟล์ | หน้าที่ |
| --- | --- | --- |
| `AppShell` | `components/layout/AppShell.tsx` | โครงพื้นที่ไฟล์ + details drawer |
| `TopHeader` | `components/layout/TopHeader.tsx` | แบรนด์ ค้นหา ปุ่มใหม่ สถานะ ผู้ใช้ |
| `TopNav` | `components/layout/TopNav.tsx` | แท็บหลัก 5 แท็บ |
| `NewMenu` | `components/layout/NewMenu.tsx` | สร้างโฟลเดอร์ / อัปโหลดไฟล์ / อัปโหลดโฟลเดอร์ |
| `UserMenu` | `components/layout/UserMenu.tsx` | โปรไฟล์ รหัสผ่าน และทางเข้า Admin |
| `AdminShell` | `components/layout/AdminShell.tsx` | โครง Admin area พร้อม side nav |
| `DriveWorkspace` | `components/files/DriveWorkspace.tsx` | รวม grid/list, ลากวาง, คลิกขวา, สถานะ |
| `FileToolbar` | `components/files/FileToolbar.tsx` | ใหม่ อัปโหลด เรียง กรอง grid/list ข้อมูล |
| `Breadcrumb` | `components/files/Breadcrumb.tsx` | เส้นทางโฟลเดอร์คลิกได้ทุกระดับ |
| `FileGrid` / `FileList` | `components/files/` | มุมมองการ์ดและตาราง |
| `FileTypeIcon` | `components/files/FileTypeIcon.tsx` | ไอคอนตามชนิดไฟล์ |
| `ContextMenu` | `components/files/ContextMenu.tsx` | เมนูคลิกขวาของไฟล์ โฟลเดอร์ และพื้นที่ว่าง |
| `DetailsDrawer` | `components/files/DetailsDrawer.tsx` | รายละเอียด / กิจกรรม |

State ร่วมอยู่ที่ `hooks/useDriveUi.tsx` (มุมมอง, รายการที่เลือก, drawer, คำค้น)
มุมมอง grid/list จำไว้ใน `localStorage` ผ่าน `hooks/useViewMode.ts`

## Page responsibilities

| Route | หน้าที่ | สถานะข้อมูล |
| --- | --- | --- |
| `/login` | ฟอร์มเข้าสู่ระบบ ตรวจรูปแบบด้วย Zod | ยืนยันตัวตนจริงใน Phase 2 |
| `/files`, `/files/:folderId` | เรียกดูโฟลเดอร์ อัปโหลด สร้างโฟลเดอร์ | Phase 3 |
| `/shared` | ไฟล์ที่แชร์กับฉัน (เจ้าของ, แชร์โดย, สิทธิ์, วันที่) | Phase 5 |
| `/recent` | เปิด อัปโหลด แก้ไขล่าสุด | Phase 3 |
| `/favorites` | ไฟล์และโฟลเดอร์ที่ปักหมุด | Phase 3 |
| `/trash` | soft delete พร้อมคืนค่า/ลบถาวร | Phase 3 |
| `/admin/storage`, `/admin/settings` | ข้อมูลจริงจาก backend | ใช้งานได้แล้ว |
| `/admin/*` อื่น ๆ | ผู้ใช้ สิทธิ์ activity backup | Phase 2, 5, 6 |

## กติกาการแสดงข้อมูล

- API ที่ยังไม่มี ให้แสดง empty state เสมอ ห้ามใส่ข้อมูลตัวอย่างให้ดูเหมือนใช้งานได้แล้ว
- ปุ่มที่ยังไม่ทำงานจริงต้องบอกตรง ๆ ว่าเปิดใช้งาน Phase ใด
- Loading ใช้ skeleton ไม่ใช้ spinner เต็มหน้า
