import { Enums } from '@cornerstonejs/tools';

/** Apply on entry and successful case replacement, including unused MPR groups. */
export function activateNativeBrowse(servicesManager) {
  const { toolGroupService } = servicesManager.services;
  for (const id of ['default', 'mpr']) {
    const group = toolGroupService.getToolGroup(id);
    if (!group?.hasTool('Pan')) continue;
    const active = group.getActivePrimaryMouseButtonTool();
    if (active) {
      group.getToolConfiguration(active)?.disableOnPassive
        ? group.setToolDisabled(active) : group.setToolPassive(active);
    }
    for (const name of ['Probe2', 'RectangleROI2', 'PlanarFreehandROI2', 'PlanarFreehandROI3']) {
      if (group.hasTool(name)) group.setToolEnabled(name);
    }
    group.setToolActive('Pan', { bindings: [
      { mouseButton: Enums.MouseBindings.Primary },
      { mouseButton: Enums.MouseBindings.Auxiliary },
    ] });
  }
}
