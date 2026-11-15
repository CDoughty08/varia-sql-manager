// What a file name may hold on every platform, shared by main's sanitizeFileName (which makes any name safe) and the
// renderer's Save Results As names (which must know what main will keep, to tell two names apart).

/** C0 and C1 controls, line and paragraph separators, bidi marks, embeddings, overrides and isolates, the BOM, and the
 *  characters Windows forbids in file names (which also covers path separators). Each becomes `_`. */
export const unsafeFileNameChars = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\\/:*?"<>|]/g
/** ext4 and APFS allow 255 bytes per name; this leaves room for a suffix the Save dialog or the user adds. */
export const fileNameBytes = 240
