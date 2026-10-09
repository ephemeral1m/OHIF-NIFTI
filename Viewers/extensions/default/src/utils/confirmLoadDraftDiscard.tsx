import React from 'react';
import { Button } from '@ohif/ui-next';

import { DRAFT_DIRTY_REASON_LABELS, DraftDirtyReason } from './niftiDraftState';

export type LoadDraftConflictItem = {
  key: string;
  label: string;
  reasons: DraftDirtyReason[];
};

function LoadDraftConflictDialog({
  hide,
  items,
  onContinue,
  onCancel,
}: {
  hide: () => void;
  items: LoadDraftConflictItem[];
  onContinue: () => void;
  onCancel: () => void;
}) {
  const finish = (callback: () => void) => {
    callback();
    hide();
  };

  return (
    <div className="text-foreground flex max-h-[70vh] w-[520px] max-w-full flex-col gap-4 p-4">
      <div className="text-sm">
        以下 mask 尚未保存。继续加载将丢弃这些修改，并以当前 NIfTI 存储库为准。
      </div>
      <div className="border-border bg-background max-h-[42vh] overflow-y-auto rounded border p-2">
        <ul className="space-y-2">
          {items.map(item => (
            <li
              key={item.key}
              className="bg-muted/30 rounded px-3 py-2"
            >
              <div className="font-medium">{item.label}</div>
              <div className="text-muted-foreground text-xs">
                {item.reasons.map(reason => DRAFT_DIRTY_REASON_LABELS[reason]).join('；')}
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => finish(onCancel)}
        >
          Cancel
        </Button>
        <Button onClick={() => finish(onContinue)}>Continue</Button>
      </div>
    </div>
  );
}

export function confirmLoadDraftDiscard({
  uiDialogService,
  items,
}: {
  uiDialogService: AppTypes.UIDialogService;
  items: LoadDraftConflictItem[];
}): Promise<boolean> {
  const dialogId = 'load-draft-unsaved-conflict';

  return new Promise(resolve => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    uiDialogService.show({
      id: dialogId,
      title: `发现 ${items.length} 个未保存的 mask`,
      content: LoadDraftConflictDialog,
      shouldCloseOnEsc: true,
      onClose: () => {
        finish(false);
        uiDialogService.hide(dialogId);
      },
      contentProps: {
        items,
        onContinue: () => finish(true),
        onCancel: () => finish(false),
      },
    });
  });
}

export default confirmLoadDraftDiscard;
