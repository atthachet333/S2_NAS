import { BRAND } from '../config/branding.js';

const LINE = '='.repeat(60);
const LABEL_WIDTH = 21;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);

export const color = {
  dim: (t: string) => c('2', t),
  bold: (t: string) => c('1', t),
  navy: (t: string) => c('38;5;25', t),
  blue: (t: string) => c('36', t),
  green: (t: string) => c('32', t),
  red: (t: string) => c('31', t),
  amber: (t: string) => c('33', t),
};

/** พิมพ์หัวข้อ S2 NAS ให้เห็นชัดใน CMD / Terminal */
export function printBannerHeader(): void {
  process.stdout.write(
    '\n' +
      color.blue(LINE) +
      '\n ' +
      color.bold(BRAND.name) +
      '\n ' +
      BRAND.subtitle +
      '\n' +
      color.blue(LINE) +
      '\n\n',
  );
}

export function printBannerFooter(message: string, ok = true): void {
  const tag = ok ? color.green(`[${BRAND.name}]`) : color.red(`[${BRAND.name}]`);
  process.stdout.write(`\n${tag} ${message}\n` + color.blue(LINE) + '\n\n');
}

/** บรรทัดรูปแบบ [TAG] key : value โดยจัดคอลัมน์ให้ตรงกันทุกบรรทัด */
export function printLine(
  tag: string,
  key: string,
  value: string,
  tone: 'ok' | 'warn' | 'error' | 'plain' = 'plain',
): void {
  const plainLabel = `[${tag}] ${key}`.padEnd(LABEL_WIDTH, ' ');
  const paintedLabel = color.blue(`[${tag}]`) + plainLabel.slice(tag.length + 2);
  const paintedValue =
    tone === 'ok'
      ? color.green(value)
      : tone === 'warn'
        ? color.amber(value)
        : tone === 'error'
          ? color.red(value)
          : value;
  process.stdout.write(`${paintedLabel}: ${paintedValue}\n`);
}

export function printBlank(): void {
  process.stdout.write('\n');
}
