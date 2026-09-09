import type { CSSProperties, ReactNode } from 'react'

export function Skeleton({ width = '100%', height = 12, className = '' }: { width?: CSSProperties['width']; height?: CSSProperties['height']; className?: string }) {
  return <span aria-hidden="true" className={`ui-skeleton-block ${className}`} style={{ width, height }} />
}
export function SkeletonText({ width = '70%', lineHeight = 20 }: { width?: CSSProperties['width']; lineHeight?: number }) {
  return <span aria-hidden="true" className="ui-skeleton-line" style={{ minHeight: lineHeight, height: lineHeight, width: typeof width === 'number' ? width : undefined }}><Skeleton width={typeof width === 'number' ? '100%' : width} /></span>
}
export function ControlSkeleton({ width = '100%' }: { width?: CSSProperties['width'] }) {
  return <div aria-hidden="true" className="ui-control-skeleton" style={{ width }}><Skeleton width="60%" /></div>
}
export function FieldSkeleton({ label, width, multiline = false }: { label?: ReactNode; width?: CSSProperties['width']; multiline?: boolean }) {
  return <div className="ui-field" aria-hidden="true" style={{ width }}>{label ? <span className="ui-field__label">{label}</span> : <SkeletonText width={96} lineHeight={18} />}{multiline ? <Skeleton height={160} /> : <ControlSkeleton />}</div>
}
export function LoadingRegion({ children, label = 'Loading content', className = '' }: { children: ReactNode; label?: string; className?: string }) {
  return <div className={`ui-loading-layout ${className}`} aria-busy="true"><span role="status" className="sr-only">{label}</span>{children}</div>
}
export function PaginationSkeleton() {
  return <div className="ui-pagination" aria-hidden="true"><Skeleton width={125} /><div className="cluster"><ControlSkeleton width={34} /><Skeleton width={42} /><ControlSkeleton width={34} /></div></div>
}
