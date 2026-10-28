import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/lib/query-client';
import { mockApi } from '@/test/mock-api';
import { ReportsPage } from './reports';

const manager = {
  id: '3',
  email: 'manager01@erp.local',
  name: 'Manager One',
  role: 'MANAGER',
};

function renderPage() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ReportsPage />
    </QueryClientProvider>,
  );
}

function list(items: unknown[]) {
  return { items, total: items.length, page: 1, pageSize: 20 };
}

const stores = list([
  { id: 's1', code: 'B01', name: 'Central' },
  { id: 's2', code: 'B02', name: 'Riverside' },
]);

function reference(extra: Record<string, unknown> = {}) {
  return {
    'GET /auth/me': { user: manager },
    'GET /stores': stores,
    ...extra,
  };
}

const populatedReport = {
  from: '2026-01-15',
  to: '2026-01-15',
  storeId: 's1',
  documentCount: 3,
  unitsSold: 9,
  amount: '455.00',
};

const emptyReport = {
  from: '2026-02-01',
  to: '2026-02-01',
  storeId: 's2',
  documentCount: 0,
  unitsSold: 0,
  amount: '0.00',
};

describe('ReportsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the daily sales figures once the report resolves', async () => {
    mockApi(reference({ 'GET /reports/daily-sales': populatedReport }));

    renderPage();

    // Document count, units sold and total amount are all surfaced.
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('455.00')).toBeInTheDocument();
  });

  it('shows a clear Thai empty-state message and explicit zero totals when nothing matches (AC-08 sales-zero half)', async () => {
    mockApi(reference({ 'GET /reports/daily-sales': emptyReport }));

    renderPage();

    // The empty-state message and the explicit zero figures are shown together (user story 52).
    expect(
      await screen.findByText('ไม่มียอดขายที่ยืนยันแล้วในช่วงวันที่และสาขาที่เลือก'),
    ).toBeInTheDocument();
    expect(screen.getByText('จำนวนเอกสาร')).toBeInTheDocument();
    expect(screen.getByText('0.00')).toBeInTheDocument();
    // Both the document count and the units sold read zero.
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(2);
  });

  it('sends the chosen date range and store to the report endpoint', async () => {
    const fetch = mockApi(reference({ 'GET /reports/daily-sales': emptyReport }));

    renderPage();

    // Set a range and a store, then run the report.
    fireEvent.change(await screen.findByLabelText('ตั้งแต่วันที่'), {
      target: { value: '2026-01-15' },
    });
    fireEvent.change(screen.getByLabelText('ถึงวันที่'), { target: { value: '2026-01-15' } });
    fireEvent.change(screen.getByLabelText('สาขา'), { target: { value: 's1' } });

    await waitFor(() => {
      const calls = fetch.mock.calls.filter(
        ([r]) => new URL(r.url).pathname === '/api/reports/daily-sales',
      );
      expect(calls.length).toBeGreaterThan(0);
      // The latest report request reflects the chosen range and store.
      const url = new URL(calls[calls.length - 1]![0].url);
      expect(url.searchParams.get('from')).toBe('2026-01-15');
      expect(url.searchParams.get('to')).toBe('2026-01-15');
      expect(url.searchParams.get('storeId')).toBe('s1');
    });
  });

  it('exports the daily sales report to CSV with the current filters and triggers a download (RPT-04)', async () => {
    const fetch = mockApi(
      reference({
        'GET /reports/daily-sales': populatedReport,
        'GET /reports/daily-sales/csv': {
          filename: 'daily-sales-2026-01-15_2026-01-15.csv',
          content: '\uFEFFx\r\n1\r\n',
        },
      }),
    );
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    renderPage();

    fireEvent.change(await screen.findByLabelText('ตั้งแต่วันที่'), {
      target: { value: '2026-01-15' },
    });
    fireEvent.change(screen.getByLabelText('ถึงวันที่'), { target: { value: '2026-01-15' } });
    fireEvent.change(screen.getByLabelText('สาขา'), { target: { value: 's1' } });
    fireEvent.click(screen.getByRole('button', { name: 'ส่งออก CSV' }));

    await waitFor(() => {
      const calls = fetch.mock.calls.filter(
        ([r]) => new URL(r.url).pathname === '/api/reports/daily-sales/csv',
      );
      expect(calls.length).toBeGreaterThan(0);
      const url = new URL(calls[calls.length - 1]![0].url);
      expect(url.searchParams.get('from')).toBe('2026-01-15');
      expect(url.searchParams.get('to')).toBe('2026-01-15');
      expect(url.searchParams.get('storeId')).toBe('s1');
    });
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(createObjectURL).toHaveBeenCalled();
  });
});
