/**
 * The complete lines of a log that another process appends to (the fake backend's calls.jsonl). A read can see an
 * append half done, when the line crosses a page of the file: the text after the last newline is a line still being
 * written, and parsing it throws. It is left for the next read, which a poll makes.
 */
export const completeLines = text => text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean)

/** The calls logged so far, one JSON object per complete line. */
export const parseCalls = text => completeLines(text).map(line => JSON.parse(line))
