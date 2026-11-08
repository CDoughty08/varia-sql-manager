/** Threaded tidy-tree contours. Each contour is traversed a bounded number of times,
 * so a deep or wide SQL plan stays linear without reserving whole subtree rectangles. */
export function tidyCenters(children: readonly number[][], roots: readonly number[], order: readonly number[], step: number): number[] {
  interface Vertex { children: Vertex[]; parent: Vertex; i: number; z: number; m: number; c: number; s: number; a: Vertex; A?: Vertex; t?: Vertex }
  const make = (i: number): Vertex => { const v = { children: [], i, z: 0, m: 0, c: 0, s: 0 } as unknown as Vertex; v.a = v; return v }
  const vertices = children.map((_, i) => make(i)), root = make(-1)
  root.children = roots.map(i => vertices[i])
  for (const v of root.children) v.parent = root
  children.forEach((inputs, i) => { vertices[i].children = inputs.map((child, at) => { const v = vertices[child]; v.parent = vertices[i]; v.i = at; return v }) })
  root.children.forEach((v, i) => { v.i = i })
  const left = (v: Vertex) => v.children[0] ?? v.t
  const right = (v: Vertex) => v.children.at(-1) ?? v.t
  const post: Vertex[] = [], stack = [...root.children]
  while (stack.length) { const v = stack.pop()!; post.push(v); for (const child of v.children) stack.push(child) }
  for (let at = post.length - 1; at >= 0; at--) {
    const v = post[at], siblings = v.parent.children, w = siblings[v.i - 1]
    if (v.children.length) {
      let shift = 0, change = 0
      for (let i = v.children.length - 1; i >= 0; i--) { const c = v.children[i]; c.z += shift; c.m += shift; shift += c.s + (change += c.c) }
      const midpoint = (v.children[0].z + v.children.at(-1)!.z) / 2
      v.z = w ? w.z + step : midpoint
      v.m = v.z - midpoint
    } else if (w) v.z = w.z + step
    let ancestor = v.parent.A ?? siblings[0]
    if (w) {
      let vim = w, vip = v, vom = siblings[0], vop = v
      let sim = vim.m, sip = vip.m, som = vom.m, sop = vop.m
      let nextM = right(vim), nextP = left(vip)
      while (nextM && nextP) {
        vim = nextM; vip = nextP; vom = left(vom)!; vop = right(vop)!; vop.a = v
        const shift = vim.z + sim - vip.z - sip + step
        if (shift > 0) {
          const before = vim.a.parent === v.parent ? vim.a : ancestor, change = shift / (v.i - before.i)
          v.c -= change; v.s += shift; before.c += change; v.z += shift; v.m += shift; sip += shift; sop += shift
        }
        sim += vim.m; sip += vip.m; som += vom.m; sop += vop.m
        nextM = right(vim); nextP = left(vip)
      }
      if (nextM && !right(vop)) { vop.t = nextM; vop.m += sim - sop }
      if (nextP && !left(vom)) { vom.t = nextP; vom.m += sip - som; ancestor = v }
    }
    v.parent.A = ancestor
  }
  let shift = 0, change = 0
  for (let i = root.children.length - 1; i >= 0; i--) { const c = root.children[i]; c.z += shift; c.m += shift; shift += c.s + (change += c.c) }
  const centers = new Array<number>(children.length)
  for (const index of order) { const v = vertices[index]; centers[index] = v.z + v.parent.m; v.m += v.parent.m }
  const minimum = centers.reduce((a, b) => Math.min(a, b), 0)
  return centers.map(center => center - minimum)
}
