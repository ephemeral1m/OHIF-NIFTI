import ToolbarService from './ToolbarService';

it('replaces a format-specific tool section without retaining DICOM actions', () => {
  const service = new ToolbarService({}, {}, {});
  service.createButtonSection('ai', ['point', 'saveToPACS', 'saveDicomDraft']);
  service.setButtonSection('ai', ['point', 'nativeAI', 'point']);
  expect(service.state.buttonSections.ai).toEqual(['point', 'nativeAI']);
  service.setButtonSection('ai', []);
  expect(service.state.buttonSections.ai).toEqual([]);
});

it('resolves nested evaluators before the first fast local image refresh', () => {
  const service = new ToolbarService({}, {}, {});
  const evaluate = jest.fn(() => ({ disabled: true, disabledText: 'Not available' }));
  service.registerEvaluateFunction('evaluate.local', evaluate);
  // Parent precedes its child, as in the OHIF measurement/AI tool sections.
  service.state.buttons = {
    parent: { id: 'parent', props: { buttonSection: 'children' } },
    child: { id: 'child', props: { evaluate: 'evaluate.local' } },
  };
  service.state.buttonSections = { children: ['child'] };
  expect(() => service.refreshToolbarState({ viewportId: 'local' })).not.toThrow();
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(service.state.buttons.child.props.disabled).toBe(true);
});
