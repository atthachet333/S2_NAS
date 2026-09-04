import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env.js';
import { AppError } from '../../core/errors.js';

/**
 * ตัวเรียกเครื่องมือ MariaDB
 *
 * หลักความปลอดภัยสามข้อที่ห้ามผ่อนปรน:
 *   1. ไม่ใช้ shell เลย ส่ง argument เป็น array เสมอ จึงไม่มีช่องให้ inject คำสั่ง
 *   2. รหัสผ่านเดินทางผ่าน environment (MYSQL_PWD) ไม่ใช่ argv - argv มองเห็นได้จาก process อื่น
 *   3. ข้อความ error ที่ส่งต่อให้ผู้ใช้ถูกกรองแล้ว ไม่มี command line, path จริง หรือรหัสผ่าน
 */

export interface DatabaseTarget {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

/** อ่านปลายทางฐานข้อมูลจาก DATABASE_URL โดยไม่ทำให้ค่าหลุดออกไปที่ log */
export function parseDatabaseUrl(url: string | undefined = env.DATABASE_URL): DatabaseTarget {
  if (!url) throw new AppError('BACKUP_DB_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล', 500);
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, '');
  if (!database) throw new AppError('BACKUP_DB_NOT_CONFIGURED', 'DATABASE_URL ไม่มีชื่อฐานข้อมูล', 500);
  return {
    host: parsed.hostname,
    port: parsed.port || '3306',
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

function binary(name: 'mariadb-dump' | 'mariadb'): string {
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  return env.S2_NAS_MARIADB_BIN ? path.join(env.S2_NAS_MARIADB_BIN, executable) : executable;
}

/**
 * เครื่องมือพร้อมใช้งานหรือไม่
 *
 * ตรวจก่อนเริ่มงานจริงเสมอ การสำรองที่ล้มกลางทางเพราะไม่มีเครื่องมือ
 * แย่กว่าการปฏิเสธตั้งแต่ต้นพร้อมบอกเหตุผล
 */
export async function checkTooling(): Promise<{ available: boolean; version?: string; reason?: string }> {
  if (env.S2_NAS_MARIADB_BIN && !fs.existsSync(env.S2_NAS_MARIADB_BIN)) {
    return { available: false, reason: 'ไม่พบโฟลเดอร์เครื่องมือ MariaDB ที่ตั้งค่าไว้' };
  }
  try {
    const result = await execute(binary('mariadb-dump'), ['--version'], {});
    if (result.code !== 0) return { available: false, reason: 'เรียกเครื่องมือสำรองฐานข้อมูลไม่สำเร็จ' };
    return { available: true, version: result.stdout.trim() };
  } catch {
    return { available: false, reason: 'ไม่พบเครื่องมือสำรองฐานข้อมูล (mariadb-dump)' };
  }
}

interface ExecuteResult {
  code: number;
  stdout: string;
  stderr: string;
}

function execute(
  file: string,
  args: string[],
  extraEnv: Record<string, string>,
  options: { stdinFile?: string; stdoutFile?: string } = {},
): Promise<ExecuteResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      // shell: false เป็นค่าเริ่มต้นและต้องคงไว้เช่นนั้น
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    if (options.stdoutFile) {
      const sink = fs.createWriteStream(options.stdoutFile);
      child.stdout.pipe(sink);
      sink.on('error', fail);
    } else {
      child.stdout.on('data', (chunk: Buffer) => {
        // จำกัดขนาดที่เก็บไว้ในหน่วยความจำ เอาต์พุตจริงของ dump ถูกเขียนลงไฟล์เสมอ
        if (stdout.length < 64_000) stdout += chunk.toString();
      });
    }

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64_000) stderr += chunk.toString();
    });

    if (options.stdinFile) {
      const source = fs.createReadStream(options.stdinFile);
      source.on('error', fail);
      source.pipe(child.stdin);
    }

    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function connectionArgs(target: DatabaseTarget): string[] {
  return ['-h', target.host, '-P', target.port, '-u', target.user, '--protocol=TCP'];
}

/**
 * ข้อความ error ที่ปลอดภัยพอจะเก็บและแสดง
 *
 * stderr ของเครื่องมือฐานข้อมูลอาจมีชื่อโฮสต์ ชื่อผู้ใช้ หรือ path จริงติดมา
 * จึงคืนเฉพาะรหัส error ของ MariaDB กับข้อความกลาง ไม่ส่ง stderr ดิบออกไปไหน
 */
export function safeDatabaseError(stderr: string): string {
  /**
   * เครื่องมือแต่ละตัวรายงานรหัสคนละรูปแบบ:
   *   mariadb      → "ERROR 1045 (28000): ..."
   *   mariadb-dump → "Got error: 1045: ..."
   * จึงต้องรับทั้งสองแบบ มิฉะนั้นข้อความจะตกไปที่คำกลาง ๆ ที่ไม่ช่วยผู้ดูแลเลย
   */
  const code = /\berror\b\D{0,3}(\d{4})/i.exec(stderr)?.[1];
  if (code === '1045') return 'ฐานข้อมูลปฏิเสธการเข้าถึง (ตรวจสอบสิทธิ์ของบัญชี)';
  if (code === '1044') return 'บัญชีฐานข้อมูลไม่มีสิทธิ์กับฐานข้อมูลปลายทาง';
  if (code === '2002' || code === '2003') return 'เชื่อมต่อเซิร์ฟเวอร์ฐานข้อมูลไม่ได้';
  if (code === '1049') return 'ไม่พบฐานข้อมูลที่ระบุ';
  return code ? `ฐานข้อมูลแจ้งข้อผิดพลาด (รหัส ${code})` : 'ทำงานกับฐานข้อมูลไม่สำเร็จ';
}

/**
 * ดัมป์ฐานข้อมูลด้วยเครื่องมือของ MariaDB เอง
 *
 * ความสอดคล้องของข้อมูล: ใช้ --single-transaction ซึ่งอ่านทุกตารางจาก snapshot
 * ของธุรกรรมเดียวใน InnoDB จึงได้ภาพนิ่ง ณ เวลาเริ่มดัมป์โดยไม่ต้องล็อกทั้งเซิร์ฟเวอร์
 * ผู้ใช้ยังอัปโหลดและแก้ไขได้ตามปกติระหว่างการสำรอง
 *
 * ตารางที่ไม่ใช่ InnoDB จะไม่ได้รับการรับประกันนี้ - ปัจจุบัน S2 NAS ใช้ InnoDB ทั้งหมด
 */
export async function dumpDatabase(target: DatabaseTarget, outputFile: string): Promise<void> {
  const args = [
    ...connectionArgs(target),
    '--single-transaction',
    '--quick',
    '--routines',
    '--events',
    '--triggers',
    '--default-character-set=utf8mb4',
    // ไม่ล็อกตารางทั้งหมด และไม่พึ่ง RELOAD ที่บัญชีของแอปไม่มี
    '--skip-lock-tables',
    /**
     * ห้ามใช้ --databases เด็ดขาด
     *
     * --databases จะฝัง "CREATE DATABASE s2_nas" และ "USE s2_nas" ลงในไฟล์ดัมป์
     * ทำให้การนำเข้าไปยังฐานข้อมูลอื่น (เช่นพื้นที่พักของ restore) ถูกเปลี่ยนเส้นทาง
     * กลับไปเขียนทับฐานข้อมูลจริงโดยที่คำสั่งดูเหมือนชี้ไปที่ฐานข้อมูลพัก
     *
     * ดัมป์ที่ไม่มี USE จะถูกนำเข้าฐานข้อมูลที่ระบุใน argument เท่านั้น ซึ่งเป็นสิ่งที่ต้องการ
     */
    target.database,
  ];

  const result = await execute(binary('mariadb-dump'), args, { MYSQL_PWD: target.password }, {
    stdoutFile: outputFile,
  });

  if (result.code !== 0) {
    throw new AppError('BACKUP_DATABASE_FAILED', safeDatabaseError(result.stderr), 500);
  }

  await assertDumpHasNoDatabaseSwitch(outputFile);
}

/**
 * ด่านกันชนหลังสร้างดัมป์
 *
 * ถ้าไฟล์ดัมป์มีคำสั่งเปลี่ยนฐานข้อมูลอยู่ข้างใน การนำเข้าจะไม่เชื่อฟัง argument อีกต่อไป
 * และอาจไปเขียนทับฐานข้อมูลจริง จึงต้องจับให้ได้ตั้งแต่ตอนสำรอง ไม่ใช่ตอนกู้คืน
 */
export async function assertDumpHasNoDatabaseSwitch(dumpFile: string): Promise<void> {
  const handle = await fs.promises.open(dumpFile, 'r');
  try {
    // คำสั่งเหล่านี้อยู่ส่วนหัวของไฟล์เสมอ อ่านแค่ต้นไฟล์ก็เพียงพอและไม่กินหน่วยความจำ
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    if (/^\s*(USE\s|CREATE\s+DATABASE)/im.test(head)) {
      throw new AppError(
        'BACKUP_DUMP_UNSAFE',
        'ไฟล์ดัมป์มีคำสั่งเปลี่ยนฐานข้อมูลอยู่ภายใน จึงไม่ปลอดภัยต่อการกู้คืนไปยังฐานข้อมูลพัก',
        500,
      );
    }
  } finally {
    await handle.close();
  }
}

/** รันคำสั่ง SQL สั้น ๆ เช่น CREATE DATABASE ของพื้นที่พัก restore */
export async function runSql(target: DatabaseTarget, sql: string, database?: string): Promise<string> {
  const args = [...connectionArgs(target), '--batch', '--skip-column-names'];
  if (database) args.push(database);
  args.push('-e', sql);

  const result = await execute(binary('mariadb'), args, { MYSQL_PWD: target.password });
  if (result.code !== 0) {
    throw new AppError('RESTORE_DATABASE_FAILED', safeDatabaseError(result.stderr), 500);
  }
  return result.stdout;
}

/**
 * นำไฟล์ดัมป์เข้าฐานข้อมูลปลายทาง (ใช้กับฐานข้อมูลพักเท่านั้น)
 *
 * ตรวจซ้ำก่อนนำเข้าเสมอ แม้ตอนสำรองจะตรวจไปแล้ว เพราะไฟล์ดัมป์อาจถูกสร้างโดยระบบรุ่นเก่า
 * หรือถูกแก้ไขระหว่างเก็บ การนำเข้าเป็นขั้นตอนที่ย้อนกลับไม่ได้ จึงต้องหวงมากกว่า
 */
export async function importDump(target: DatabaseTarget, database: string, dumpFile: string): Promise<void> {
  if (database === target.database) {
    throw new AppError(
      'RESTORE_TARGET_IS_LIVE',
      'ปฏิเสธการนำเข้าไปยังฐานข้อมูลที่ใช้งานจริง การกู้คืนต้องทำในฐานข้อมูลพักเท่านั้น',
      400,
    );
  }
  await assertDumpHasNoDatabaseSwitch(dumpFile);

  const result = await execute(
    binary('mariadb'),
    [...connectionArgs(target), database],
    { MYSQL_PWD: target.password },
    { stdinFile: dumpFile },
  );
  if (result.code !== 0) {
    throw new AppError('RESTORE_DATABASE_FAILED', safeDatabaseError(result.stderr), 500);
  }
}
