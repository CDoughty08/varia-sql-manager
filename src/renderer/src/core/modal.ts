/** A modal dialog owns the keyboard and the workbench behind it: keys, menus, and the palette do not act while one is open. */
export const modalOpen = (): boolean => typeof document !== 'undefined' && !!document.querySelector('[aria-modal="true"]')
