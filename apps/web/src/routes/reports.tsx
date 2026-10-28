import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { REPORT_NO_SALES_MESSAGE, REPORTING_TIME_ZONE, RETRY_MESSAGE } from '@erp/contracts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { orpc } from '@/lib/orpc';

/** Today as an Asia/Bangkok calendar day (`YYYY-MM-DD`), the reporting day's own zone. */
function todayInBangkok(): string {
  // `en-CA` formats as YYYY-MM-DD; the Bangkok zone makes it the reporting day, not the browser's.
  return new Intl.DateTimeFormat('en-CA', { timeZone: REPORTING_TIME_ZONE }).format(new Date());
}

/**
 * Daily sales report (RPT-01, user story 46/51, AC-08 sales-zero half). A manager picks an
 * Asia/Bangkok date range and, optionally, a store, and sees the confirmed-sale document count,
 * units sold and total amount for that reporting-day range. A reporting day is a Bangkok calendar
 * day computed server-side, so a sale confirmed near Bangkok midnight lands in the correct day.
 * When nothing matches, the figures are zero and a clear Thai empty-state message is shown.
 */
export function ReportsPage() {
  const today = todayInBangkok();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [storeId, setStoreId] = useState('');

  const stores = useQuery(orpc.store.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  const storeItems = stores.data?.items ?? [];

  // The range is always set (it defaults to today), so the report query is enabled whenever `to` is
  // on or after `from`; an inverted range is left to the user to fix rather than sent to the API.
  const rangeValid = from <= to;
  const report = useQuery(
    orpc.report.dailySales.queryOptions({
      input: {
        from,
        to,
        // Only send a store filter when one is chosen; omitted reports across all stores.
        ...(storeId ? { storeId } : {}),
      },
      enabled: rangeValid,
    }),
  );
  const data = report.data;
  const isEmpty = !!data && data.documentCount === 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">รายงานยอดขายรายวัน</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">ตัวกรอง</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-wrap items-end gap-4" onSubmit={(e) => e.preventDefault()}>
            <div className="space-y-2">
              <Label htmlFor="report-from">ตั้งแต่วันที่</Label>
              <Input
                id="report-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="report-to">ถึงวันที่</Label>
              <Input
                id="report-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="report-store">สาขา</Label>
              <select
                id="report-store"
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
          {!rangeValid && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              ช่วงวันที่ไม่ถูกต้อง วันที่สิ้นสุดต้องไม่อยู่ก่อนวันที่เริ่มต้น กรุณาแก้ไขช่วงวันที่
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">สรุปยอดขายที่ยืนยันแล้ว</CardTitle>
        </CardHeader>
        <CardContent>
          {report.isPending && rangeValid && (
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
              {REPORT_NO_SALES_MESSAGE}
            </p>
          )}
          {data && !isEmpty && (
            <dl className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1">
                <dt className="text-sm text-muted-foreground">จำนวนเอกสาร</dt>
                <dd className="text-2xl font-semibold">{data.documentCount}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-sm text-muted-foreground">จำนวนหน่วยที่ขาย</dt>
                <dd className="text-2xl font-semibold">{data.unitsSold}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-sm text-muted-foreground">ยอดขายรวม (บาท)</dt>
                <dd className="text-2xl font-semibold">{data.amount}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
