/**
 * The shared, actionable Thai error messages every screen reuses.
 *
 * Each message tells the user what to do next — correct their input, or retry later —
 * and never leaks a stack trace or database detail. The API throws these as the
 * `message` of an `ORPCError`; the web renders the message verbatim in a `role="alert"`.
 */

/** A duplicate unique code. The user must correct the input. */
export function duplicateCodeMessage(code: string): string {
  return `รหัส "${code}" ถูกใช้งานแล้ว กรุณาแก้ไขรหัสให้ไม่ซ้ำกับรายการที่มีอยู่`;
}

/** Requested resource was not found. The user must correct the input. */
export const NOT_FOUND_MESSAGE = 'ไม่พบรายการที่ต้องการ กรุณาตรวจสอบและลองใหม่อีกครั้ง';

/** Input failed validation. The user must correct the input. */
export const VALIDATION_MESSAGE = 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบและแก้ไขข้อมูลก่อนบันทึก';

/** An unexpected server-side failure. The user should retry. */
export const RETRY_MESSAGE = 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้งในภายหลัง';

/** The empty-state message shown when a list has no rows yet. */
export const EMPTY_LIST_MESSAGE = 'ยังไม่มีข้อมูล';
