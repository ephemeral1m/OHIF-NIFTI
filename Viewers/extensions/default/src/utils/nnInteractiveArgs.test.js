import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import CommandsManager from '../../../../platform/core/src/classes/CommandsManager';
import { normalizeNnInteractiveArgs } from './nnInteractiveArgs';

jest.mock('../../../../platform/core/src/log.js', () => ({
  __esModule: true, default: { warn: jest.fn() },
}));

describe('nnInteractive command arguments', () => {
  test.each([undefined, null, {}, { viewportId: 'viewport-1' }, [], ['', '  '], '', '  ', { textPrompts: [] }])(
    'does not treat non-text arguments %p as VoxTell input', input => {
      expect(normalizeNnInteractiveArgs(input).textPrompts).toBeUndefined();
    }
  );

  test.each([' liver ', ['liver', '', ' kidney '], { textPrompts: 'liver' }, { textPrompts: [' liver '] }])(
    'recognizes explicit text %p so v1 still rejects VoxTell', input => {
      expect(normalizeNnInteractiveArgs(input).textPrompts).toContain('liver');
    }
  );

  test('retains explicit mode and legacy direct-call options', () => {
    expect(normalizeNnInteractiveArgs({ mode: 'append' }).options.mode).toBe('append');
    expect(normalizeNnInteractiveArgs('liver', { mode: 'replace-active' }).options.mode).toBe('replace-active');
  });

  // Execute the production action through the real CommandsManager without
  // importing the whole WebGL/Cornerstone viewer. Stop at the tool-lock boundary:
  // a point invocation must reach this boundary instead of showing the text warning.
  function productionActionHarness() {
    const filename = path.join(__dirname, '../commandsModule.ts');
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let method;
    function visit(node) {
      if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'nninter') method = node;
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (!method) throw new Error('Production nninter action was not found');
    const printed = ts.createPrinter().printNode(ts.EmitHint.Unspecified, method, source);
    const js = ts.transpileModule(`const action = ({ ${printed} }).nninter;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const notification = { show: jest.fn() };
    const toolbox = { getLocked: jest.fn(() => true) };
    const action = new Function('normalizeNnInteractiveArgs', 'uiNotificationService', 'toolboxState', `${js}\nreturn action;`)(
      normalizeNnInteractiveArgs, notification, toolbox
    );
    const manager = new CommandsManager();
    manager.createContext('DEFAULT');
    manager.registerCommand('DEFAULT', 'nninter', action);
    manager.registerCommand('DEFAULT', 'runAiSegmentation', () => manager.run('nninter'));
    return { manager, action, notification, toolbox };
  }

  test.each(['nninter', 'runAiSegmentation'])('real %s dispatch does not warn about text segmentation', async command => {
    const { manager, notification, toolbox } = productionActionHarness();
    await manager.run(command);
    expect(notification.show).not.toHaveBeenCalled();
    expect(toolbox.getLocked).toHaveBeenCalledTimes(1);
  });

  test('real dispatch with viewport options remains a point request', async () => {
    const { manager, notification, toolbox } = productionActionHarness();
    await manager.run('nninter', { viewportId: 'viewport-1' });
    expect(notification.show).not.toHaveBeenCalled();
    expect(toolbox.getLocked).toHaveBeenCalledTimes(1);
  });

  test('explicit text through command dispatch is still blocked before touching a mask', async () => {
    const { manager, notification, toolbox } = productionActionHarness();
    await manager.run('nninter', { textPrompts: 'liver' });
    expect(notification.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'VoxTell' }));
    expect(toolbox.getLocked).not.toHaveBeenCalled();
  });

  test('legacy direct text call is still blocked', async () => {
    const { action, notification } = productionActionHarness();
    await action('liver', { mode: 'append' });
    expect(notification.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'VoxTell' }));
  });
});
