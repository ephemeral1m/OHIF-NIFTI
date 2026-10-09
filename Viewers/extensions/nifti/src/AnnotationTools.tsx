import React, { useEffect, useRef, useState } from 'react';
import { useSystem, useToolbar } from '@ohif/core';
import { Icons, ToolSettings } from '@ohif/ui-next';
import {
  Sparkles,
  Paintbrush,
  Lock,
  LockOpen,
  Plus,
  Minus,
  Zap,
  Loader2,
  ChevronDown,
} from 'lucide-react';
import { toolboxState } from '../../default/src/stores/toolboxState';
import './annotation-tools.css';

const labels = {
  Probe2: '点提示',
  PlanarFreehandROI2: '涂鸦',
  PlanarFreehandROI3: '套索',
  RectangleROI2: '框选',
  Brush: '画笔',
  Eraser: '橡皮擦',
  Threshold: '阈值',
  Shapes: '形状',
  nninter: '运行 AI',
  resetNninter: '重置提示',
  InterpolateLabelmap: '跨层插值',
  SegmentBidirectional: '长短径',
};
const settingLabels = {
  'Radius (mm)': '半径 · mm',
  Shape: '形状',
  Circle: '圆形',
  Sphere: '球形',
  Rectangle: '矩形',
  Threshold: '阈值',
  Dynamic: '自动',
  Range: '范围',
};

export default function AnnotationTools({ beforeAI, enableAI, enableEditing, sourceKey }) {
  const { servicesManager, commandsManager } = useSystem();
  const { uiNotificationService } = servicesManager.services;
  const ai = useToolbar({ buttonSection: 'aiToolBoxSection' });
  const brush = useToolbar({ buttonSection: 'brushToolsSection' });
  const manual = useToolbar({ buttonSection: 'segmentationToolboxToolsSection' });
  const utilities = useToolbar({ buttonSection: 'segmentationToolboxUtilitySection' });
  const [mode, setMode] = useState(enableEditing ? 'manual' : 'ai');
  const [collapsed, setCollapsed] = useState(false);
  const bodyId = `annotation-tools-${sourceKey || 'pending'}`;
  const [, refresh] = useState(0);
  const [pending, setPending] = useState(false);
  const sequence = useRef(0),
    remembered = useRef({ ai: 'Probe2', manual: 'Brush' });
  const locked = toolboxState.getLocked(),
    negative = toolboxState.getPosNeg(),
    live = toolboxState.getLiveMode();
  const aiTools = ai.toolbarButtons.filter(b =>
    ['Probe2', 'PlanarFreehandROI2', 'PlanarFreehandROI3', 'RectangleROI2'].includes(b.id)
  );
  const manualTools = [
    ...brush.toolbarButtons,
    ...manual.toolbarButtons.filter(b => b.id === 'Shapes'),
  ];
  const tools = mode === 'ai' ? aiTools : manualTools;
  const actions =
    mode === 'ai'
      ? ai.toolbarButtons.filter(b => ['nninter', 'resetNninter'].includes(b.id))
      : utilities.toolbarButtons;
  const activeTool = [...aiTools, ...manualTools].find(b => b.componentProps.isActive);
  const activeOptions = tools.find(b => b.componentProps.isActive)?.componentProps.options;
  const change = fn => {
    fn();
    refresh(v => v + 1);
  };
  useEffect(() => {
    const timer = setInterval(() => refresh(v => v + 1), 250);
    return () => {
      clearInterval(timer);
      sequence.current++;
    };
  }, [sourceKey]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        mode !== 'ai' ||
        locked ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        (e.target as HTMLElement)?.closest('input,textarea,select,[contenteditable=true]')
      )
        return;
      if (e.key.toLowerCase() === 'q') {
        e.preventDefault();
        change(() => toolboxState.setLiveMode(!toolboxState.getLiveMode()));
      }
      if (e.key.toLowerCase() === 'w') {
        e.preventDefault();
        change(() => toolboxState.setPosNeg(!toolboxState.getPosNeg()));
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [mode, locked]);
  const activate = async (id, nextMode = mode) => {
    const token = ++sequence.current;
    setMode(nextMode);
    const button = [...ai.toolbarButtons, ...manualTools, ...utilities.toolbarButtons].find(
      b => b.id === id
    );
    if (!button || button.componentProps.disabled || (nextMode === 'ai' && locked)) return;
    setPending(nextMode === 'ai');
    try {
      if (nextMode === 'ai') await beforeAI?.();
      if (token !== sequence.current) return;
      if (nextMode === 'ai') toolboxState.setSelectedModel('nnInteractive');
      // The shared toolbar dispatch applies current options and mutually
      // excludes the prior primary mouse tool; no separate editor tool state.
      ai.onInteraction({ itemId: id });
      if ([...aiTools, ...manualTools].some(b => b.id === id)) remembered.current[nextMode] = id;
    } catch (error) {
      if (token === sequence.current)
        uiNotificationService.show({ title: '标注工具', message: error.message, type: 'error' });
    } finally {
      if (token === sequence.current) setPending(false);
    }
  };
  const selectMode = next => {
    sequence.current++;
    setPending(false);
    setMode(next);
    activate(remembered.current[next], next);
  };
  const renderTool = (tool, action = false) => {
    const props = tool.componentProps;
    const disabled = props.disabled || (mode === 'ai' && (locked || pending));
    return (
      <button
        key={tool.id}
        type="button"
        data-tool={tool.id}
        aria-label={labels[tool.id] || props.label}
        aria-pressed={action ? undefined : !!props.isActive}
        disabled={disabled}
        title={
          disabled
            ? props.disabledText || (locked ? '请先解锁 AI 提示' : '正在准备原图')
            : props.tooltip || props.label
        }
        onClick={() => activate(tool.id)}
        className={action ? 'at-action' : 'at-tool'}
      >
        <Icons.ByName name={props.icon} />
        <span>{labels[tool.id] || props.label}</span>
      </button>
    );
  };
  return (
    <section
      className="annotation-tools"
      aria-label="标注工具"
    >
      <button
        type="button"
        className="at-heading"
        aria-label="标注工具面板"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={() => setCollapsed(value => !value)}
      >
        <span className="at-mark">
          <Sparkles size={17} />
        </span>
        <span className="at-title">标注工具</span>
        <span
          className="at-current"
          role="status"
        >
          {pending ? (
            <>
              <Loader2
                size={13}
                className="animate-spin"
              />
              准备中
            </>
          ) : activeTool ? (
            labels[activeTool.id]
          ) : (
            '选择工具'
          )}
        </span>
        <ChevronDown
          size={17}
          className="at-chevron"
        />
      </button>
      <div
        id={bodyId}
        hidden={collapsed}
        className="at-body"
      >
        <div
          className="at-tabs"
          role="tablist"
          aria-label="标注模式"
        >
          {enableAI && (
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'ai'}
              onClick={() => selectMode('ai')}
            >
              <Sparkles size={16} />
              AI 提示
            </button>
          )}
          {enableEditing && (
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'manual'}
              onClick={() => selectMode('manual')}
            >
              <Paintbrush size={16} />
              手工编辑
            </button>
          )}
        </div>
        <div
          role="tabpanel"
          aria-label={mode === 'ai' ? 'AI 提示工具' : '手工编辑工具'}
        >
          {mode === 'ai' && (
            <div className="at-ai-controls">
              <div
                className="at-polarity"
                aria-label="提示类型"
              >
                <button
                  type="button"
                  aria-pressed={!negative}
                  onClick={() => change(() => toolboxState.setPosNeg(false))}
                  title="包含区域 · W"
                >
                  <Plus size={14} />
                  包含
                </button>
                <button
                  type="button"
                  aria-pressed={negative}
                  onClick={() => change(() => toolboxState.setPosNeg(true))}
                  title="排除区域 · W"
                >
                  <Minus size={14} />
                  排除
                </button>
              </div>
              <button
                type="button"
                className="at-live"
                aria-pressed={live}
                title="自动推理 · Q"
                onClick={() => change(() => toolboxState.setLiveMode(!live))}
              >
                <Zap size={14} />
                自动
              </button>
              <button
                type="button"
                className="at-lock"
                aria-label={locked ? '解锁 AI 工具' : '锁定 AI 工具'}
                aria-pressed={locked}
                onClick={() =>
                  change(() => {
                    sequence.current++;
                    setPending(false);
                    toolboxState.setLocked(!locked);
                    if (!locked) {
                      toolboxState.setLiveMode(false);
                      commandsManager.run('setToolActive', { toolName: 'Pan' });
                    }
                  })
                }
              >
                {locked ? <Lock size={16} /> : <LockOpen size={16} />}
              </button>
            </div>
          )}
          <div className="at-tools">{tools.map(tool => renderTool(tool))}</div>
          {activeOptions && (
            <div className="at-settings">
              <ToolSettings
                options={
                  Array.isArray(activeOptions)
                    ? activeOptions.map(option => ({
                        ...option,
                        name: settingLabels[option.name] || option.name,
                        values: option.values?.map(item => ({
                          ...item,
                          label: settingLabels[item.label] || item.label,
                        })),
                      }))
                    : activeOptions
                }
              />
            </div>
          )}
          <div className="at-actions">{actions.map(tool => renderTool(tool, true))}</div>
          <footer>
            {mode === 'ai' ? (
              <>
                <span className="at-dot" />
                nnInteractive<span>当前选中目标</span>
              </>
            ) : (
              <>
                <span className="at-dot" />
                直接编辑 mask<span>球形 / 插值需完整体数据</span>
              </>
            )}
          </footer>
        </div>
      </div>
    </section>
  );
}
