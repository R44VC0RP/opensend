import { useCallback, useLayoutEffect, useState } from 'react'

// The fitted page size of each list is remembered, so the next session can warm that exact first page.
const sizeKey = (scope: string) => `opensend.page-size.${scope}`
export function rememberedPageSize(scope: string) {
  try { const size = Number(localStorage.getItem(sizeKey(scope))); return Number.isInteger(size) && size > 0 ? size : null } catch { return null }
}
function rememberPageSize(scope: string, size: number) {
  try { localStorage.setItem(sizeKey(scope), String(size)) } catch { /* Warming then skips this list. */ }
}

export function useAdaptivePageSize(minimum = 5, maximum = 20, scope?: string) {
  // The remembered size makes the first render ask for the page that was warmed (or cached) for it.
  const [pageSize, setPageSize] = useState(() => (scope && rememberedPageSize(scope)) || minimum)
  const [measured, setMeasured] = useState(false)
  const [table, setTable] = useState<HTMLDivElement | null>(null)
  const tableRef = useCallback((node: HTMLDivElement | null) => setTable(node), [])

  useLayoutEffect(() => {
    if (!table) return
    const currentTable = table
    const surface = currentTable.closest<HTMLElement>('.page-surface')
    if (!surface) { setMeasured(true); return }
    const currentSurface = surface
    function measure() {
      const style = getComputedStyle(currentSurface)
      const tableStyle = getComputedStyle(currentTable)
      const rowHeight = parseFloat(tableStyle.getPropertyValue('--table-row-height')) || parseFloat(style.getPropertyValue('--row-height')) || 53
      const footerHeight = parseFloat(style.getPropertyValue('--row-height-lg')) || 64
      const contentBottom = currentSurface.getBoundingClientRect().bottom - parseFloat(style.paddingBottom)
      const availableBody = contentBottom - currentTable.getBoundingClientRect().top - 36 - footerHeight
      const size = Math.max(minimum, Math.min(maximum, Math.floor(availableBody / rowHeight)))
      setPageSize(size)
      setMeasured(true)
      if (scope) rememberPageSize(scope, size)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(currentSurface)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [maximum, minimum, scope, table])

  // Gate list queries on `measured` so mount requests the fitted page size once.
  return { pageSize, tableRef, measured }
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
