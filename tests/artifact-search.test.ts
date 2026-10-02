import { expect, it } from 'vitest'
import { matchesArtifactSearch } from '../src/renderer/src/components/FilesPanel'

it('finds files by path, type, and source without hiding them for an empty search', () => {
  const file = { path: '/results/Protein_1.pdb', kind: 'structure' as const, status: 'added' as const, source: 'uploaded' as const, diff: '' }
  expect(matchesArtifactSearch(file, '')).toBe(true)
  expect(matchesArtifactSearch(file, 'protein')).toBe(true)
  expect(matchesArtifactSearch(file, 'structure')).toBe(true)
  expect(matchesArtifactSearch(file, 'uploaded')).toBe(true)
  expect(matchesArtifactSearch(file, 'report')).toBe(false)
})
