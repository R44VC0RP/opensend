import { useState } from 'react'

export function useCursorPagination() {
  const [page, setPage] = useState(1)
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])

  function onPageChange(nextPage: number, nextCursor?: string | null) {
    if (nextPage === page + 1 && nextCursor) {
      setCursors(current => {
        const next = [...current]
        next[nextPage - 1] = nextCursor
        return next
      })
      setPage(nextPage)
    } else if (nextPage >= 1 && nextPage <= cursors.length) {
      setPage(nextPage)
    }
  }

  function reset() {
    setPage(1)
    setCursors([undefined])
  }

  function cursorForPage(nextPage: number, nextCursor?: string | null) {
    return nextPage === page + 1 ? nextCursor ?? undefined : cursors[nextPage - 1]
  }

  return { page, cursor: cursors[page - 1], cursorForPage, onPageChange, reset }
}
