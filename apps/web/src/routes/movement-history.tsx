import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  REPORT_DATE_RANGE_INVALID_MESSAGE,
  REPORT_NO_MOVEMENTS_MESSAGE,
  REPORTING_TIME_ZONE,
  RETRY_MESSAGE,
  type StockMovementType,
} from '@erp/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCurrentUser } from '@/lib/auth';
import { orpc } from '@/lib/orpc';

/** The movement types a user can filter by, with their Thai labels (INV-02). */
const MOVEMENT_TYPES: { value: StockMovementType; label: string }[] = [
  { value: 'OPENING', label: 'ยอดยกมา' },
  { value: 'ADJUSTMENT', label: 'ปรับปรุงสต็อก' },
  { value: 'GOODS_RECEIPT', label: 'รับสินค้า' },
  { value: 'SALE', label: 'ขาย' },
];

const MOVEMENT_TYPE_LABEL = new Map(MOVEMENT_TYPES.map((type) => [type.value, type.label]));

/** Format a UTC ISO instant as an Asia/Bangkok date-time for display (consistent with #17). */
function formatBangkok(iso: string): string {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: REPORTING_TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

/**
 * Movement-history report (RPT-03, #19). A permitted user filters the append-only stock ledger by
 * product, store, movement type and an Asia/Bangkok date range, and sees paginated, newest-first
 * rows — each with its signed quantity change, resulting balance, movement type and the
 * source-document reference that caused it. Store scope is enforced server-side from the
 * authenticated principal: a store employee only ever sees their assigned store, a manager sees
 * every store. The screen renders loading, error and a Thai empty-state when nothing matches.
 */
export function MovementHistoryPage() {
  const user = useCurrentUser();
  // A store employee (STAFF) is pinned to their assigned store server-side; the store filter has no
  // effect for them, so it is hidden to keep the server rule legible in the UI. Cross-store roles
  // (ADMIN, MANAGER, PURCHASING) choose a store or see every store.
  const storeScoped = user?.role === 'STAFF';

  const [productId, setProductId] = useState('');
  const [storeId, setStoreId] = useState('');
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const pageSize = 20;

  const stores = useQuery(orpc.store.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  const storeItems = stores.data?.items ?? [];
  const products = useQuery(orpc.product.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  const productItems = products.data?.items ?? [];

  // An inverted range is left to the user to fix rather than sent to the API; both bounds optional.
  const rangeValid = from === '' || to === '' || from <= to;

  // Any filter change resets to the first page so the user is never stranded past the last page.
  function onFilterChange<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  const history = useQuery(
    orpc.report.movementHistory.queryOptions({
      input: {
        page,
        pageSize,
        // Only send a filter when it has a value, so an empty filter lists everything in scope.
        ...(productId ? { productId } : {}),
        ...(storeId && !storeScoped ? { storeId } : {}),
        ...(type ? { type: type as StockMovementType } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      },
      enabled: rangeValid,
    }),
  );

  const items = history.data?.items ?? [];
  const total = history.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const isEmpty = rangeValid && !!history.data && items.length === 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">ประวัติความเคลื่อนไหวของสต็อก</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">ตัวกรอง</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-wrap items-end gap-4" onSubmit={(e) => e.preventDefault()}>
            <div className="space-y-2">
              <Label htmlFor="movement-product">สินค้า</Label>
              <select
                id="movement-product"
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                value={productId}
                onChange={(e) => onFilterChange(setProductId)(e.target.value)}
              >
                <option value="">ทุกสินค้า</option>
                {productItems.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} — {product.name}
                  </option>
                ))}
              </select>
            </div>
            {!storeScoped && (
              <div className="space-y-2">
                <Label htmlFor="movement-store">สาขา</Label>
                <select
                  id="movement-store"
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  value={storeId}
                  onChange={(e) => onFilterChange(setStoreId)(e.target.value)}
                >
                  <option value="">ทุกสาขา</option>
                  {storeItems.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.code} — {store.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="movement-type">ประเภทความเคลื่อนไหว</Label>
              <select
                id="movement-type"
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                value={type}
                onChange={(e) => onFilterChange(setType)(e.target.value)}
              >
                <option value="">ทุกประเภท</option>
                {MOVEMENT_TYPES.map((movementType) => (
                  <option key={movementType.value} value={movementType.value}>
                    {movementType.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="movement-from">ตั้งแต่วันที่</Label>
              <Input
                id="movement-from"
                type="date"
                value={from}
                onChange={(e) => onFilterChange(setFrom)(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="movement-to">ถึงวันที่</Label>
              <Input
                id="movement-to"
                type="date"
                value={to}
                onChange={(e) => onFilterChange(setTo)(e.target.value)}
              />
            </div>
          </form>
          {storeScoped && (
            <p className="mt-2 text-sm text-muted-foreground">
              แสดงเฉพาะความเคลื่อนไหวของสาขาที่คุณได้รับมอบหมาย
            </p>
          )}
          {!rangeValid && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {REPORT_DATE_RANGE_INVALID_MESSAGE}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">ความเคลื่อนไหว</CardTitle>
        </CardHeader>
        <CardContent>
          {rangeValid && history.isPending && (
            <p role="status" className="text-sm text-muted-foreground">
              กำลังโหลด…
            </p>
          )}
          {history.isError && (
            <p role="alert" className="text-sm text-destructive">
              {RETRY_MESSAGE}
            </p>
          )}
          {isEmpty && (
            <p role="status" className="text-sm text-muted-foreground">
              {REPORT_NO_MOVEMENTS_MESSAGE}
            </p>
          )}
          {items.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2">วันที่/เวลา</th>
                  <th className="py-2">SKU</th>
                  <th className="py-2">ชื่อ</th>
                  <th className="py-2">สาขา</th>
                  <th className="py-2">ประเภท</th>
                  <th className="py-2">จำนวน</th>
                  <th className="py-2">คงเหลือ</th>
                  <th className="py-2">เอกสารอ้างอิง</th>
                  <th className="py-2">เหตุผล</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-t">
                    <td className="py-2">{formatBangkok(item.createdAt)}</td>
                    <td className="py-2">{item.sku}</td>
                    <td className="py-2">{item.productName}</td>
                    <td className="py-2">{item.storeCode}</td>
                    <td className="py-2">
                      <Badge variant="secondary">
                        {MOVEMENT_TYPE_LABEL.get(item.type) ?? item.type}
                      </Badge>
                    </td>
                    <td className="py-2">
                      {item.qtyChange > 0 ? `+${item.qtyChange}` : item.qtyChange}
                    </td>
                    <td className="py-2">{item.balanceAfter}</td>
                    <td className="py-2">{item.sourceDocument}</td>
                    <td className="py-2">{item.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {items.length > 0 && (
            <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
              <span>
                หน้า {page} จาก {pageCount}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  หน้าก่อนหน้า
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page >= pageCount}
                  onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                >
                  หน้าถัดไป
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
