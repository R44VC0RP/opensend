// New organization form: fills the email domain from the name (lowercase, hyphens) until it's edited.
(() => {
  const slug = document.querySelector('[data-slug-from]')
  if (!slug) return
  const name = document.getElementById(slug.dataset.slugFrom)
  const preview = document.querySelector('[data-slug-preview]')
  // Same rule as slugify() in src/web.ts.
  const slugify = value => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '')
  let edited = slug.hasAttribute('data-edited') || (slug.value !== '' && slug.value !== slugify(name.value))
  const show = () => { if (preview) preview.textContent = slug.value || 'acme' }
  name.addEventListener('input', () => { if (!edited) { slug.value = slugify(name.value); show() } })
  slug.addEventListener('input', () => {
    const cleaned = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (cleaned !== slug.value) slug.value = cleaned
    edited = slug.value !== '' && slug.value !== slugify(name.value)
    show()
  })
})()
