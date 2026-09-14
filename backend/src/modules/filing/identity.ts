/**
 * การรู้จำตัวตนบริษัทจากข้อความเอกสาร (F22)
 *
 * **หลักการ:** ชั้นนี้ต้องแน่นอนและอธิบายได้ทุกขั้น ไม่มีการเดา เพราะผลของมันถูกใช้
 * เป็นหลักฐานน้ำหนักสูงสุดในการเลือกปลายทาง ถ้าชั้นนี้มั่วเพียงเล็กน้อย ข้อเสนอทั้งหมด
 * จะดูน่าเชื่อถือทั้งที่ผิด ซึ่งอันตรายกว่าการไม่เสนออะไรเลย
 *
 * **สิ่งที่จงใจไม่ทำ:** ไม่มีการเทียบชื่อแบบคลุมเครือ (fuzzy) ในชั้นนี้ เพราะชื่อบริษัทไทย
 * ต่างกันเพียงคำเดียวก็เป็นคนละนิติบุคคลได้ เช่น "ABC" กับ "AB Trading"
 * การรวมสองบริษัทเข้าด้วยกันเพราะชื่อคล้ายกันคือความผิดพลาดที่ผู้ใช้ตรวจจับได้ยากที่สุด
 */

/** รูปแบบนิติบุคคลที่ตัดออกก่อนเทียบ - ไม่ใช่ส่วนที่ทำให้บริษัทต่างกัน */
const LEGAL_FORMS = [
  'บริษัทจำกัดมหาชน', 'บริษัทมหาชนจำกัด', 'บริษัทจำกัด', 'บริษัท', 'จำกัดมหาชน', 'จำกัด',
  'ห้างหุ้นส่วนจำกัด', 'ห้างหุ้นส่วนสามัญ', 'ห้างหุ้นส่วน', 'หจก', 'บจก', 'บมจ',
  'company limited', 'public company limited', 'co ltd', 'co limited', 'company', 'limited',
  'ltd', 'plc', 'corporation', 'corp', 'incorporated', 'inc', 'partnership',
];

/**
 * ทำให้ชื่อบริษัทเทียบกันได้โดยไม่ทำให้บริษัทคนละแห่งกลายเป็นแห่งเดียวกัน
 *
 * ตัดเฉพาะรูปแบบนิติบุคคลและเครื่องหมายวรรคตอน ส่วนตัวชื่อจริงคงไว้ทั้งหมด
 * "บริษัท ABC จำกัด" "ABC CO., LTD." "ABC Co Ltd" จึงยุบเป็น "abc" เหมือนกัน
 * แต่ "AB Trading" ยังคงเป็น "ab trading" ซึ่งไม่เท่ากับ "abc"
 */
export function normalizeCompanyName(raw: string): string {
  let text = raw.normalize('NFC').toLocaleLowerCase('th-TH');
  // เครื่องหมายวรรคตอนและตัวคั่นไม่ได้สื่อความต่างของนิติบุคคล
  text = text.replace(/[.,()[\]{}"'`\-_/\\|:;!?@#$%^&*+=~]/gu, ' ');
  text = text.replace(/\s+/gu, ' ').trim();
  // ตัดรูปแบบนิติบุคคลแบบคำเต็มเท่านั้น กัน "limited" ที่เป็นส่วนของชื่อจริงถูกกินไป
  for (const form of LEGAL_FORMS) {
    const spaced = form.replace(/\s+/gu, '\\s*');
    text = text.replace(new RegExp(`(^|\\s)${spaced}(\\s|$)`, 'giu'), ' ');
  }
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * เลขประจำตัวผู้เสียภาษี 13 หลัก
 *
 * ยอมรับทั้งแบบมีตัวคั่นและไม่มี เพราะเอกสารจริงเขียนได้หลายแบบ
 * แต่คืนค่าเป็นตัวเลขล้วนเสมอ เพื่อให้เทียบกันได้แบบตรงตัวจริง ๆ
 *
 * ไม่ตรวจ checksum โดยตั้งใจ เอกสารจริงมีเลขที่พิมพ์ผิดอยู่บ้าง และการทิ้งเลขที่
 * checksum ไม่ผ่านจะทำให้เสียหลักฐานที่ยังใช้จับคู่ได้ การจับคู่ใช้การตรงกันทั้ง 13 หลัก
 * ซึ่งเข้มพออยู่แล้ว
 */
export function extractTaxIds(text: string): string[] {
  const found = new Set<string>();
  // อนุญาตให้มีขีดหรือช่องว่างคั่นระหว่างหลัก แต่ต้องได้ 13 หลักพอดี
  for (const match of text.matchAll(/\d(?:[\s-]?\d){12}/gu)) {
    const digits = match[0].replace(/[\s-]/gu, '');
    if (digits.length === 13) found.add(digits);
  }
  return [...found];
}

/**
 * ดึงชื่อบริษัทที่ปรากฏในข้อความ
 *
 * จับจากคำระบุนิติบุคคลเป็นหลัก ("บริษัท ... จำกัด", "หจก. ...", "... CO., LTD.")
 * เพราะเป็นรูปแบบที่บอกได้แน่ว่าข้อความช่วงนั้นคือชื่อนิติบุคคล ไม่ใช่คำทั่วไป
 * การกวาดทุกคำที่ขึ้นต้นด้วยตัวใหญ่จะได้ขยะจำนวนมากจากหัวกระดาษและที่อยู่
 */
/**
 * ตัวกรองชื่อที่ "เป็นไปได้ว่าเป็นชื่อบริษัทจริง"
 *
 * วัดกับข้อมูลจริงแล้วพบว่าเอกสารบางประเภท โดยเฉพาะรายการเดินบัญชี มีข้อความยาว
 * ต่อกันโดยไม่มีการขึ้นบรรทัดใหม่ ทำให้การจับช่วง "บริษัท ... จำกัด" กวาดเอาที่อยู่
 * และรายการโอนเงินติดมาด้วย เช่น "มานีมานะ ฟู้ โอนเงิน 1" หรือที่อยู่ทั้งบรรทัด
 *
 * ชื่อขยะพวกนี้ไม่ตรงกับโปรไฟล์โฟลเดอร์ใดอยู่แล้ว แต่ทำให้เหตุผลที่แสดงต่อผู้ใช้
 * ดูมั่ว จึงกรองออกตั้งแต่ต้นทาง เกณฑ์ที่ใช้เป็นเชิงรูปแบบล้วน ไม่ได้ห้ามคำทางธุรกิจใด
 */
function isPlausibleCompanyName(name: string): boolean {
  // ชื่อนิติบุคคลจริงไม่ยาวขนาดที่อยู่เต็มบรรทัด
  if (name.length > 50) return false;
  // เลขเรียงยาวเป็นสัญญาณของเลขบัญชี จำนวนเงิน หรือที่อยู่ ไม่ใช่ชื่อบริษัท
  if (/\d{3,}/u.test(name)) return false;
  // ชื่อที่มีคำเยอะเกินไปมักเป็นข้อความที่ไหลต่อกันมา
  if (name.split(/\s+/u).length > 8) return false;
  // ช่องว่างติดกันหลายตัวคือรอยต่อของคอลัมน์ในข้อความที่สกัดจากตาราง ไม่ใช่ชื่อเดียวกัน
  if (/\s{2,}/u.test(name)) return false;
  /**
   * ตัวเลขที่ยืนเป็นคำของตัวเองคือรายการเดินบัญชี ไม่ใช่ส่วนของชื่อนิติบุคคล
   *
   * วัดกับข้อมูลจริงแล้วพบรูปแบบอย่าง "มานีมานะ ฟู้ โอนเงิน 1" และ "มานีมานะ ฟู้ หักชำระสินเชื่อ 42"
   * ซึ่งเกิดจากข้อความในรายการเดินบัญชีที่ไหลต่อกันโดยไม่มีการขึ้นบรรทัด
   * ชื่อบริษัทที่ลงท้ายด้วยตัวเลขโดด ๆ พบได้น้อยกว่าขยะรูปแบบนี้มาก
   */
  if (/(?:^|\s)\d{1,3}(?:\s|$)/u.test(name)) return false;
  // ต้องมีตัวอักษรจริงพอสมควร ไม่ใช่เศษอักขระจากการสกัดที่เพี้ยน
  const letters = (name.match(/\p{L}/gu) ?? []).length;
  return letters >= 2 && letters / name.length >= 0.5;
}

export function extractCompanyNames(text: string): string[] {
  const normalized = text.normalize('NFC');
  const found = new Map<string, string>();
  const add = (raw: string) => {
    const cleaned = raw.replace(/\s+/gu, ' ').trim();
    if (cleaned.length < 2) return;
    if (!isPlausibleCompanyName(cleaned)) return;
    const key = normalizeCompanyName(cleaned);
    // ชื่อที่เหลือแต่รูปแบบนิติบุคคลล้วน ๆ ไม่ใช่ชื่อบริษัท
    if (key.length < 2) return;
    if (!found.has(key)) found.set(key, cleaned);
  };

  // แบบไทย: บริษัท <ชื่อ> จำกัด / หจก. <ชื่อ> / ห้างหุ้นส่วนจำกัด <ชื่อ>
  for (const match of normalized.matchAll(/บริษัท\s*([^\n,;|]{1,50}?)\s*จำกัด(?:\s*\(มหาชน\))?/gu)) add(match[1]!);
  for (const match of normalized.matchAll(/(?:ห้างหุ้นส่วนจำกัด|หจก\.?|บจก\.?)\s*([^\n,;|]{1,50}?)(?=\s{2,}|[,;|\n]|$)/gu)) add(match[1]!);
  // แบบอังกฤษ: <ชื่อ> CO., LTD. / COMPANY LIMITED / LTD
  for (const match of normalized.matchAll(/([A-Za-z0-9&.\s]{2,60}?)\s*(?:CO\.?,?\s*LTD\.?|COMPANY\s+LIMITED|LIMITED|LTD\.?)(?=\s|$|[,\n])/giu)) add(match[1]!);
  return [...found.values()];
}

export interface DocumentIdentity {
  taxIds: string[];
  companyNames: string[];
  /** ชื่อบริษัทในรูปแบบที่เทียบได้ เรียงตรงกับ companyNames */
  normalizedCompanyNames: string[];
}

/**
 * รวบรวมตัวระบุทั้งหมดจากหลักฐานของเอกสารหนึ่งฉบับ
 *
 * ชื่อไฟล์ถูกนับเป็นหลักฐานเท่าเทียมกับเนื้อหา เพราะข้อมูลจริงในระบบนี้
 * มีชื่อนิติบุคคลอยู่ในชื่อไฟล์บ่อยมาก เช่น "ภงด53_บริษัท_มานีมานะ ฟู้ดส์ จำกัด_ก.ค.25.pdf"
 */
export function documentIdentity(input: { fileName: string; text?: string | null }): DocumentIdentity {
  const combined = `${input.fileName}\n${input.text ?? ''}`;
  const companyNames = extractCompanyNames(combined);
  return {
    taxIds: extractTaxIds(combined),
    companyNames,
    normalizedCompanyNames: companyNames.map(normalizeCompanyName),
  };
}

/**
 * หมวดเอกสารจากคำที่ปรากฏจริง
 *
 * ระบบนี้ยังไม่มีตัวจำแนกเอกสารอยู่เดิม (F15 เก็บเฉพาะข้อความกับสถานะ OCR)
 * จึงใช้การจับคำที่แน่นอนแทน ไม่ใช่การเดาด้วยโมเดล เพราะหมวดถูกใช้เป็นสัญญาณ
 * น้ำหนักกลางเท่านั้น และต้องอธิบายให้ผู้ใช้เข้าใจได้ว่าทำไมถึงจัดหมวดนี้
 */
export const DOCUMENT_CATEGORIES: Array<{ code: string; label: string; patterns: RegExp }> = [
  { code: 'TAX_INVOICE', label: 'ใบกำกับภาษี', patterns: /ใบกำกับภาษี|tax\s*invoice/iu },
  { code: 'RECEIPT', label: 'ใบเสร็จรับเงิน', patterns: /ใบเสร็จรับเงิน|ใบเสร็จ|receipt/iu },
  { code: 'INVOICE', label: 'ใบแจ้งหนี้', patterns: /ใบแจ้งหนี้|invoice/iu },
  { code: 'QUOTATION', label: 'ใบเสนอราคา', patterns: /ใบเสนอราคา|quotation|quote/iu },
  { code: 'PURCHASE_ORDER', label: 'ใบสั่งซื้อ', patterns: /ใบสั่งซื้อ|purchase\s*order|\bPO\b/iu },
  { code: 'CONTRACT', label: 'สัญญา', patterns: /สัญญา|contract|agreement/iu },
  { code: 'PAYROLL', label: 'เงินเดือน', patterns: /เงินเดือน|payroll|สลิปเงินเดือน/iu },
  { code: 'SOCIAL_SECURITY', label: 'ประกันสังคม', patterns: /ประกันสังคม|สปส|ปกส/iu },
  { code: 'WITHHOLDING_TAX', label: 'ภาษีหัก ณ ที่จ่าย', patterns: /ภ\.?ง\.?ด\.?\s*\d+|ภงด\s*\d+/iu },
  { code: 'VAT_RETURN', label: 'ภาษีมูลค่าเพิ่ม', patterns: /ภ\.?พ\.?\s*30|ภพ\s*30/iu },
  { code: 'FINANCIAL_STATEMENT', label: 'งบการเงิน', patterns: /งบการเงิน|ปิดงบ|financial\s*statement/iu },
  { code: 'BANK_STATEMENT', label: 'รายการเดินบัญชี', patterns: /statement|กระแสรายวัน|เดินบัญชี/iu },
  { code: 'REGISTRATION', label: 'ทะเบียนนิติบุคคล', patterns: /บอจ\.?\s*\d+|หนังสือรับรอง|ทะเบียนพาณิชย์/iu },
];

export interface DetectedCategory { code: string; label: string }

/** หมวดทั้งหมดที่ตรงกับข้อความ เรียงตามลำดับความเฉพาะเจาะจงที่นิยามไว้ด้านบน */
export function detectCategories(text: string): DetectedCategory[] {
  return DOCUMENT_CATEGORIES
    .filter((category) => category.patterns.test(text))
    .map((category) => ({ code: category.code, label: category.label }));
}

/**
 * ช่วงเวลาของเอกสาร (ปีพุทธศักราช)
 *
 * **ทำไมจำเป็น:** โครงสร้างโฟลเดอร์จริงของระบบนี้แยกตามปี ("ปี 2566", "ปี 2567")
 * ใต้ลูกค้าแต่ละราย การรู้ลูกค้ากับประเภทเอกสารจึงยังไม่พอที่จะเลือกโฟลเดอร์ได้
 * วัดแล้วพบว่าถ้าไม่มีสัญญาณปี ตัวเลือกอันดับหนึ่งถูกเพียง 16% เพราะเดาปีมั่ว
 *
 * ข้อมูลจริงเขียนปีไว้หลายแบบ: "เดือน 03-66", "ปี 2567", "เดือน 02.69", "09-2569"
 * ทั้งหมดเป็นพุทธศักราช จึงแปลงให้อยู่ในรูปเดียวกันเพื่อเทียบกับชื่อโฟลเดอร์
 */
export function extractBuddhistYears(text: string): number[] {
  const years = new Set<number>();
  const add = (year: number) => { if (year >= 2540 && year <= 2600) years.add(year); };

  // ปีเต็มสี่หลักแบบพุทธศักราช เช่น "ปี 2567" หรือ "2569"
  for (const match of text.matchAll(/\b(25\d{2})\b/gu)) add(Number(match[1]));
  // ปีคริสต์ศักราชสี่หลักที่พบในเอกสารสองภาษา แปลงเป็นพุทธศักราชเพื่อเทียบกับโฟลเดอร์
  for (const match of text.matchAll(/\b(20[2-9]\d)\b/gu)) add(Number(match[1]) + 543);
  /**
   * ปีสองหลักที่ตามหลังเดือน เช่น "เดือน 03-66" "เดือน 02.69" "ก.ค.25"
   *
   * จำกัดให้ต้องมีคำว่าเดือนหรือชื่อเดือนนำหน้าเสมอ ตัวเลขสองหลักลอย ๆ
   * ในเอกสารการเงินมีเยอะมากและส่วนใหญ่ไม่ใช่ปี
   */
  /**
   * ปีสองหลักตีความได้สองแบบ และข้อมูลจริงใช้ทั้งสองแบบปนกัน
   *
   * "เดือน 03-66" หมายถึง พ.ศ. 2566 ส่วน "ก.ค.25" หมายถึง ค.ศ. 2025 (พ.ศ. 2568)
   * แยกได้จากความสมเหตุสมผล: 2500+66 = 2566 อยู่ในช่วงที่เป็นไปได้
   * แต่ 2500+25 = 2525 เก่าเกินกว่าที่เอกสารในระบบจะเป็นได้ จึงตีความเป็น ค.ศ. แทน
   */
  const addTwoDigitYear = (value: number) => {
    const asBuddhist = 2500 + value;
    if (asBuddhist >= 2540 && asBuddhist <= 2600) { add(asBuddhist); return; }
    add(2000 + value + 543);
  };
  for (const match of text.matchAll(/(?:เดือน|ปี)\s*\d{1,2}\s*[-./]\s*(\d{2})\b/gu)) addTwoDigitYear(Number(match[1]));
  for (const match of text.matchAll(/(?:ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)\s*(\d{2})\b/gu)) addTwoDigitYear(Number(match[1]));
  return [...years].sort((a, b) => a - b);
}

/**
 * รหัสแบบฟอร์มราชการที่ใช้เป็นชื่อโฟลเดอร์จริง
 *
 * **ทำไมต้องแยกจากหมวดเอกสาร:** หมวดมีป้ายกำกับอ่านง่ายอย่าง "ภาษีหัก ณ ที่จ่าย"
 * แต่โฟลเดอร์จริงตั้งชื่อด้วยรหัสแบบฟอร์ม เช่น "ภงด.3" "ภ.พ.30" "บอจ.5" "สปส.1-10"
 * การเทียบด้วยป้ายกำกับจึงไม่เคยตรงกับชื่อโฟลเดอร์เลย
 *
 * และรหัสต้องตรงถึงระดับตัวเลข "ภงด.3" กับ "ภงด.1" เป็นคนละแบบฟอร์มและคนละโฟลเดอร์
 * การเทียบแค่ว่าเป็นภาษีหัก ณ ที่จ่ายเหมือนกันจะทำให้เลือกโฟลเดอร์ผิด
 */
export function extractFormCodes(text: string): string[] {
  const codes = new Set<string>();
  const normalized = text.normalize('NFC');
  // ภงด.3 / ภ.ง.ด.53 / ภงด 50
  for (const match of normalized.matchAll(/ภ\s*\.?\s*ง\s*\.?\s*ด\s*\.?\s*(\d{1,2})/gu)) codes.add(`ภงด${match[1]}`);
  // ภ.พ.30 / ภพ30
  for (const match of normalized.matchAll(/ภ\s*\.?\s*พ\s*\.?\s*(\d{1,2})/gu)) codes.add(`ภพ${match[1]}`);
  // บอจ.5
  for (const match of normalized.matchAll(/บอจ\s*\.?\s*(\d{1,2})/gu)) codes.add(`บอจ${match[1]}`);
  // สปส.1-10
  for (const match of normalized.matchAll(/สปส\s*\.?\s*(\d{1,2})\s*-\s*(\d{1,2})/gu)) codes.add(`สปส${match[1]}-${match[2]}`);
  return [...codes];
}

/** ทำชื่อโฟลเดอร์ให้เทียบกับรหัสแบบฟอร์มได้ - ตัดจุดและช่องว่างที่เขียนไม่เหมือนกัน */
export function normalizeFormCodeText(text: string): string {
  return text.normalize('NFC').replace(/[.\s]/gu, '');
}
