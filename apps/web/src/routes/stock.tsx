import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ListStates } from '@/components/list-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCurrentUser } from '@/lib/auth';
import { apiErrorMessage } from '@/lib/errors';
import { orpc } from '@/lib/orpc';

/**
 * Manager stock adjustment (INV-05). A MANAGER raises or lowers the on-hand quantity for a product
 * in a store with a mandatory reason. The reason, the signed quantity and the store are posted to
 * the API, which enforces never-negative and records the reason/actor/timestamp as a movement. The
 * form surfaces loading, success and error (Thai) states.
 */
function AdjustStockForm() {
  const queryClient = useQueryClient();
  const [productId, setProductId] = useState('');
  const [storeId, setStoreId] = useState('');
  const [qtyChange, setQtyChange] = useState('');
  const [reason, setReason] = useState('');

  const products = useQuery(orpc.product.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  const stores = useQuery(orpc.store.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  const productItems = products.data?.items ?? [];
  const storeItems = stores.data?.items ?? [];

  const adjust = useMutation(
    orpc.stock.adjust.mutationOptions({
      onSuccess: async () => {
        // The ledger and the on-hand balances both changed: refresh the search and history lists.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.stock.search.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.stock.movements.key() }),
        ]);
        setQtyChange('');
        setReason('');
      },
    }),
  );

  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">ปรับปรุงสต็อก</h2>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            adjust.mutate({ productId, storeId, qtyChange: Number(qtyChange), reason });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="adjust-product">สินค้า</Label>
            <select
              id="adjust-product"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              required
            >
              <option value="">เลือกสินค้า</option>
              {productItems.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.sku} — {product.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="adjust-store">สาขาที่ปรับ</Label>
            <select
              id="adjust-store"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              required
            >
              <option value="">เลือกสาขา</option>
              {storeItems.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.code} — {store.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="adjust-qty">จำนวนที่ปรับ (+ เพิ่ม / - ลด)</Label>
            <Input
              id="adjust-qty"
              type="number"
              step="1"
              placeholder="เช่น 5 หรือ -3"
              value={qtyChange}
              onChange={(e) => setQtyChange(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="adjust-reason">เหตุผล</Label>
            <Input
              id="adjust-reason"
              placeholder="ระบุเหตุผลในการปรับปรุงสต็อก"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={adjust.isPending}>
              {adjust.isPending ? 'กำลังบันทึก…' : 'บันทึกการปรับปรุง'}
            </Button>
            {adjust.isSuccess && (
              <p className="mt-2 text-sm text-green-600">บันทึกการปรับปรุงสต็อกแล้ว</p>
            )}
            {adjust.error && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {apiErrorMessage(adjust.error)}
              </p>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function StockPage() {
  const user = useCurrentUser();
  const isManager = user?.role === 'MANAGER';
  const [query, setQuery] = useState('');
  const [storeId, setStoreId] = useState('');

  const stores = useQuery(orpc.store.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  const stock = useQuery(
    orpc.stock.search.queryOptions({
      input: {
        page: 1,
        pageSize: 20,
        // Only send a filter when it has a value, so an empty search lists everything.
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(storeId ? { storeId } : {}),
      },
    }),
  );
  const items = stock.data?.items ?? [];
  const storeItems = stores.data?.items ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">สต็อกสินค้า</h1>

      {isManager && <AdjustStockForm />}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">ค้นหาสต็อก</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-wrap items-end gap-4" onSubmit={(e) => e.preventDefault()}>
            <div className="space-y-2">
              <Label htmlFor="stock-query">ค้นหาสินค้า</Label>
              <Input
                id="stock-query"
                placeholder="รหัสสินค้า (SKU) หรือชื่อสินค้า"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="stock-store">สาขา</Label>
              <select
                id="stock-store"
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
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">รายการสต็อก</CardTitle>
        </CardHeader>
        <CardContent>
          <ListStates
            isPending={stock.isPending}
            isError={stock.isError}
            isEmpty={items.length === 0}
          />
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
