import { EMPTY_LIST_MESSAGE, RETRY_MESSAGE } from '@erp/contracts';

/**
 * The shared loading / error / empty conventions every list screen reuses (TOR Section 6.2).
 * A list is in exactly one of four states: loading, error, empty, or showing rows.
 * The empty and error copy is actionable Thai so later screens don't redefine it.
 */
export function ListStates({
  isPending,
  isError,
  isEmpty,
}: {
  isPending: boolean;
  isError: boolean;
  isEmpty: boolean;
}) {
  if (isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        กำลังโหลด…
      </p>
    );
  }
  if (isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {RETRY_MESSAGE}
      </p>
    );
  }
  if (isEmpty) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {EMPTY_LIST_MESSAGE}
      </p>
    );
  }
  return null;
}
