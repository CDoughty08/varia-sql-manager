let scrollbar: number | undefined
/** The platform's scroll bar thickness (classic scroll bars take room; overlay ones take none). */
export function scrollbarSize(): number {
  if (scrollbar !== undefined) return scrollbar
  const probe = document.createElement('div')
  probe.style.cssText = 'position:absolute;top:-1000px;width:100px;height:100px;overflow:scroll'
  document.body.append(probe)
  scrollbar = probe.offsetHeight - probe.clientHeight
  probe.remove()
  return scrollbar
}
