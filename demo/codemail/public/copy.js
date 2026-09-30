// Copy buttons: <button data-copy="#target"> copies the target's text and confirms briefly.
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-copy]')
  if (!button) return
  const target = document.querySelector(button.dataset.copy)
  if (!target) return
  const label = button.dataset.label ?? button.textContent
  button.dataset.label = label
  try { await navigator.clipboard.writeText(target.innerText.trim()); button.textContent = 'Copied' }
  catch { const range = document.createRange(); range.selectNodeContents(target); getSelection().removeAllRanges(); getSelection().addRange(range); button.textContent = 'Press ⌘C to copy' }
  setTimeout(() => { button.textContent = label }, 1600)
})
