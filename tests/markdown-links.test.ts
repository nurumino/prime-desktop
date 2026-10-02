import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Markdown, markdownLinkTarget } from '../src/renderer/src/components/MessageItem'

it('renders file links in lists and tables without exposing Markdown syntax', () => {
  const html = renderToStaticMarkup(createElement(Markdown, {
    text: '- [Design review](egfr_verified_20260930_141015/design_review.md)\n\n| File |\n| --- |\n| [Report](<reports/my report.md>) |',
    onOpenFile: () => {}
  }))
  expect(html).toContain('title="egfr_verified_20260930_141015/design_review.md"')
  expect(html).toContain('>Design review</a>')
  expect(html).toContain('title="reports/my report.md"')
  expect(html).not.toContain('[Design review]')
})

it('routes relative and absolute paths to previews and rejects unsafe schemes', () => {
  expect(markdownLinkTarget('reports/design.md')).toEqual({ type: 'file', path: 'reports/design.md' })
  expect(markdownLinkTarget('file:///project/report%20one.pdf')).toEqual({ type: 'file', path: '/project/report one.pdf' })
  expect(markdownLinkTarget('https://example.com/report')).toEqual({ type: 'web', path: 'https://example.com/report' })
  for (const value of ['javascript:alert(1)', 'data:text/html,bad', '//example.com', '#section', '%ZZ']) {
    expect(markdownLinkTarget(value)).toBeNull()
  }
})
