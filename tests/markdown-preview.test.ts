import { expect, it } from 'vitest'
import { parseMarkdownTable } from '../src/renderer/src/components/FilesPanel'

it('parses GitHub-style Markdown tables and stops before the next block', () => {
  const parsed = parseMarkdownTable([
    'Ranking',
    '| Rank | Criterion |',
    '| --- | --- |',
    '| 1 | Exact page wording |',
    '| 2 | Affinity |',
    '',
    'Hard rules:'
  ], 1)
  expect(parsed).toEqual({
    table: {
      headers: ['Rank', 'Criterion'],
      rows: [['1', 'Exact page wording'], ['2', 'Affinity']]
    },
    end: 5
  })
})
