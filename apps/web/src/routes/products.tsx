import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Product, ProductCreateInput, Store } from '@erp/contracts';
import { ListStates } from '@/components/list-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCurrentUser } from '@/lib/auth';
import { apiErrorMessage } from '@/lib/errors';
import { orpc } from '@/lib/orpc';

function thresholdFor(product: Product | null, storeId: string): string {
  const match = product?.thresholds.find((t) => t.storeId === storeId);
  return match ? String(match.threshold) : '';
}

function ProductForm({
  editing,
  stores,
  onDone,
}: {
  editing: Product | null;
  stores: Store[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [sku, setSku] = useState(editing?.sku ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [category, setCategory] = useState(editing?.category ?? '');
  const [unit, setUnit] = useState(editing?.unit ?? '');
  const [sellingPrice, setSellingPrice] = useState(editing?.sellingPrice ?? '');
  const [active, setActive] = useState(editing?.active ?? true);
  // One threshold input per store, keyed by store id. Empty means "no threshold for this store".
  const [thresholds, setThresholds] = useState<Record<string, string>>(() =>
    Object.fromEntries(stores.map((store) => [store.id, thresholdFor(editing, store.id)])),
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: orpc.product.list.key() });
  const reset = () => {
    setSku('');
    setName('');
    setCategory('');
    setUnit('');
    setSellingPrice('');
    setActive(true);
    setThresholds(Object.fromEntries(stores.map((store) => [store.id, ''])));
    onDone();
  };

  const create = useMutation(
    orpc.product.create.mutationOptions({ onSuccess: () => invalidate().then(reset) }),
  );
  const update = useMutation(
    orpc.product.update.mutationOptions({ onSuccess: () => invalidate().then(reset) }),
  );
  const mutation = editing ? update : create;

  const buildPayload = (): ProductCreateInput => ({
    sku,
    name,
    category,
    unit,
    sellingPrice: Number(sellingPrice),
    active,
    thresholds: stores
      .filter((store) => thresholds[store.id]?.trim() !== '' && thresholds[store.id] !== undefined)
      .map((store) => ({ storeId: store.id, threshold: Number(thresholds[store.id]) })),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{editing ? 'แก้ไขสินค้า' : 'เพิ่มสินค้า'}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const payload = buildPayload();
            if (editing) update.mutate({ id: editing.id, ...payload });
            else create.mutate(payload);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="product-sku">รหัสสินค้า (SKU)</Label>
            <Input
              id="product-sku"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              disabled={editing?.skuLocked}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="product-name">ชื่อสินค้า</Label>
            <Input
              id="product-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="product-category">หมวดหมู่</Label>
            <Input
              id="product-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="product-unit">หน่วย</Label>
            <Input
              id="product-unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="product-price">ราคาขาย</Label>
            <Input
              id="product-price"
              type="number"
              min="0"
              step="0.01"
              value={sellingPrice}
              onChange={(e) => setSellingPrice(e.target.value)}
              required
            />
          </div>
          <div className="flex items-center gap-2 pt-7">
            <input
              id="product-active"
              type="checkbox"
              className="size-4"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            <Label htmlFor="product-active">เปิดใช้งาน</Label>
          </div>

          <fieldset className="space-y-2 sm:col-span-2">
            <legend className="text-sm text-muted-foreground">จุดสั่งซื้อต่อสาขา</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {stores.map((store) => (
                <div key={store.id} className="space-y-2">
                  <Label htmlFor={`threshold-${store.id}`}>จุดสั่งซื้อ {store.code}</Label>
                  <Input
                    id={`threshold-${store.id}`}
                    type="number"
                    min="0"
                    step="1"
                    value={thresholds[store.id] ?? ''}
                    onChange={(e) =>
                      setThresholds((prev) => ({ ...prev, [store.id]: e.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
          </fieldset>

          <div className="flex items-end gap-2 sm:col-span-2">
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'กำลังบันทึก…' : 'บันทึก'}
            </Button>
            {editing && (
              <Button type="button" variant="ghost" onClick={reset}>
                ยกเลิก
              </Button>
            )}
          </div>
          {mutation.error && (
            <p role="alert" className="sm:col-span-2 text-sm text-destructive">
              {apiErrorMessage(mutation.error)}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export function ProductsPage() {
  const user = useCurrentUser();
  const isAdmin = user?.role === 'ADMIN';
  const [editing, setEditing] = useState<Product | null>(null);
  const products = useQuery(orpc.product.list.queryOptions({ input: { page: 1, pageSize: 20 } }));
  const stores = useQuery(orpc.store.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  const items = products.data?.items ?? [];
  const storeItems = stores.data?.items ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">สินค้า</h1>

      {isAdmin && (
        <ProductForm
          key={editing?.id ?? 'new'}
          editing={editing}
          stores={storeItems}
          onDone={() => setEditing(null)}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">รายการสินค้า</CardTitle>
        </CardHeader>
        <CardContent>
          <ListStates
            isPending={products.isPending}
            isError={products.isError}
            isEmpty={items.length === 0}
          />
          {items.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2">SKU</th>
                  <th className="py-2">ชื่อ</th>
                  <th className="py-2">หมวดหมู่</th>
                  <th className="py-2">หน่วย</th>
                  <th className="py-2">ราคาขาย</th>
                  <th className="py-2">สถานะ</th>
                  {isAdmin && <th className="py-2" />}
                </tr>
              </thead>
              <tbody>
                {items.map((product) => (
                  <tr key={product.id} className="border-t">
                    <td className="py-2">{product.sku}</td>
                    <td className="py-2">{product.name}</td>
                    <td className="py-2">{product.category}</td>
                    <td className="py-2">{product.unit}</td>
                    <td className="py-2">{product.sellingPrice}</td>
                    <td className="py-2">
                      <Badge variant={product.active ? 'default' : 'secondary'}>
                        {product.active ? 'เปิดใช้งาน' : 'ปิดการใช้งาน'}
                      </Badge>
                    </td>
                    {isAdmin && (
                      <td className="py-2 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(product)}
                          aria-label={`แก้ไข ${product.sku}`}
                        >
                          แก้ไข
                        </Button>
                      </td>
                    )}
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
