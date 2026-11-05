import { createElement, lazy, type ComponentType } from 'react'

// A route chunk whose pages render at once when its code has already arrived. React.lazy always
// suspends on first render, and React holds a revealed fallback for at least 300 ms, even when the
// chunk was preloaded and the data is cached.
export function chunk<Module>(load: () => Promise<Module>) {
  let loaded: Module | undefined
  let pending: Promise<Module> | undefined
  const preload = () => pending ??= load().then(module => { loaded = module; return module }, error => { pending = undefined; throw error })
  const page = <Props extends object>(pick: (module: Module) => ComponentType<Props>) => {
    const Lazy = lazy(() => preload().then(module => ({ default: pick(module) })))
    return (props: Props) => createElement(loaded ? pick(loaded) : Lazy, props as never)
  }
  return { preload, page }
}
