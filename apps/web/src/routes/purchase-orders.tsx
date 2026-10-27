import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { PurchaseOrderCreateInput } from '@erp/contracts';
import { ListStates } from '@/components/list-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCurrentUser } from '@/lib/auth';
import { apiErrorMessage } from '@/lib/errors';
import { orpc } from '@/lib/orpc';

/** One editable line in the draft form, before it is sent to the API. */
interface DraftLine {
  key: string;
  productId: string;
  quantity: string;
  unitPrice: string;
}

function newLine(): DraftLine {
  return { key: crypto.randomUUID(), productId: '', quantity: '', unitPrice: '' };
}

/**
 * Create a draft purchase order (PO-01/PO-02). A PURCHASING officer picks a supplier, a destination
 * store and an expected receipt date, then adds at least one product line with an ordered quantity
 * and a purchase unit price. The API validates the lines (positive whole quantities, non-negative
 * prices, no duplicate SKUs) and snapshots each product's name/price; this form surfaces loading,
 * success and actionable Thai error states.
 */
function DraftPurchaseOrderForm() {
  const queryClient = useQueryClient();
  const [supplierId, setSupplierId] = useState('');
  const [storeId, setStoreId] = useState('');
  const [expectedReceiptDate, setExpectedReceiptDate] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);

  const suppliers = useQuery(
    orpc.supplier.list.queryOptions({ input: { page: 1, pageSize: 100 } }),
  );
  const stores = useQuery(orpc.store.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  const products = useQuery(orpc.product.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  const supplierItems = suppliers.data?.items ?? [];
  const storeItems = stores.data?.items ?? [];
  // Only active products may be added to a new document (MD-02); keep deactivated ones out of the picker.
  const productItems = (products.data?.items ?? []).filter((product) => product.active);

  const create = useMutation(
    orpc.purchaseOrder.create.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.purchaseOrder.list.key() });
        setSupplierId('');
        setStoreId('');
        setExpectedReceiptDate('');
        setLines([newLine()]);
      },
    }),
  );

  const updateLine = (key: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const addLine = () => setLines((prev) => [...prev, newLine()]);
  const removeLine = (key: string) =>
    setLines((prev) => (prev.length > 1 ? prev.filter((line) => line.key !== key) : prev));

  const buildPayload = (): PurchaseOrderCreateInput => ({
    supplierId,
    storeId,
    // The date input is a calendar day; send it as an ISO datetime at UTC midnight.
    expectedReceiptDate: new Date(`${expectedReceiptDate}T00:00:00.000Z`).toISOString(),
    lines: lines.map((line) => ({
      productId: line.productId,
      quantity: Number(line.quantity),
      unitPrice: Number(line.unitPrice),
    })),
  });

  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">สร้างใบสั่งซื้อ (ฉบับร่าง)</h2>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(buildPayload());
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="po-supplier">ผู้จัดจำหน่าย</Label>
              <select
                id="po-supplier"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                required
              >
                <option value="">เลือกผู้จัดจำหน่าย</option>
                {supplierItems.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.code} — {supplier.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="po-store">สาขาปลายทาง</Label>
              <select
                id="po-store"
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
              <Label htmlFor="po-date">วันที่คาดว่าจะรับสินค้า</Label>
              <Input
                id="po-date"
                type="date"
                value={expectedReceiptDate}
                onChange={(e) => setExpectedReceiptDate(e.target.value)}
                required
              />
            </div>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm text-muted-foreground">รายการสินค้า</legend>
            {lines.map((line, index) => (
              <div
                key={line.key}
                className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end"
              >
                <div className="space-y-2">
                  <Label htmlFor={`po-line-product-${line.key}`}>สินค้า {index + 1}</Label>
                  <select
                    id={`po-line-product-${line.key}`}
                    className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                    value={line.productId}
                    onChange={(e) => updateLine(line.key, { productId: e.target.value })}
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
                  <Label htmlFor={`po-line-qty-${line.key}`}>จำนวน {index + 1}</Label>
                  <Input
                    id={`po-line-qty-${line.key}`}
                    type="number"
                    min="1"
                    step="1"
                    value={line.quantity}
                    onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`po-line-price-${line.key}`}>ราคาต่อหน่วย {index + 1}</Label>
                  <Input
                    id={`po-line-price-${line.key}`}
                    type="number"
                    min="0"
                    step="0.01"
                    value={line.unitPrice}
                    onChange={(e) => updateLine(line.key, { unitPrice: e.target.value })}
                    required
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeLine(line.key)}
                  disabled={lines.length === 1}
                  aria-label={`ลบรายการ ${index + 1}`}
                >
                  ลบ
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={addLine}>
              เพิ่มรายการ
            </Button>
          </fieldset>

          <div>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'กำลังบันทึก…' : 'บันทึกใบสั่งซื้อ'}
            </Button>
            {create.isSuccess && (
              <p className="mt-2 text-sm text-green-600">บันทึกใบสั่งซื้อฉบับร่างแล้ว</p>
            )}
            {create.error && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {apiErrorMessage(create.error)}
              </p>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function PurchaseOrdersPage() {
  const user = useCurrentUser();
  const isPurchasing = user?.role === 'PURCHASING';
  const orders = useQuery(
    orpc.purchaseOrder.list.queryOptions({ input: { page: 1, pageSize: 20 } }),
  );
  const items = orders.data?.items ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">ใบสั่งซื้อ</h1>

      {isPurchasing && <DraftPurchaseOrderForm />}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">รายการใบสั่งซื้อ</CardTitle>
        </CardHeader>
        <CardContent>
          <ListStates
            isPending={orders.isPending}
            isError={orders.isError}
            isEmpty={items.length === 0}
          />
          {items.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2">เลขที่</th>
                  <th className="py-2">สถานะ</th>
                  <th className="py-2">จำนวนรายการ</th>
                  <th className="py-2">ยอดรวม</th>
                </tr>
              </thead>
              <tbody>
                {items.map((order) => (
                  <tr key={order.id} className="border-t">
                    <td className="py-2">{order.number}</td>
                    <td className="py-2">
                      <Badge variant="secondary">{order.status}</Badge>
                    </td>
                    <td className="py-2">{order.lines.length}</td>
                    <td className="py-2">{order.total}</td>
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
