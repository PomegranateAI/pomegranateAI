import { useCallback, useState } from 'react';

/**
 * Newest-first paging over an id cursor: page N is "rows older than the last
 * id on page N-1". Keeps a stack of cursors so Previous is exact even when
 * new rows arrive while someone is paging.
 */
export function useCursorPages() {
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const page = cursors.length - 1;
  return {
    page,
    before: cursors[page],
    next: (lastId: number) => setCursors((c) => [...c, lastId]),
    prev: () => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c)),
    reset: useCallback(() => setCursors([undefined]), []),
  };
}

/** "26–50 of 340" with Previous / Next. */
export function Pager({
  page,
  pageSize,
  shown,
  total,
  onPrev,
  onNext,
}: {
  page: number;
  pageSize: number;
  shown: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (total <= pageSize && page === 0) return null;
  const from = page * pageSize + (shown > 0 ? 1 : 0);
  const to = page * pageSize + shown;
  const hasNext = shown === pageSize && to < total;
  return (
    <div className="flex items-center justify-between gap-3 pt-4 text-xs text-muted-foreground">
      <span>
        {from}–{to} of {total}
      </span>
      <div className="flex gap-2">
        <button type="button" className="pome-btn-ghost" onClick={onPrev} disabled={page === 0}>
          Previous
        </button>
        <button type="button" className="pome-btn-ghost" onClick={onNext} disabled={!hasNext}>
          Next
        </button>
      </div>
    </div>
  );
}
