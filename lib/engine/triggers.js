module.exports = [
  {
    triggers: ['$save'],
    bpi: '⟦cmd¦run=git status --short¦run=git --no-pager diff --staged¦run=git --no-pager diff⟧',
  },
]
