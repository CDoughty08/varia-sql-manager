import type { SettingsValues } from '../../../shared/settings/catalog'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { SettingsService } from '../settings/SettingsService'

/**
 * The query editor's options from Tools › Options; `wordWrap`, `whitespace` and `lineNumbers` also feed the editorWordWrap,
 * editorWhitespace and editorLineNumbers context keys.
 */
export interface EditorOptions {
  readonly wordWrap: boolean
  readonly lineNumbers: boolean
  /** Edit › Advanced › View White Space. */
  readonly whitespace: boolean
  readonly fontSize: number
  readonly dragAndDrop: boolean
  readonly highlightCurrentLine: boolean
}
/** The Monaco editor options they map to. Bracket matching is DocumentService's: it also depends on the document. */
export interface MonacoEditorOptions {
  readonly wordWrap: 'on' | 'off'
  readonly lineNumbers: 'on' | 'off'
  /** SSMS shows none unless View White Space is on (Monaco's default is 'selection'). */
  readonly renderWhitespace: 'all' | 'none'
  readonly fontSize: number
  readonly dragAndDrop: boolean
  readonly renderLineHighlight: 'line' | 'none'
}
interface OptionsTarget { updateOptions(options: MonacoEditorOptions): void }

const fromSettings = (values: SettingsValues): EditorOptions => ({
  wordWrap: values['textEditor.sql.wordWrap'],
  lineNumbers: values['textEditor.sql.lineNumbers'],
  whitespace: values['textEditor.sql.viewWhiteSpace'],
  fontSize: values['environment.fonts.editorFontSize'],
  dragAndDrop: values['textEditor.dragAndDrop'],
  highlightCurrentLine: values['textEditor.highlightCurrentLine']
})
const same = (a: EditorOptions, b: EditorOptions) => (Object.keys(a) as (keyof EditorOptions)[]).every(key => a[key] === b[key])

/** The query editor's options, backed by settings: commands toggle them there, and every change reaches bound editors. */
export class EditorOptionsService extends SnapshotStore<EditorOptions> implements Disposable {
  private readonly unsubscribe: () => void
  constructor(private readonly settings: SettingsService) {
    super(fromSettings(settings.getSnapshot().values))
    this.unsubscribe = settings.subscribe(() => {
      const next = fromSettings(settings.getSnapshot().values)
      if (!same(next, this.getSnapshot())) this.publish(next)
    })
  }
  // The toggles are saved, or apply for this session when the save fails; they never throw.
  /** Edit › Advanced › Word Wrap (Alt+Z). */
  toggleWordWrap(): Promise<void> { return this.settings.toggle('textEditor.sql.wordWrap') }
  /** Edit › Advanced › View White Space. */
  toggleWhitespace(): Promise<void> { return this.settings.toggle('textEditor.sql.viewWhiteSpace') }
  /** The palette's Toggle Line Numbers; Options has the same setting. */
  toggleLineNumbers(): Promise<void> { return this.settings.toggle('textEditor.sql.lineNumbers') }
  /** What a new editor is created with, so its first frame is already right. */
  monacoOptions(): MonacoEditorOptions {
    const options = this.getSnapshot()
    return {
      wordWrap: options.wordWrap ? 'on' : 'off',
      lineNumbers: options.lineNumbers ? 'on' : 'off',
      renderWhitespace: options.whitespace ? 'all' : 'none',
      fontSize: options.fontSize,
      dragAndDrop: options.dragAndDrop,
      renderLineHighlight: options.highlightCurrentLine ? 'line' : 'none'
    }
  }
  /** Applies the options to an editor now and after every change. */
  bindEditor(editor: OptionsTarget): Disposable {
    const apply = () => editor.updateOptions(this.monacoOptions())
    apply()
    const unsubscribe = this.subscribe(apply)
    return { dispose: unsubscribe }
  }
  dispose(): void {
    this.unsubscribe()
    this.clearListeners()
  }
}
