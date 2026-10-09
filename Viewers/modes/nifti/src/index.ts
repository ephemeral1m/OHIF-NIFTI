import longitudinal from '@ohif/mode-longitudinal';
import { releaseAllSources, activateNativeBrowse } from '@ohif/extension-nifti';

const handler = '@ohif/extension-nifti.sopClassHandlerModule.nifti';
const extensionDependencies = { ...longitudinal.extensionDependencies, '@ohif/extension-nifti': '3.10.4' };
export default {
  id: '@ohif/mode-nifti', extensionDependencies,
  modeFactory(args) {
    const base = longitudinal.modeFactory(args);
    return {
      ...base, id: '@ohif/mode-nifti', routeName: 'nifti-viewer', displayName: 'Native NIfTI',
      extensions: extensionDependencies, sopClassHandlers: [handler],
      isValidMode: () => ({ valid: false, description: 'Open native images through the NIfTI entry.' }),
      onModeEnter(context) {
        document.body.classList.add('nifti-workbench');
        base.onModeEnter(context);
        activateNativeBrowse(context.servicesManager);
        const toolbar = context.servicesManager.services.toolbarService;
        const pan = toolbar.getButton('Pan');
        toolbar.setButtons({ ...toolbar.getButtons(), Pan: { ...pan, props: { ...pan.props,
          label: '浏览', tooltip: '浏览 · 左键拖动图像，滚轮切层',
        } } });
        toolbar.setButtonSection('primary', ['Pan', 'MeasurementTools', 'Zoom', 'TrackballRotate',
          'WindowLevel', 'Capture', 'Layout', 'Crosshairs', 'MoreTools']);
        // Native source capabilities have their own panel. Never dispatch DICOM persistence/AI.
        context.servicesManager.services.toolbarService.setButtonSection('aiToolBoxSection',
          context.extensionManager.appConfig.enableNiftiAI
            ? ['Probe2', 'PlanarFreehandROI2', 'PlanarFreehandROI3', 'RectangleROI2', 'nninter', 'resetNninter'] : []);
      },
      onModeExit(context) { document.body.classList.remove('nifti-workbench'); base.onModeExit(context); releaseAllSources(); },
      routes: [{ ...base.routes[0], layoutTemplate: () => {
        const layout = base.routes[0].layoutTemplate();
        return { ...layout, props: { ...layout.props,
          leftPanels: ['@ohif/extension-nifti.panelModule.caseFiles'],
          rightPanels: ['@ohif/extension-nifti.panelModule.nifti'],
          viewports: [{ ...layout.props.viewports[0], displaySetsToDisplay: [handler] }],
        } };
      } }],
    };
  },
};
