import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ListStates } from '@/components/list-states';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { orpc } from '@/lib/orpc';

export function StockPage() {
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
