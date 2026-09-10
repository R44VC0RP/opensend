import { useCallback, useLayoutEffect, useState } from 'react'

export function useAdaptivePageSize(minimum = 5, maximum = 20) {
  const [pageSize, setPageSize] = useState(minimum)
  const [table, setTable] = useState<HTMLDivElement | null>(null)
  const tableRef = useCallback((node: HTMLDivElement | null) => setTable(node), [])

  useLayoutEffect(() => {
    if (!table) return
    const currentTable = table
    const surface = currentTable.closest<HTMLElement>('.page-surface')
    if (!surface) return
    const currentSurface = surface
    function measure() {
      const style = getComputedStyle(currentSurface)
      const rowHeight = parseFloat(style.getPropertyValue('--row-height')) || 53
      const footerHeight = parseFloat(style.getPropertyValue('--row-height-lg')) || 64
      const contentBottom = currentSurface.getBoundingClientRect().bottom - parseFloat(style.paddingBottom)
      const availableBody = contentBottom - currentTable.getBoundingClientRect().top - 36 - footerHeight
      setPageSize(Math.max(minimum, Math.min(maximum, Math.floor(availableBody / rowHeight))))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(currentSurface)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [maximum, minimum, table])

  return { pageSize, tableRef }
}

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
