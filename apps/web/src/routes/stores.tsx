import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Store } from '@erp/contracts';
import { ListStates } from '@/components/list-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCurrentUser } from '@/lib/auth';
import { apiErrorMessage } from '@/lib/errors';
import { orpc } from '@/lib/orpc';

function StoreForm({ editing, onDone }: { editing: Store | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState(editing?.code ?? '');
  const [name, setName] = useState(editing?.name ?? '');

  const invalidate = () => queryClient.invalidateQueries({ queryKey: orpc.store.list.key() });
  const reset = () => {
    setCode('');
    setName('');
    onDone();
  };

  const create = useMutation(
    orpc.store.create.mutationOptions({ onSuccess: () => invalidate().then(reset) }),
  );
  const update = useMutation(
    orpc.store.update.mutationOptions({ onSuccess: () => invalidate().then(reset) }),
  );
  const mutation = editing ? update : create;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{editing ? 'แก้ไขสาขา' : 'เพิ่มสาขา'}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (editing) update.mutate({ id: editing.id, code, name });
            else create.mutate({ code, name });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="store-code">รหัสสาขา</Label>
            <Input
              id="store-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="store-name">ชื่อสาขา</Label>
            <Input
              id="store-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'กำลังบันทึก…' : 'บันทึก'}
          </Button>
          {editing && (
            <Button type="button" variant="ghost" onClick={reset}>
              ยกเลิก
            </Button>
          )}
          {mutation.error && (
            <p role="alert" className="w-full text-sm text-destructive">
              {apiErrorMessage(mutation.error)}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export function StoresPage() {
  const user = useCurrentUser();
  const isAdmin = user?.role === 'ADMIN';
  const [editing, setEditing] = useState<Store | null>(null);
  const stores = useQuery(orpc.store.list.queryOptions({ input: { page: 1, pageSize: 20 } }));
  const items = stores.data?.items ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">สาขา</h1>

      {isAdmin && (
        <StoreForm key={editing?.id ?? 'new'} editing={editing} onDone={() => setEditing(null)} />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">รายการสาขา</CardTitle>
        </CardHeader>
        <CardContent>
          <ListStates
            isPending={stores.isPending}
            isError={stores.isError}
            isEmpty={items.length === 0}
          />
          {items.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2">รหัส</th>
                  <th className="py-2">ชื่อ</th>
                  {isAdmin && <th className="py-2" />}
                </tr>
              </thead>
              <tbody>
                {items.map((store) => (
                  <tr key={store.id} className="border-t">
                    <td className="py-2">{store.code}</td>
                    <td className="py-2">{store.name}</td>
                    {isAdmin && (
                      <td className="py-2 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(store)}
                          aria-label={`แก้ไข ${store.code}`}
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
