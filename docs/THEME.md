# THEME

S2 NAS รองรับ `light`, `dark` และ `system` โดยเก็บ preference ที่ `s2-theme`
และใช้ `system` เป็นค่าเริ่มต้น

สคริปต์ใน `frontend/index.html` resolve theme ก่อน React mount แล้วกำหนด `data-theme`
และ `color-scheme` เพื่อป้องกัน theme flash จากนั้น `ThemeProvider` ติดตามการเปลี่ยนแปลง
ของ `prefers-color-scheme` เมื่อใช้ System

Design tokens อยู่รวมที่ `frontend/src/styles/index.css` ครอบคลุม background, surface,
border, typography colors, primary colors, radii, shadows และ motion ห้ามเพิ่มสี surface/text
แบบ hardcode ใน component ใหม่ ให้ใช้ semantic aliases เช่น `bg-canvas`, `bg-surface`,
`text-navy-900`, `text-navy-400` และ `border-line`

Theme control อยู่ใน header, login และ user menu บน mobile
