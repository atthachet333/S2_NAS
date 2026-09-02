# DEPLOYMENT

## ความต้องการของเครื่อง server

- Node.js 20 ขึ้นไป
- MariaDB
- ไดรฟ์สำหรับ storage ที่ service มีสิทธิ์อ่านและเขียน

## ขั้นตอน

### 1. เตรียม environment

`backend/.env` บนเครื่อง server

```
NODE_ENV=production
BACKEND_PORT=8889
CORS_ORIGIN=http://<host>:8888
DATABASE_URL="mysql://USER:PASSWORD@HOST:3306/s2_nas"
S2_NAS_STORAGE_ROOT=D:\S2_NAS_STORAGE
JWT_ACCESS_SECRET=<random 64 hex>
JWT_REFRESH_SECRET=<random 64 hex>
```

สร้าง secret แบบสุ่ม

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 2. ติดตั้งและ build

```bash
npm install
```

```bash
npm run build
```

### 3. Migration

```bash
npm --prefix backend run prisma:deploy
```

ห้ามใช้ `prisma db push` และห้ามใช้ `prisma migrate dev` บน production

### 4. เริ่มระบบ

```bash
npm start
```

Frontend build เป็นไฟล์ static ใน `frontend/dist` ให้ web server เสิร์ฟที่ port 8888
และ proxy `/api` ไปยัง backend port 8889

## ตรวจหลัง deploy

| รายการ | วิธีตรวจ |
| --- | --- |
| Backend ทำงาน | `GET http://<host>:8889/api/health` ตอบ `status: ok` |
| Database | ฟิลด์ `database` เป็น `connected` |
| Storage | ฟิลด์ `storage` เป็น `ready` |
| Frontend | เปิด `http://<host>:8888` ได้และไม่มี error ใน console |
| CMD | banner S2 NAS แสดงครบและไม่มี unhandled error |

## ข้อควรระวัง

- `backend/storage` ของ development ไม่ควรถูกใช้บน production ให้ชี้ `S2_NAS_STORAGE_ROOT` ไปยังไดรฟ์จริง
- ห้าม commit `.env`
- ห้ามเปิด storage เป็น static directory ของ web server
- Production ต้องเชื่อมต่อฐานข้อมูลสำเร็จ มิฉะนั้น backend จะไม่ start
