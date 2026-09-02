/** หัวข้อของหน้าในพื้นที่ไฟล์ */
export function PageTitle({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h1 className="text-[17px] font-semibold tracking-tight text-navy-900">{title}</h1>
      <p className="mt-0.5 text-[12.5px] text-navy-400">{description}</p>
    </div>
  );
}
