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

/** A SKU change was attempted after a transaction locked it. The user must correct the input. */
export const SKU_LOCKED_MESSAGE =
  'ไม่สามารถแก้ไขรหัสสินค้า (SKU) ได้ เนื่องจากมีการอ้างอิงในเอกสารแล้ว กรุณาคงรหัสเดิมไว้';

/** A deactivated product was added to a new document. The user must correct the input. */
export const PRODUCT_INACTIVE_MESSAGE =
  'สินค้านี้ถูกปิดการใช้งานแล้ว ไม่สามารถเพิ่มลงในเอกสารใหม่ได้ กรุณาเลือกสินค้าอื่น';

/** A manager adjustment arrived without a reason (INV-05). The user must supply a reason. */
export const ADJUSTMENT_REASON_REQUIRED_MESSAGE =
  'กรุณาระบุเหตุผลในการปรับปรุงสต็อก เพื่อให้สามารถตรวจสอบย้อนหลังได้';

/** A stock change would drive the balance below zero (INV-03/04). The user must correct the quantity. */
export const INSUFFICIENT_STOCK_MESSAGE =
  'จำนวนสินค้าคงเหลือไม่เพียงพอ ไม่สามารถทำรายการที่ทำให้สต็อกติดลบได้ กรุณาตรวจสอบจำนวน';

/** An ordered quantity on a PO line was not a positive whole number (PO-02). Correct the input. */
export const PO_QUANTITY_POSITIVE_MESSAGE =
  'จำนวนสั่งซื้อต้องเป็นจำนวนเต็มบวก (มากกว่า 0 และไม่มีเศษทศนิยม) กรุณาแก้ไข';

/** A PO line's purchase unit price was negative (PO-02). Correct the input. */
export const PO_UNIT_PRICE_NONNEGATIVE_MESSAGE = 'ราคาต่อหน่วยต้องไม่ติดลบ กรุณาแก้ไข';

/** The same SKU appeared on more than one line of a single PO (PO-02). Correct the input. */
export const PO_DUPLICATE_SKU_MESSAGE =
  'มีสินค้าซ้ำกันในใบสั่งซื้อเดียวกัน กรุณารวมเป็นรายการเดียวหรือลบรายการที่ซ้ำ';

/** A PO was submitted without any product line (PO-01). The user must add at least one line. */
export const PO_LINES_REQUIRED_MESSAGE =
  'ใบสั่งซื้อต้องมีสินค้าอย่างน้อย 1 รายการ กรุณาเพิ่มรายการสินค้า';

/** A sale-line quantity was not a positive whole number (SAL-01). The user must correct the input. */
export const SALE_QUANTITY_POSITIVE_MESSAGE =
  'จำนวนขายต้องเป็นจำนวนเต็มบวก (มากกว่า 0 และไม่มีเศษทศนิยม) กรุณาแก้ไข';

/** A sale was submitted without any product line (SAL-01). The user must add at least one line. */
export const SALE_LINES_REQUIRED_MESSAGE =
  'รายการขายต้องมีสินค้าอย่างน้อย 1 รายการ กรุณาเพิ่มรายการสินค้า';

/** The same product appeared on more than one sale line (SAL-01). The user must correct the input. */
export const SALE_DUPLICATE_PRODUCT_MESSAGE =
  'มีสินค้าซ้ำกันในรายการขายเดียวกัน กรุณารวมเป็นรายการเดียวหรือลบรายการที่ซ้ำ';

/** A store-scoped user acted for a store that is not theirs. The user cannot retry; it is forbidden. */
export const STORE_SCOPE_FORBIDDEN_MESSAGE =
  'คุณไม่มีสิทธิ์ทำรายการสำหรับสาขานี้ กรุณาทำรายการเฉพาะสาขาที่คุณได้รับมอบหมาย';

/** A store-scoped user has no assigned store, so no store can be derived. The user cannot retry. */
export const STORE_SCOPE_UNASSIGNED_MESSAGE =
  'บัญชีของคุณยังไม่ได้ถูกกำหนดสาขา กรุณาติดต่อผู้ดูแลระบบเพื่อกำหนดสาขาก่อนทำรายการ';

/** A cross-store user did not name a target store (INV). The user must choose a store. */
export const STORE_SCOPE_TARGET_REQUIRED_MESSAGE = 'กรุณาเลือกสาขาที่ต้องการทำรายการ';
