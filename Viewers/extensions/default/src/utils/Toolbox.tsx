import React, { useState, useEffect, useRef } from 'react';
import { Icons, PanelSection, ToolSettings, Switch, Label, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Button, Input } from '@ohif/ui-next';
import { Lock, LockOpen } from 'lucide-react';
import { useSystem, useToolbar } from '@ohif/core';
import classnames from 'classnames';
import { useTranslation } from 'react-i18next';
import { toolboxState } from '../stores/toolboxState';

interface ButtonProps {
  isActive?: boolean;
  options?: unknown;
}

/**
 * A toolbox is a collection of buttons and commands that they invoke, used to provide
 * custom control panels to users. This component is a generic UI component that
 * interacts with services and commands in a generic fashion. While it might
 * seem unconventional to import it from the UI and integrate it into the JSX,
 * it belongs in the UI components as there isn't anything in this component that
 * couldn't be used for a completely different type of app. It plays a crucial
 * role in enhancing the app with a toolbox by providing a way to integrate
 * and display various tools and their corresponding options
 */
export function Toolbox({ buttonSectionId, title, defaultOpen = true, beforeInteraction }: { buttonSectionId: string; title: string; defaultOpen?: boolean; beforeInteraction?: () => Promise<void> }) {
  const { servicesManager, commandsManager } = useSystem();
  const { t } = useTranslation();

  const { toolbarService, customizationService } = servicesManager.services;
  const isAIToolBox = buttonSectionId === 'aiToolBox';
  const isTextPromptToolbox = buttonSectionId === 'textPromptSegmentationToolbox';
  const isTestMedgemmaToolbox = buttonSectionId === 'testMedgemmaToolbox';
  const [showConfig, setShowConfig] = useState(false);
  const [isLocked, setIsLocked] = useState(toolboxState.getLocked());
  const hotkeysDisabled = !isAIToolBox || isLocked;

  // Local state for UI updates
  const [liveMode, setLiveMode] = useState(toolboxState.getLiveMode());
  const [posNeg, setPosNeg] = useState(toolboxState.getPosNeg());
  const [textPromptReplaceNew, setTextPromptReplaceNew] = useState(toolboxState.getTextPromptReplaceNew());
  const [selectedModel, setSelectedModel] = useState<'nnInteractive' | 'sam2' | 'medsam2' | 'sam3'>(toolboxState.getSelectedModel());
  const [medgemmaResult, setMedgemmaResult] = useState(toolboxState.getMedgemmaResult());
  const [medgemmaInstruction, setMedgemmaInstruction] = useState(toolboxState.getMedgemmaInstruction());
  const [medgemmaQuery, setMedgemmaQuery] = useState(toolboxState.getMedgemmaQuery());
  const [medgemmaStartSlice, setMedgemmaStartSlice] = useState<number | null>(toolboxState.getMedgemmaStartSlice());
  const [medgemmaEndSlice, setMedgemmaEndSlice] = useState<number | null>(toolboxState.getMedgemmaEndSlice());
  
  // Sync medgemma state from toolboxState
  useEffect(() => {
    if (isTestMedgemmaToolbox) {
      const interval = setInterval(() => {
        const result = toolboxState.getMedgemmaResult();
        const instruction = toolboxState.getMedgemmaInstruction();
        const query = toolboxState.getMedgemmaQuery();
        const startSlice = toolboxState.getMedgemmaStartSlice();
        const endSlice = toolboxState.getMedgemmaEndSlice();
        setMedgemmaResult(result);
        setMedgemmaInstruction(instruction);
        setMedgemmaQuery(query);
        setMedgemmaStartSlice(startSlice);
        setMedgemmaEndSlice(endSlice);
      }, 100); // Check every 100ms for updates
      return () => clearInterval(interval);
    }
  }, [isTestMedgemmaToolbox]);

  // Sync local state with global state changes
  useEffect(() => {
    const updateLocalState = () => {
      setLiveMode(toolboxState.getLiveMode());
      setPosNeg(toolboxState.getPosNeg());
      setTextPromptReplaceNew(toolboxState.getTextPromptReplaceNew());
      setSelectedModel(toolboxState.getSelectedModel());
      setIsLocked(toolboxState.getLocked());
    };

    // Update immediately
    updateLocalState();

    // Set up an interval to check for changes (since toolboxState doesn't have events)
    const interval = setInterval(updateLocalState, 100);

    return () => clearInterval(interval);
  }, []);

  // Keyboard hotkey handler for Live Mode toggle
  useEffect(() => {
    if (hotkeysDisabled) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if the pressed key is 'Q' or 'q'
      if ((event.key === 'Q' || event.key === 'q')) {
        // Only trigger if we're not typing in an input field
        const activeElement = document.activeElement;
        const isInputField = activeElement?.tagName === 'INPUT' || 
                           activeElement?.tagName === 'TEXTAREA' || 
                           (activeElement as HTMLElement)?.contentEditable === 'true';
        
        if (!isInputField) {
          event.preventDefault();
          const newLiveMode = !liveMode;
          setLiveMode(newLiveMode);
          toolboxState.setLiveMode(newLiveMode);
          console.log('Live mode toggled via hotkey (q):', newLiveMode);
        }
      }
    };

    // Add event listener
    document.addEventListener('keydown', handleKeyDown);

    // Cleanup
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [liveMode, hotkeysDisabled]);

  // Keyboard hotkey handler for Pos/Neg toggle
  useEffect(() => {
    if (hotkeysDisabled) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if the pressed key is 'W' or 'w'
      if ((event.key === 'W' || event.key === 'w')) {
        // Only trigger if we're not typing in an input field
        const activeElement = document.activeElement;
        const isInputField = activeElement?.tagName === 'INPUT' || 
                           activeElement?.tagName === 'TEXTAREA' || 
                           (activeElement as HTMLElement)?.contentEditable === 'true';
        
        if (!isInputField) {
          event.preventDefault();
          const newPosNeg = !posNeg;
          setPosNeg(newPosNeg);
          toolboxState.setPosNeg(newPosNeg);
          console.log('Pos/Neg toggled via hotkey (w):', newPosNeg);
        }
      }
    };

    // Add event listener
    document.addEventListener('keydown', handleKeyDown);

    // Cleanup
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [posNeg, hotkeysDisabled]);


  // When locked, force Pan tool active, disable live prompts, and collapse section
  useEffect(() => {
    if (isAIToolBox && isLocked) {
      try {
        // Disable live mode to avoid unintended inference
        if (liveMode) {
          setLiveMode(false);
          toolboxState.setLiveMode(false);
        }
        // Activate Pan tool
        commandsManager?.run?.('setToolActive', { toolName: 'Pan' });
      } catch (e) {
        // no-op
      }
    }
  }, [isAIToolBox, isLocked]);

  // Keyboard hotkey handler for model selection toggle (cycles through: nnInteractive -> sam2 -> medsam2 -> sam3 -> nnInteractive)
  useEffect(() => {
    if (hotkeysDisabled) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if the pressed key is 'T' or 't'
      if ((event.key === 'T' || event.key === 't')) {
        // Only trigger if we're not typing in an input field
        const activeElement = document.activeElement;
        const isInputField = activeElement?.tagName === 'INPUT' || 
                           activeElement?.tagName === 'TEXTAREA' || 
                           (activeElement as HTMLElement)?.contentEditable === 'true';
        
        if (!isInputField) {
          event.preventDefault();
          // Stability v1 exposes only nnInteractive; keyboard shortcuts must agree.
          const nextModel = 'nnInteractive';
          setSelectedModel(nextModel);
          toolboxState.setSelectedModel(nextModel);
          console.log('Model selection toggled via hotkey (t):', nextModel);
        }
      }
    };

    // Add event listener
    document.addEventListener('keydown', handleKeyDown);

    // Cleanup
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedModel, hotkeysDisabled]);

  const { toolbarButtons: toolboxSections, onInteraction } = useToolbar({
    servicesManager,
    buttonSection: buttonSectionId,
  });

  if (!toolboxSections.length) {
    return null;
  }

  // Ensure we have proper button sections at the top level.
  if (!toolboxSections.every(section => section.componentProps.buttonSection)) {
    throw new Error(
      'Toolbox accepts only button sections at the top level, not buttons. Create at least one button section.'
    );
  }

  // Helper to check a list of buttons for an active tool.
  const findActiveOptions = (buttons: any[]): unknown => {
    for (const tool of buttons) {
      if (tool.componentProps.isActive) {
        return tool.componentProps.options;
      }
      if (tool.componentProps.buttonSection) {
        const nestedButtons = toolbarService.getButtonPropsInButtonSection(
          tool.componentProps.buttonSection
        ) as ButtonProps[];
        const activeNested = nestedButtons.find(nested => nested.isActive);
        if (activeNested) {
          return activeNested.options;
        }
      }
    }
    return null;
  };

  // Look for active tool options across all sections.
  const activeToolOptions = toolboxSections.reduce((activeOptions, section) => {
    if (activeOptions) {
      return activeOptions;
    }
    const sectionId = section.componentProps.buttonSection;
    const buttons = toolbarService.getButtonSection(sectionId);
    return findActiveOptions(buttons);
  }, null);

  // Define the interaction handler once.
  const handleInteraction = async ({ itemId }: { itemId: string }) => {
    if (isAIToolBox && isLocked && itemId !== 'Pan') {
      // Prevent tool changes when locked; keep Pan active
      commandsManager?.run?.('setToolActive', { toolName: 'Pan' });
      return;
    }
    try {
      await beforeInteraction?.();
      onInteraction?.({ itemId });
    } catch (error) {
      servicesManager.services.uiNotificationService.show({ title: 'Unable to activate tool', message: error.message || String(error), type: 'error' });
    }
  };

  const CustomConfigComponent = customizationService.getCustomization(`${buttonSectionId}.config`);
  const shouldCollapse = isAIToolBox && isLocked;

  // Keep the panel slots/layout, but do not expose disabled heavy-model controls.
  if (isTextPromptToolbox || isTestMedgemmaToolbox) {
    return (
      <PanelSection defaultOpen={false}>
        <PanelSection.Header>{t(title)}</PanelSection.Header>
        <PanelSection.Content>
          <p className="px-2 py-2 text-sm text-muted-foreground">
            {isTextPromptToolbox ? 'VoxTell 文本分割' : 'MedGemma'} 在稳定版 v1 中暂不可用。
          </p>
        </PanelSection.Content>
      </PanelSection>
    );
  }

  return (
    <PanelSection key={isAIToolBox ? `toolbox-${isLocked}` : buttonSectionId} defaultOpen={defaultOpen && !shouldCollapse}>
      <PanelSection.Header 
        className="flex items-center justify-between"
      >
        <span className={classnames("flex items-center gap-2", { 
          "pointer-events-none": shouldCollapse 
        })}>
          <span className="pointer-events-auto">{t(title)}</span>
          {isAIToolBox && (
            <button
              type="button"
              className={classnames('ml-auto h-5 w-5 text-primary hover:opacity-80 pointer-events-auto cursor-pointer')}
              onClick={e => {
                e.stopPropagation();
                const next = !isLocked;
                setIsLocked(next);
                toolboxState.setLocked(next);
                if (next) {
                  commandsManager?.run?.('setToolActive', { toolName: 'Pan' });
                }
              }}
              aria-label={isLocked ? 'Unlock tools' : 'Lock tools'}
              title={isLocked ? 'Unlock tools' : 'Lock tools'}
            >
              {isLocked ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
            </button>
          )}
        </span>
        {CustomConfigComponent && (
          <div className="ml-auto mr-2">
            <Icons.Settings
              className="text-primary h-4 w-4"
              onClick={e => {
                e.stopPropagation();
                setShowConfig(!showConfig);
              }}
            />
          </div>
        )}
      </PanelSection.Header>

      {!shouldCollapse && (
      <PanelSection.Content className="bg-muted flex-shrink-0 border-none">
        {showConfig && <CustomConfigComponent />}
        {toolboxSections.map(section => {
          const sectionId = section.componentProps.buttonSection;
          const buttons = toolbarService.getButtonSection(sectionId) as any[];

          return (
            <React.Fragment key={sectionId}>
              {isAIToolBox && (
                <div className="flex justify-center items-center gap-4 py-2 px-1">
                   <div className="flex items-center gap-2">
                     <Label htmlFor="live-mode">Live Mode</Label>
                     <Switch
                       id="live-mode"
                       checked={liveMode}
                       onCheckedChange={(checked) => {
                        setLiveMode(checked);
                        toolboxState.setLiveMode(checked);
                        console.log('Live mode:', checked);
                       }}
                     />
                   </div>
                   <div className="flex items-center gap-2">
                     <Label htmlFor="pos-neg">Pos/Neg</Label>
                     <Switch
                       id="pos-neg"
                       checked={posNeg}
                       onCheckedChange={(checked) => {
                        setPosNeg(checked);
                        toolboxState.setPosNeg(checked);
                        console.log('Pos/Neg:', checked);
                      }}
                     />
                   </div>
                   <div className="flex items-center gap-2">
                     <Label htmlFor="model-selection">Model</Label>
                     <Select
                       value={selectedModel}
                       onValueChange={(value) => {
                         const model = value as 'nnInteractive' | 'sam2' | 'medsam2' | 'sam3';
                         setSelectedModel(model);
                         toolboxState.setSelectedModel(model);
                         console.log('Model selection:', model);
                       }}
                     >
                       <SelectTrigger id="model-selection" className="w-[140px]">
                         <SelectValue placeholder="Select model" />
                       </SelectTrigger>
                       <SelectContent>
                         <SelectItem value="nnInteractive">nnInteractive</SelectItem>
                       </SelectContent>
                     </Select>
                   </div>
                 </div>
                )}
              {isTextPromptToolbox && (
                <div className="flex justify-center items-center gap-4 py-2 px-1">
                   <div className="flex items-center gap-2">
                     <Label htmlFor="text-prompt-add-new">Add new segment</Label>
                     <Switch
                       id="text-prompt-add-new"
                       checked={textPromptReplaceNew}
                       onCheckedChange={(checked) => {
                        setTextPromptReplaceNew(checked);
                        toolboxState.setTextPromptReplaceNew(checked);
                        console.log('Text Prompt Add New:', checked);
                      }}
                     />
                   </div>
                 </div>
                )}
              <div
                className="bg-muted flex flex-wrap space-x-2 py-2 px-1"
              >
              {buttons.map(tool => {
                if (!tool) {
                  return null;
                }
                const { id, Component, componentProps } = tool;
                if (['sam2', 'textPromptSegmentation', 'testMedgemma'].includes(id)) {
                  return null;
                }

                // Hide testMedgemma button since we have input fields in the Toolbox
                if (isTestMedgemmaToolbox && id === 'testMedgemma') {
                  return null;
                }

                return (
                  <div
                    key={id}
                    className={classnames('ml-1')}
                  >
                    <Component
                      {...componentProps}
                      id={id}
                      onInteraction={handleInteraction}
                      size="toolbox"
                      servicesManager={servicesManager}
                    />
                  </div>
                );
              })}
            </div>
            {isTestMedgemmaToolbox && (
              <div className="flex flex-col gap-3 py-3 px-2 border-t border-primary/20">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="medgemma-instruction" className="text-sm font-semibold">Instruction (Optional)</Label>
                  <textarea
                    id="medgemma-instruction"
                    value={medgemmaInstruction}
                    onChange={(e) => {
                      const value = e.target.value;
                      setMedgemmaInstruction(value);
                      toolboxState.setMedgemmaInstruction(value);
                    }}
                    placeholder="Enter instruction (e.g., 'You are an instructor teaching medical students...')"
                    className="min-h-[60px] text-sm bg-primary-dark border border-primary-main rounded p-2 text-white placeholder:text-primary-light resize-y"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="medgemma-query" className="text-sm font-semibold">Query</Label>
                  <textarea
                    id="medgemma-query"
                    value={medgemmaQuery}
                    onChange={(e) => {
                      const value = e.target.value;
                      setMedgemmaQuery(value);
                      toolboxState.setMedgemmaQuery(value);
                    }}
                    placeholder="Enter your query/question"
                    className="min-h-[60px] text-sm bg-primary-dark border border-primary-main rounded p-2 text-white placeholder:text-primary-light resize-y"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-semibold">Slice Range (Optional)</Label>
                  <div className="flex gap-2">
                    <div className="flex flex-col gap-1 flex-1">
                      <Label htmlFor="medgemma-start-slice" className="text-xs text-primary-light">Start Slice (min: 1)</Label>
                      <input
                        id="medgemma-start-slice"
                        type="number"
                        min="1"
                        value={medgemmaStartSlice ?? ''}
                        onChange={(e) => {
                          const value = e.target.value === '' ? null : parseInt(e.target.value, 10);
                          setMedgemmaStartSlice(value);
                          toolboxState.setMedgemmaStartSlice(value);
                        }}
                        placeholder="1"
                        className="text-sm bg-primary-dark border border-primary-main rounded p-2 text-white placeholder:text-primary-light"
                      />
                    </div>
                    <div className="flex flex-col gap-1 flex-1">
                      <Label htmlFor="medgemma-end-slice" className="text-xs text-primary-light">End Slice (max: total slices)</Label>
                      <input
                        id="medgemma-end-slice"
                        type="number"
                        min="1"
                        value={medgemmaEndSlice ?? ''}
                        onChange={(e) => {
                          const value = e.target.value === '' ? null : parseInt(e.target.value, 10);
                          setMedgemmaEndSlice(value);
                          toolboxState.setMedgemmaEndSlice(value);
                        }}
                        placeholder="Total slices"
                        className="text-sm bg-primary-dark border border-primary-main rounded p-2 text-white placeholder:text-primary-light"
                      />
                    </div>
                  </div>
                </div>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => {
                    commandsManager?.run('testMedgemma', { 
                      instruction: medgemmaInstruction, 
                      query: medgemmaQuery,
                      startSlice: medgemmaStartSlice,
                      endSlice: medgemmaEndSlice
                    });
                  }}
                  disabled={!medgemmaQuery || medgemmaQuery.trim() === ''}
                  className="w-full"
                >
                  Run Medgemma
                </Button>
                {medgemmaResult && (
                  <div className="flex flex-col gap-2 mt-2">
                    <Label className="text-sm font-semibold">Result:</Label>
                    <div className="bg-primary-dark border border-primary-main rounded p-3 max-h-[300px] overflow-y-auto">
                      <pre className="whitespace-pre-wrap break-words text-sm text-white">
                        {medgemmaResult}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            )}
            </React.Fragment>
          );
        })}
        {activeToolOptions && (
          <div className="bg-primary-dark mt-1 h-auto px-2">
            <ToolSettings options={activeToolOptions} />
          </div>
        )}
      </PanelSection.Content>
      )}
    </PanelSection>
  );
}
