/**
 * ตัวตรวจความตรงของค่าที่ห้ามเพี้ยน (F21-Q2)
 *
 * **ปัญหาที่แก้:** โมเดลเรียบเรียงประโยคได้อิสระ แต่บางครั้งดัดแปลงค่าที่ต้องตรงตัว
 * ที่วัดได้ชัดที่สุดคือเมื่อถามเป็นภาษาอังกฤษกับเอกสารไทยที่ใช้พุทธศักราช โมเดลจะพยายาม
 * แปลงปีเป็นคริสต์ศักราชเองแล้วแปลงผิด (2569 กลายเป็น 2069 คือลบ 500 แทนที่จะเป็น 543)
 *
 * คำสั่งใน prompt ห้ามแปลงปฏิทินอยู่แล้วแต่ไม่พอ เพราะเป็นการขอความร่วมมือ ไม่ใช่การบังคับ
 * ชั้นนี้จึงตรวจหลังสร้างคำตอบด้วยกฎที่กำหนดแน่นอน ไม่ได้ถามโมเดลซ้ำให้เดาใหม่
 *
 * **ขอบเขตที่จงใจทำให้แคบ:** ตรวจเฉพาะค่าที่มีโครงสร้างชัดเจนและเทียบกับหลักฐานได้ตรง ๆ
 * ไม่แตะชื่อคน การตีความข้อสัญญา หรือเนื้อความสรุป เพราะการแก้ข้อความที่ตัดสินถูกผิด
 * ด้วยกฎตายตัวไม่ได้ จะสร้างความเสียหายมากกว่าที่ป้องกัน
 */

export type ValueKind = 'DATE' | 'YEAR' | 'MONEY' | 'PERCENT' | 'IDENTIFIER' | 'DURATION';

export interface ValueToken {
  kind: ValueKind;
  /** ข้อความตามที่ปรากฏจริง ใช้สำหรับการแทนที่ */
  raw: string;
  start: number;
  end: number;
  /** ค่าที่ทำให้เทียบกันได้ ตัวเลขเป็นจำนวน วันที่เป็นสามส่วน */
  date?: { day: number; month: number; year: number; yearText: string };
  numeric?: number;
  unit?: string;
  text?: string;
}

const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const THAI_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

function monthIndex(name: string): number | null {
  const lower = name.toLocaleLowerCase();
  const en = EN_MONTHS.findIndex((month) => month === lower || month.slice(0, 3) === lower.replace('.', ''));
  if (en >= 0) return en + 1;
  const th = THAI_MONTHS.indexOf(name);
  if (th >= 0) return th + 1;
  const thShort = THAI_MONTHS_SHORT.indexOf(name);
  return thShort >= 0 ? thShort + 1 : null;
}

const MONTH_PATTERN = [...THAI_MONTHS, ...THAI_MONTHS_SHORT.map((m) => m.replace(/\./gu, '\\.')),
  ...EN_MONTHS, ...EN_MONTHS.map((m) => m.slice(0, 3))].join('|');

/**
 * ดึงค่าที่ต้องตรงตัวออกจากข้อความ
 *
 * เรียงลำดับให้รูปแบบยาวถูกจับก่อน เพื่อไม่ให้เลขที่เอกสารอย่าง INV-2569-00817
 * ถูกแยกเป็นตัวเลขหลายก้อนแล้วตรวจผิดประเภท
 */
export function extractValueTokens(text: string): ValueToken[] {
  const tokens: ValueToken[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (start: number, end: number) => taken.some(([from, to]) => start < to && end > from);
  const push = (token: ValueToken) => {
    if (overlaps(token.start, token.end)) return;
    taken.push([token.start, token.end]);
    tokens.push(token);
  };

  // เลขอ้างอิงที่มีทั้งตัวอักษรและตัวเลข เช่น INV-2569-00817 หรือ ก-2568/117
  for (const match of text.matchAll(/[\p{L}]+[-/][\p{N}][\p{N}\-/]*[\p{N}]/gu)) {
    push({ kind: 'IDENTIFIER', raw: match[0], start: match.index, end: match.index + match[0].length,
      text: match[0].toLocaleUpperCase() });
  }
  // เลขประจำตัวที่เป็นตัวเลขคั่นขีด เช่น 0-9999-88888-77-6
  for (const match of text.matchAll(/\d(?:[-\s]?\d){6,}/gu)) {
    const raw = match[0];
    if (!/[-\s]/u.test(raw)) continue;
    push({ kind: 'IDENTIFIER', raw, start: match.index, end: match.index + raw.length,
      text: raw.replace(/[\s]/gu, '') });
  }

  // วันที่แบบ ISO
  for (const match of text.matchAll(/(\d{4})-(\d{2})-(\d{2})/gu)) {
    push({ kind: 'DATE', raw: match[0], start: match.index, end: match.index + match[0].length,
      date: { day: Number(match[3]), month: Number(match[2]), year: Number(match[1]), yearText: match[1]! } });
  }
  // วันที่แบบ "30 กันยายน 2569" หรือ "30 September 2026"
  for (const match of text.matchAll(new RegExp(`(\\d{1,2})\\s+(${MONTH_PATTERN})\\.?,?\\s+(\\d{4})`, 'giu'))) {
    const month = monthIndex(match[2]!);
    if (month === null) continue;
    push({ kind: 'DATE', raw: match[0], start: match.index, end: match.index + match[0].length,
      date: { day: Number(match[1]), month, year: Number(match[3]), yearText: match[3]! } });
  }
  // วันที่แบบ "September 30, 2026"
  for (const match of text.matchAll(new RegExp(`(${MONTH_PATTERN})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'giu'))) {
    const month = monthIndex(match[1]!);
    if (month === null) continue;
    push({ kind: 'DATE', raw: match[0], start: match.index, end: match.index + match[0].length,
      date: { day: Number(match[2]), month, year: Number(match[3]), yearText: match[3]! } });
  }

  // อัตราร้อยละ
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*%|ร้อยละ\s*(\d+(?:\.\d+)?)/gu)) {
    push({ kind: 'PERCENT', raw: match[0], start: match.index, end: match.index + match[0].length,
      numeric: Number(match[1] ?? match[2]) });
  }
  // จำนวนเงินที่มีหน่วยกำกับ
  for (const match of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(บาท|THB|baht)/giu)) {
    push({ kind: 'MONEY', raw: match[0], start: match.index, end: match.index + match[0].length,
      numeric: Number(match[1]!.replace(/,/gu, '')), unit: 'THB' });
  }
  // ระยะเวลา เช่น 30 วัน หรือ 45 days
  for (const match of text.matchAll(/(\d+)\s*(วัน|days?|เดือน|months?|ปี|years?)/giu)) {
    const unit = /วัน|day/iu.test(match[2]!) ? 'DAY' : /เดือน|month/iu.test(match[2]!) ? 'MONTH' : 'YEAR';
    push({ kind: 'DURATION', raw: match[0], start: match.index, end: match.index + match[0].length,
      numeric: Number(match[1]), unit });
  }
  // จำนวนเงินที่ไม่มีหน่วยกำกับแต่ใส่ลูกน้ำแบบเงิน เช่น 12,450,000.00
  for (const match of text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?/gu)) {
    push({ kind: 'MONEY', raw: match[0], start: match.index, end: match.index + match[0].length,
      numeric: Number(match[0].replace(/,/gu, '')), unit: 'THB' });
  }
  /**
   * ปีที่ยืนอยู่ลำพังโดยไม่มีวันและเดือน
   *
   * กรณีที่วัดได้เป็นวันที่เต็มรูปแบบ แต่คำตอบอย่าง "สัญญาลงนามในปี 2069" ก็ผิดแบบเดียวกัน
   * และจะหลุดถ้าตรวจเฉพาะวันที่เต็ม จำกัดช่วงไว้เฉพาะที่เป็นปีได้จริงทั้งสองปฏิทิน
   * และรูปแบบยาวกว่าถูกจับไปก่อนแล้ว เลขที่เอกสารกับจำนวนเงินจึงไม่ถูกนับซ้ำ
   */
  for (const match of text.matchAll(/\d{4}/gu)) {
    const year = Number(match[0]);
    const isPlausibleYear = (year >= 1900 && year <= 2200) || (year >= 2400 && year <= 2700);
    if (!isPlausibleYear) continue;
    push({ kind: 'YEAR', raw: match[0], start: match.index, end: match.index + match[0].length, numeric: year });
  }
  return tokens.sort((a, b) => a.start - b.start);
}

/** ค่าสองตัวถือว่าเท่ากันเมื่อค่าจริงเท่ากัน รูปแบบการเขียนต่างกันได้ (12,450,000.00 = 12,450,000) */
function equivalent(answer: ValueToken, evidence: ValueToken): boolean {
  // ปีที่ยืนลำพังในคำตอบ ตรงกับปีที่อยู่ภายในวันที่เต็มของหลักฐานได้
  // ไม่งั้นคำตอบที่ถูกต้องอย่าง "สัญญาสิ้นสุดในปี 2569" จะถูกปฏิเสธ
  // เพราะหลักฐานเขียนไว้เป็น "30 กันยายน 2569" ซึ่งไม่มีปีแบบยืนลำพัง
  if (answer.kind === 'YEAR' && evidence.kind === 'DATE') return answer.numeric === evidence.date!.year;
  if (answer.kind !== evidence.kind) return false;
  switch (answer.kind) {
    case 'DATE':
      return answer.date!.day === evidence.date!.day && answer.date!.month === evidence.date!.month
        && answer.date!.year === evidence.date!.year;
    case 'YEAR':
      return evidence.kind === 'YEAR' ? answer.numeric === evidence.numeric : false;
    case 'MONEY':
    case 'PERCENT':
      return answer.numeric === evidence.numeric;
    case 'DURATION':
      return answer.numeric === evidence.numeric && answer.unit === evidence.unit;
    case 'IDENTIFIER':
      return answer.text === evidence.text;
  }
}

export interface FidelityViolation {
  kind: ValueKind;
  raw: string;
  /** ค่าจากหลักฐานที่ใช้ซ่อมได้ ถ้าไม่มีหรือมีหลายค่าจะไม่มีค่านี้ */
  repairedTo?: string;
}

export interface FidelityResult {
  /** คำตอบหลังการซ่อมค่าที่แก้ได้อย่างไม่กำกวม */
  answer: string;
  /** ค่าที่ไม่ตรงและซ่อมไม่ได้ - คำตอบนี้ห้ามบันทึก */
  unresolved: FidelityViolation[];
  repaired: FidelityViolation[];
}

/**
 * ตรวจว่าทุกค่าที่ต้องตรงตัวในคำตอบมีหลักฐานรองรับ และซ่อมเฉพาะที่ซ่อมได้อย่างมั่นใจ
 *
 * การซ่อมทำเฉพาะกรณีที่จับคู่ได้แบบไม่กำกวมเท่านั้น
 * - วันที่ - วันและเดือนตรงกับหลักฐานชิ้นเดียว ต่างแค่ปี จึงคืนปีตามหลักฐาน
 *   ครอบคลุมกรณีแปลงปฏิทินผิดโดยตรง โดยไม่ต้องรู้ว่าปฏิทินไหนเป็นไหน
 * - ค่าอื่น - ซ่อมได้เมื่อหลักฐานมีค่าประเภทนั้นอยู่ค่าเดียว ไม่มีทางเลือกให้เดาผิด
 *
 * ถ้ากำกวมจะไม่เดา แต่รายงานกลับไปให้ผู้เรียกปฏิเสธคำตอบ
 */
export function enforceValueFidelity(answer: string, evidenceTexts: string[]): FidelityResult {
  const evidenceTokens = evidenceTexts.flatMap((text) => extractValueTokens(text));
  const answerTokens = extractValueTokens(answer);
  const unresolved: FidelityViolation[] = [];
  const repaired: FidelityViolation[] = [];
  // แทนที่จากท้ายไปหน้าเพื่อไม่ให้ตำแหน่งที่คำนวณไว้เลื่อน
  const edits: Array<{ start: number; end: number; text: string }> = [];

  for (const token of answerTokens) {
    if (evidenceTokens.some((candidate) => equivalent(token, candidate))) continue;

    if (token.kind === 'DATE') {
      const sameDayMonth = evidenceTokens.filter((candidate) => candidate.kind === 'DATE'
        && candidate.date!.day === token.date!.day && candidate.date!.month === token.date!.month);
      const years = new Set(sameDayMonth.map((candidate) => candidate.date!.yearText));
      if (years.size === 1) {
        // วันและเดือนตรงกัน ต่างแค่ปี คืนปีตามหลักฐานโดยไม่แตะส่วนอื่นของประโยค
        const correctYear = [...years][0]!;
        const yearAt = token.raw.lastIndexOf(token.date!.yearText);
        if (yearAt >= 0) {
          edits.push({ start: token.start + yearAt, end: token.start + yearAt + token.date!.yearText.length, text: correctYear });
          repaired.push({ kind: token.kind, raw: token.raw, repairedTo: token.raw.slice(0, yearAt) + correctYear });
          continue;
        }
      }
      unresolved.push({ kind: token.kind, raw: token.raw });
      continue;
    }

    const sameKind = token.kind === 'YEAR'
      ? evidenceTokens.filter((candidate) => candidate.kind === 'YEAR' || candidate.kind === 'DATE')
        .map((candidate) => ({ ...candidate, raw: candidate.kind === 'DATE' ? candidate.date!.yearText : candidate.raw }))
      : evidenceTokens.filter((candidate) => candidate.kind === token.kind);
    const distinct = new Set(sameKind.map((candidate) => candidate.raw));
    if (distinct.size === 1) {
      // หลักฐานมีค่าประเภทนี้อยู่ค่าเดียว การจับคู่จึงไม่กำกวม
      const correct = sameKind[0]!.raw;
      edits.push({ start: token.start, end: token.end, text: correct });
      repaired.push({ kind: token.kind, raw: token.raw, repairedTo: correct });
      continue;
    }
    unresolved.push({ kind: token.kind, raw: token.raw });
  }

  let result = answer;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return { answer: result, unresolved, repaired };
}
