export type Affine = number[][];
export type SourceCapabilities = {
  viewing: boolean;
  serverSave: boolean;
  editing: boolean;
  ai: boolean;
  pacsExport: false;
  streamingViewing?: boolean;
};

/** Immutable voxel identity; mutable library/display metadata lives alongside it.
 * IJK: i fastest in the buffer. Backend ndarray shape is [k,j,i] / [z,y,x].
 * All viewport and AI physical coordinates use millimetre LPS.
 */
export interface SourceDescriptor {
  sourceType: 'nifti';
  sourceId?: string;
  contentHash: string;
  hashVersion: 1;
  geometryHash: string;
  name: string;
  dimensions: [number, number, number];
  count: number;
  sourceBytes: number;
  workingBytes: number;
  rawDtype: string;
  workingDtype: string;
  datatype: number;
  slope: number;
  intercept: number;
  sform: Affine | null;
  qform: Affine | null;
  affine: Affine;
  selectedAffine: 'sform' | 'qform';
  unit: 'mm' | 'm' | 'um';
  originalUnit: number;
  voxelToLPS: Affine;
  format: 'nii' | 'nii.gz';
  modality: 'CT' | 'MR' | 'OT';
  warnings: string[];
  min: number;
  max: number;
  capabilities: SourceCapabilities;
  provenance?: { originalName: string; transforms: unknown[] };
}
