import { createElement, lazy, type ComponentType } from 'react'

// A lazy component that renders at once when its code has already arrived. React.lazy always suspends
// on first render, and React holds a revealed fallback for at least 300 ms before showing the
// content, even when the chunk was fetched alongside /v1/me and is ready.
export function preloadable<Module, Props extends object>(load: () => Promise<Module>, pick: (module: Module) => ComponentType<Props>) {
  let loaded: ComponentType<Props> | undefined
  const preload = () => load().then(module => { loaded = pick(module); return module })
  const Lazy = lazy(() => preload().then(() => ({ default: loaded! })))
  const Component = (props: Props) => createElement(loaded ?? Lazy, props as never)
  return { Component, preload }
}
