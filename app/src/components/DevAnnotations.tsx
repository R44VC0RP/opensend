import { Agentation } from 'agentation'

export default function DevAnnotations() {
  return <>
    <style>{`[data-agentation-root], [data-agentation-root] * { font-family: var(--font-body) !important; }`}</style>
    <Agentation endpoint="http://127.0.0.1:4747" />
  </>
}
