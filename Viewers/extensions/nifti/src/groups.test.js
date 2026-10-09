import { groupFindingName } from './groups';

const group = { name: 'finding_0 · 原始标注', masks: [{ saved: { maskId: 'mask-a' } }] };
test('group title resolves finding text by mask identity, not finding order or filename', () => {
  expect(groupFindingName(group, { findings: [
    { text: 'Wrong finding', maskIds: ['mask-b'] },
    { text: 'Ground glass opacity', maskIds: ['mask-a'] },
  ] })).toBe('Ground glass opacity');
});
test('missing manifest, unmatched and blank findings retain the stored group name', () => {
  expect(groupFindingName(group)).toBe(group.name);
  expect(groupFindingName(group, { findings: [{ text: ' ', maskIds: ['mask-a'] }] })).toBe(group.name);
  expect(groupFindingName(group, { findings: [{ text: 'Other', maskIds: ['mask-b'] }] })).toBe(group.name);
});
test('multiple linked findings are retained and explicit names take precedence', () => {
  expect(groupFindingName(group, { findings: [
    { name: 'Lesion A', text: 'Long description', maskIds: ['mask-a'] },
    { text: 'Finding B', maskIds: ['mask-a'] },
  ] })).toBe('Lesion A / Finding B');
});
