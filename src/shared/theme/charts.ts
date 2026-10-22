import type { ColorKey } from './registry'

// The chart keys the renderer's ChartView draws with, in one place for it and for the contrast pairs that hold them.

/** The categorical series colors in the order a chart hands them out: five hues from their own palette slots. */
export const chartCategorical = ['charts.blue', 'charts.orange', 'charts.green', 'charts.yellow', 'charts.purple'] as const satisfies readonly ColorKey[]
/** Every color a series may take: the categorical five, red for a series that counts failures, and gray for "Other". */
export const chartSeriesColors = [...chartCategorical, 'charts.red', 'charts.gray'] as const satisfies readonly ColorKey[]
export type ChartSeriesColor = typeof chartSeriesColors[number]
/** What a chart may sit on: a document, a card in the output panel's colors, or a widget. Its end markers are ringed in
 *  this color and its stacked bands are parted by it. */
export const chartSurfaces = ['editor.background', 'panel.background', 'editorWidget.background'] as const satisfies readonly ColorKey[]
export type ChartSurface = typeof chartSurfaces[number]
