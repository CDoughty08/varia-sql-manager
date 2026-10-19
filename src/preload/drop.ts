/** Files dropped at once; main refuses more. */
export const maxDroppedFiles = 32

/** What a drop listener needs of a drag event: its trust, its data and the calls that stop it. */
export interface FileDragEvent {
  readonly isTrusted: boolean
  readonly dataTransfer: { readonly types: readonly string[]; readonly files: ArrayLike<File>; dropEffect: string } | null
  preventDefault(): void
  stopImmediatePropagation(): void
}
export interface FileDropTarget { addEventListener(type: 'dragenter' | 'dragover' | 'dragleave' | 'drop', listener: (event: FileDragEvent) => void, options: { capture: true }): void }
export interface FileDropOptions {
  /** Electron's webUtils.getPathForFile: the dropped file's path, or '' for a file that has none (made by script). */
  pathForFile(file: File): string
  /** Hands the paths to main (varia:files-dropped), which reads them as it reads a command line's files. */
  send(paths: string[]): void
}

/**
 * Opens files dropped on the window, from the preload's isolated world. Only a trusted drag that carries files is
 * touched: page script can neither make a trusted event nor reach `pathForFile` or the channel, so it can never name a
 * path. Such a drag stops here, before Monaco or the page see any of it: the drop would insert the path or navigate, and
 * Monaco's drop caret, started on dragenter and dragover, would stay in the query, since it ends only on a drop or
 * dragleave that reaches it. Every other drag, Object Explorer's and the panels' included, goes on as before. Listeners
 * run in the capture phase on the window, registered before any page script, so they come first.
 */
export function installFileDrop(target: FileDropTarget, options: FileDropOptions): void {
  const carriesFiles = (event: FileDragEvent) => event.isTrusted && !!event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')
  for (const type of ['dragenter', 'dragover', 'dragleave'] as const) {
    target.addEventListener(type, event => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.dataTransfer!.dropEffect = 'copy'
      event.stopImmediatePropagation()
    }, { capture: true })
  }
  target.addEventListener('drop', event => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const paths: string[] = []
    for (const file of Array.from(event.dataTransfer!.files)) {
      if (paths.length === maxDroppedFiles) break
      const path = options.pathForFile(file)
      if (path) paths.push(path)
    }
    if (paths.length) options.send(paths)
  }, { capture: true })
}
