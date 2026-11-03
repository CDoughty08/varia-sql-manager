// A suite after a merge that kept both sections' helper: node refuses to load it.
try {
  const row = index => index + 1
  console.log(row(0))
  const row = dialog => dialog
  console.log(row(1))
} finally {
  console.log('done')
}
