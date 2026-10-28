import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { GoodsReceiptCreateInput } from '@erp/contracts';
import { ListStates } from '@/components/list-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiErrorMessage } from '@/lib/errors';
import { orpc } from '@/lib/orpc';

/**
 * Record a goods receipt against an approved purchase order (GR-01, Seam 3). A store employee opens
 * an order that is Approved or Partially Received, sees the ordered, previously received and
 * outstanding quantity for each line, enters how much arrived now (prefilled with the outstanding
 * remainder), and confirms. The server allocates the receipt number, raises the destination store's
 * stock, writes one movement per line and advances the order — all atomically (#9, GR-03).
 */
function ReceiveForm({ purchaseOrderId }: { purchaseOrderId: string }) {
  const queryClient = useQueryClient();
  const receivable = useQuery(
    orpc.goodsReceipt.receivable.queryOptions({ input: { purchaseOrderId } }),
  );
  // Quantity to receive now, keyed by PO line id. Defaults to each line's outstanding remainder.
  const [quantities, setQuantities] = useState<Record<string, string>>({});

  const receive = useMutation(
    orpc.goodsReceipt.receive.mutationOptions({
      onSuccess: async () => {
        // Refresh the receivable view in place so ordered/received/outstanding update; the form
        // stays open showing the success message and the new outstanding remainders.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.purchaseOrder.list.key() }),
          queryClient.invalidateQueries({
            queryKey: orpc.goodsReceipt.receivable.key({ input: { purchaseOrderId } }),
          }),
        ]);
        setQuantities({});
      },
    }),
  );

  const lines = receivable.data?.lines ?? [];
  const valueFor = (line: { purchaseOrderLineId: string; outstanding: number }) =>
    quantities[line.purchaseOrderLineId] ?? String(line.outstanding);

  const buildPayload = (): GoodsReceiptCreateInput => ({
    purchaseOrderId,
    lines: lines
      .map((line) => ({
        purchaseOrderLineId: line.purchaseOrderLineId,
        quantity: Number(valueFor(line)),
      }))
      // Only send lines with a positive quantity to receive.
      .filter((line) => line.quantity > 0),
  });

  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">รับสินค้า {receivable.data?.number ?? ''}</h2>
      </CardHeader>
      <CardContent>
        <ListStates
          isPending={receivable.isPending}
          isError={receivable.isError}
          isEmpty={lines.length === 0}
        />
        {lines.length > 0 && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              receive.mutate(buildPayload());
            }}
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2">สินค้า</th>
                  <th className="py-2">สั่งซื้อ</th>
                  <th className="py-2">รับแล้ว</th>
                  <th className="py-2">คงค้าง</th>
                  <th className="py-2">จำนวนที่รับ</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.purchaseOrderLineId} className="border-t">
                    <td className="py-2">
                      {line.sku} — {line.productName}
                    </td>
                    <td className="py-2">{line.ordered}</td>
                    <td className="py-2">{line.received}</td>
                    <td className="py-2">{line.outstanding}</td>
                    <td className="py-2">
                      <Label
                        htmlFor={`receive-qty-${line.purchaseOrderLineId}`}
                        className="sr-only"
                      >
                        จำนวนที่รับ {line.sku}
                      </Label>
                      <Input
                        id={`receive-qty-${line.purchaseOrderLineId}`}
                        type="number"
                        min="0"
                        step="1"
                        max={line.outstanding}
                        className="w-24"
                        value={valueFor(line)}
                        onChange={(e) =>
                          setQuantities((prev) => ({
                            ...prev,
                            [line.purchaseOrderLineId]: e.target.value,
                          }))
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div>
              <Button type="submit" disabled={receive.isPending}>
                {receive.isPending ? 'กำลังบันทึก…' : 'ยืนยันการรับสินค้า'}
              </Button>
              {receive.isSuccess && (
                <p className="mt-2 text-sm text-green-600">บันทึกการรับสินค้าแล้ว</p>
              )}
              {receive.error && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {apiErrorMessage(receive.error)}
                </p>
              )}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export function ReceivingPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const orders = useQuery(
    orpc.purchaseOrder.list.queryOptions({ input: { page: 1, pageSize: 100 } }),
  );
  // Only Approved or Partially Received orders can be received against (GR-01).
  const receivable = (orders.data?.items ?? []).filter(
    (order) => order.status === 'APPROVED' || order.status === 'PARTIALLY_RECEIVED',
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">รับสินค้า</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">ใบสั่งซื้อที่รอรับสินค้า</CardTitle>
        </CardHeader>
        <CardContent>
          <ListStates
            isPending={orders.isPending}
            isError={orders.isError}
            isEmpty={receivable.length === 0}
          />
          {receivable.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2">เลขที่</th>
                  <th className="py-2">สถานะ</th>
                  <th className="py-2">การดำเนินการ</th>
                </tr>
              </thead>
              <tbody>
                {receivable.map((order) => (
                  <tr key={order.id} className="border-t">
                    <td className="py-2">{order.number}</td>
                    <td className="py-2">
                      <Badge variant="secondary">{order.status}</Badge>
                    </td>
                    <td className="py-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => setSelectedId(order.id)}
                        aria-label={`รับสินค้า ${order.number}`}
                      >
                        รับสินค้า
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {selectedId && <ReceiveForm purchaseOrderId={selectedId} />}
    </div>
  );
}
