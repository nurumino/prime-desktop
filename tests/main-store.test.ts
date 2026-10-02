import { describe, expect, it } from 'vitest'
import { migrateState } from '../src/main/store'

describe('main state migration', () => {
  it('defaults previewFiles for older state files', () => {
    expect(migrateState({}).previewFiles).toEqual([])
    expect(migrateState({ previewFiles: 'nope' as never }).previewFiles).toEqual([])
  })

  it('keeps only unique absolute paths, capped at 50', () => {
    const many = Array.from({ length: 60 }, (_, index) => `/tmp/file-${index}.txt`)
    const migrated = migrateState({ previewFiles: ['/a.txt', 'relative.txt', 42 as never, '/a.txt', '', ...many] })
    expect(migrated.previewFiles[0]).toBe('/a.txt')
    expect(migrated.previewFiles).not.toContain('relative.txt')
    expect(migrated.previewFiles).toHaveLength(50)
    expect(new Set(migrated.previewFiles).size).toBe(50)
  })
})
