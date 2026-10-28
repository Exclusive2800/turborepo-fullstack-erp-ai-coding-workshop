import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { SaleCreateInput } from '@erp/contracts';
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
}

function newLine(): DraftLine {
  return { key: crypto.randomUUID(), productId: '', quantity: '' };
}

/**
 * Create a draft sale (SAL-01, SAL-02). A STAFF employee adds at least one product line with a
 * positive whole-number quantity. The store is derived server-side from the signed-in employee
 * (never chosen here), and the selling price is the product's current price — shown read-only and
 * never sent by the client. The API validates the lines and snapshots each product's name/price;
 * this form surfaces loading, success and actionable Thai error states.
 */
function DraftSaleForm() {
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);

  const products = useQuery(orpc.product.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  // Only active products may be added to a new document (MD-02); keep deactivated ones out of the picker.
  const productItems = (products.data?.items ?? []).filter((product) => product.active);
  const priceById = new Map(productItems.map((product) => [product.id, product.sellingPrice]));

  const create = useMutation(
    orpc.sale.create.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.sale.list.key() });
        setLines([newLine()]);
      },
    }),
  );

  const updateLine = (key: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const addLine = () => setLines((prev) => [...prev, newLine()]);
  const removeLine = (key: string) =>
    setLines((prev) => (prev.length > 1 ? prev.filter((line) => line.key !== key) : prev));

  // The payload carries only product and quantity: no price (controlled, SAL-02) and no store
  // (derived from the principal, SAL-01) ever leave the browser.
  const buildPayload = (): SaleCreateInput => ({
    lines: lines.map((line) => ({
      productId: line.productId,
      quantity: Number(line.quantity),
    })),
  });

  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">สร้างรายการขาย (ฉบับร่าง)</h2>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(buildPayload());
          }}
        >
          <fieldset className="space-y-3">
            <legend className="text-sm text-muted-foreground">รายการสินค้า</legend>
            {lines.map((line, index) => {
              const price = priceById.get(line.productId);
              return (
                <div
                  key={line.key}
                  className="grid gap-3 sm:grid-cols-[2fr_1fr_auto_auto] sm:items-end"
                >
                  <div className="space-y-2">
                    <Label htmlFor={`sale-line-product-${line.key}`}>สินค้า {index + 1}</Label>
                    <select
                      id={`sale-line-product-${line.key}`}
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
                    <Label htmlFor={`sale-line-qty-${line.key}`}>จำนวน {index + 1}</Label>
                    <Input
                      id={`sale-line-qty-${line.key}`}
                      type="number"
                      min="1"
                      step="1"
                      value={line.quantity}
                      onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <span className="block text-sm text-muted-foreground">ราคาต่อหน่วย</span>
                    <span className="block text-sm">{price ? `฿${price}` : '—'}</span>
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
              );
            })}
            <Button type="button" variant="outline" size="sm" onClick={addLine}>
              เพิ่มรายการ
            </Button>
          </fieldset>

          <div>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'กำลังบันทึก…' : 'บันทึกรายการขาย'}
            </Button>
            {create.isSuccess && (
              <p className="mt-2 text-sm text-green-600">บันทึกรายการขายฉบับร่างแล้ว</p>
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

export function SalesPage() {
  const user = useCurrentUser();
  const isStaff = user?.role === 'STAFF';
  const sales = useQuery(orpc.sale.list.queryOptions({ input: { page: 1, pageSize: 20 } }));
  const items = sales.data?.items ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">รายการขาย</h1>

      {isStaff && <DraftSaleForm />}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">ประวัติรายการขาย</CardTitle>
        </CardHeader>
        <CardContent>
          <ListStates
            isPending={sales.isPending}
            isError={sales.isError}
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
                {items.map((sale) => (
                  <tr key={sale.id} className="border-t">
                    <td className="py-2">{sale.id}</td>
                    <td className="py-2">
                      <Badge variant="secondary">{sale.status}</Badge>
                    </td>
                    <td className="py-2">{sale.lines.length}</td>
                    <td className="py-2">{sale.total}</td>
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
