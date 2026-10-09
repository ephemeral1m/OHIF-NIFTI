import { registerNifti, memorySnapshot } from './sourceStore';
import { createDataSource, getSopClassHandlerModule } from './dataSource';
import Panel from './WorkspacePanel';
import CaseFilesPanel from './CaseFilesPanel';
import { attachMaskEvents } from './masks';

export { default as NiftiGateway } from './Gateway';
export { default as NiftiIcon } from './NiftiIcon';
export { releaseAllSources } from './sourceStore';
export default {
  id: '@ohif/extension-nifti',
  preRegistration({ appConfig }) {
    registerNifti(appConfig);
    attachMaskEvents();
    if (appConfig.enableNiftiViewing && !appConfig.dataSources.some(s => s.sourceName === 'nifti')) {
      appConfig.dataSources.push({ namespace: '@ohif/extension-nifti.dataSourcesModule.nifti', sourceName: 'nifti', configuration: { friendlyName: 'Native NIfTI' } });
    }
  },
  getDataSourcesModule: ({ commandsManager }) => [{ name: 'nifti', type: 'niftiApi', createDataSource: () => createDataSource(commandsManager) }],
  getSopClassHandlerModule,
  getUtilityModule: () => [{ name: 'diagnostics', exports: { memorySnapshot } }],
  getPanelModule: () => [{ name: 'nifti', iconName: 'tab-segmentation', label: '报告与标注', component: Panel }, { name: 'caseFiles', iconName: 'tab-studies', label: '病例与文件', component: CaseFilesPanel }],
};
