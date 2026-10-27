import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Supplier } from '@erp/contracts';
import { ListStates } from '@/components/list-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCurrentUser } from '@/lib/auth';
import { apiErrorMessage } from '@/lib/errors';
import { orpc } from '@/lib/orpc';

function SupplierForm({ editing, onDone }: { editing: Supplier | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState(editing?.code ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [contactName, setContactName] = useState(editing?.contactName ?? '');
  const [contactEmail, setContactEmail] = useState(editing?.contactEmail ?? '');
  const [contactPhone, setContactPhone] = useState(editing?.contactPhone ?? '');

  const invalidate = () => queryClient.invalidateQueries({ queryKey: orpc.supplier.list.key() });
  const reset = () => {
    setCode('');
    setName('');
    setContactName('');
    setContactEmail('');
    setContactPhone('');
    onDone();
  };

  const create = useMutation(
    orpc.supplier.create.mutationOptions({ onSuccess: () => invalidate().then(reset) }),
  );
  const update = useMutation(
    orpc.supplier.update.mutationOptions({ onSuccess: () => invalidate().then(reset) }),
  );
  const mutation = editing ? update : create;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          {editing ? 'แก้ไขผู้จัดจำหน่าย' : 'เพิ่มผู้จัดจำหน่าย'}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const payload = { code, name, contactName, contactEmail, contactPhone };
            if (editing) update.mutate({ id: editing.id, ...payload });
            else create.mutate(payload);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="supplier-code">รหัสผู้จัดจำหน่าย</Label>
            <Input
              id="supplier-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="supplier-name">ชื่อผู้จัดจำหน่าย</Label>
            <Input
              id="supplier-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="supplier-contact-name">ชื่อผู้ติดต่อ</Label>
            <Input
              id="supplier-contact-name"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="supplier-contact-email">อีเมลผู้ติดต่อ</Label>
            <Input
              id="supplier-contact-email"
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="supplier-contact-phone">โทรศัพท์ผู้ติดต่อ</Label>
            <Input
              id="supplier-contact-phone"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
            />
          </div>
          <div className="flex items-end gap-2">
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

export function SuppliersPage() {
  const user = useCurrentUser();
  const isAdmin = user?.role === 'ADMIN';
  const [editing, setEditing] = useState<Supplier | null>(null);
  const suppliers = useQuery(orpc.supplier.list.queryOptions({ input: { page: 1, pageSize: 20 } }));
  const items = suppliers.data?.items ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">ผู้จัดจำหน่าย</h1>

      {isAdmin && (
        <SupplierForm
          key={editing?.id ?? 'new'}
          editing={editing}
          onDone={() => setEditing(null)}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">รายการผู้จัดจำหน่าย</CardTitle>
        </CardHeader>
        <CardContent>
          <ListStates
            isPending={suppliers.isPending}
            isError={suppliers.isError}
            isEmpty={items.length === 0}
          />
          {items.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2">รหัส</th>
                  <th className="py-2">ชื่อ</th>
                  <th className="py-2">ผู้ติดต่อ</th>
                  {isAdmin && <th className="py-2" />}
                </tr>
              </thead>
              <tbody>
                {items.map((supplier) => (
                  <tr key={supplier.id} className="border-t">
                    <td className="py-2">{supplier.code}</td>
                    <td className="py-2">{supplier.name}</td>
                    <td className="py-2">{supplier.contactName ?? '—'}</td>
                    {isAdmin && (
                      <td className="py-2 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(supplier)}
                          aria-label={`แก้ไข ${supplier.code}`}
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
