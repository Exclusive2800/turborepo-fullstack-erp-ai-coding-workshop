import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  REPORT_NO_LOW_STOCK_MESSAGE,
  REPORT_NO_STOCK_MESSAGE,
  RETRY_MESSAGE,
  type StockItem,
} from '@erp/contracts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { orpc } from '@/lib/orpc';

type ReportKind = 'on-hand' | 'low-stock';

/**
 * Stock-on-hand and low-stock reports (RPT-02, user story 47, AC-08 low-stock half). A permitted
 * user searches stock by SKU or name, optionally scoped to a store, and sees per-store on-hand rows
 * with each product's reorder threshold and low-stock flag. Zero-stock matches stay visible. The
 * low-stock report lists only products whose on-hand is at or below their reorder threshold for the
 * chosen store — it needs a store, because low stock is defined per store. The screen renders
 * loading, error and a report-specific Thai empty-state when nothing matches.
 */
export function StockReportsPage() {
  const [kind, setKind] = useState<ReportKind>('on-hand');
  const [query, setQuery] = useState('');
  const [storeId, setStoreId] = useState('');

  const stores = useQuery(orpc.store.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  const storeItems = stores.data?.items ?? [];

  // Only send a filter when it has a value, so an empty search lists everything.
  const trimmedQuery = query.trim();
  const onHand = useQuery(
    orpc.report.stockOnHand.queryOptions({
      input: {
        ...(trimmedQuery ? { query: trimmedQuery } : {}),
        ...(storeId ? { storeId } : {}),
      },
      enabled: kind === 'on-hand',
    }),
  );
  // Low stock is defined against the per-store threshold, so the report needs a chosen store; the
  // query is disabled until one is picked.
  const lowStock = useQuery(
    orpc.report.lowStock.queryOptions({
      input: { storeId, ...(trimmedQuery ? { query: trimmedQuery } : {}) },
      enabled: kind === 'low-stock' && storeId !== '',
    }),
  );

  const report = kind === 'on-hand' ? onHand : lowStock;
  const items: StockItem[] = report.data?.items ?? [];
  const needsStore = kind === 'low-stock' && storeId === '';
  // The report resolved and matched nothing (and, for low-stock, a store was chosen).
  const isEmpty = !needsStore && !!report.data && items.length === 0;
  const emptyMessage =
    kind === 'low-stock' ? REPORT_NO_LOW_STOCK_MESSAGE : REPORT_NO_STOCK_MESSAGE;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">รายงานสต็อก</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">ตัวกรอง</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={(e) => e.preventDefault()}>
            <fieldset className="flex flex-wrap items-center gap-6">
              <legend className="mb-2 text-sm font-medium">ประเภทรายงาน</legend>
              <div className="flex items-center gap-2">
                <input
                  id="report-kind-on-hand"
                  type="radio"
                  name="report-kind"
                  value="on-hand"
                  checked={kind === 'on-hand'}
                  onChange={() => setKind('on-hand')}
                />
                <Label htmlFor="report-kind-on-hand">สินค้าคงเหลือ</Label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="report-kind-low-stock"
                  type="radio"
                  name="report-kind"
                  value="low-stock"
                  checked={kind === 'low-stock'}
                  onChange={() => setKind('low-stock')}
                />
                <Label htmlFor="report-kind-low-stock">สินค้าใกล้หมด</Label>
              </div>
            </fieldset>

            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-2">
                <Label htmlFor="stock-report-query">ค้นหาสินค้า</Label>
                <Input
                  id="stock-report-query"
                  placeholder="รหัสสินค้า (SKU) หรือชื่อสินค้า"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="stock-report-store">สาขา</Label>
                <select
                  id="stock-report-store"
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  value={storeId}
                  onChange={(e) => setStoreId(e.target.value)}
                >
                  <option value="">ทุกสาขา</option>
                  {storeItems.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.code} — {store.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {kind === 'low-stock' ? 'สินค้าใกล้หมด' : 'สินค้าคงเหลือตามสาขา'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {needsStore && (
            <p role="status" className="text-sm text-muted-foreground">
              กรุณาเลือกสาขาเพื่อดูสินค้าใกล้หมด
            </p>
          )}
          {!needsStore && report.isPending && (
            <p role="status" className="text-sm text-muted-foreground">
              กำลังโหลด…
            </p>
          )}
          {report.isError && (
            <p role="alert" className="text-sm text-destructive">
              {RETRY_MESSAGE}
            </p>
          )}
          {isEmpty && (
            <p role="status" className="text-sm text-muted-foreground">
              {emptyMessage}
            </p>
          )}
          {items.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2">SKU</th>
                  <th className="py-2">ชื่อ</th>
                  <th className="py-2">สาขา</th>
                  <th className="py-2">คงเหลือ</th>
                  <th className="py-2">หน่วย</th>
                  <th className="py-2">จุดสั่งซื้อ</th>
                  <th className="py-2">สถานะ</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={`${item.productId}:${item.storeId}`} className="border-t">
                    <td className="py-2">{item.sku}</td>
                    <td className="py-2">{item.name}</td>
                    <td className="py-2">{item.storeCode}</td>
                    <td className="py-2">{item.quantity}</td>
                    <td className="py-2">{item.unit}</td>
                    <td className="py-2">{item.reorderThreshold ?? '—'}</td>
                    <td className="py-2">
                      {item.lowStock ? (
                        <Badge variant="destructive">ใกล้หมด</Badge>
                      ) : (
                        <Badge variant="secondary">ปกติ</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
