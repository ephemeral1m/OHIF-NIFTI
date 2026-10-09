const { NiftiMemoryLedger, niftiSegmentationMemoryOwner } = require('./niftiMemoryLedger');

describe('NiftiMemoryLedger', () => {
  test('deduplicates views by their underlying ArrayBuffer', () => {
    const ledger = new NiftiMemoryLedger();
    const owner = ledger.createOwner('response');
    const buffer = new ArrayBuffer(1024);

    ledger.trackBuffer(buffer, { source: 'axios-response', owner });
    ledger.trackBuffer(new Uint8Array(buffer, 100, 20), {
      source: 'multipart-seg',
      owner,
    });

    const report = ledger.report();
    expect(report.trackedRecordCount).toBe(1);
    expect(report.reachableBytes).toBe(1024);
    expect(report.samples[0].sources).toEqual(['axios-response', 'multipart-seg']);
  });

  test('classifies a released owner that remains reachable', () => {
    const ledger = new NiftiMemoryLedger();
    const owner = ledger.createOwner('prepare');
    const buffer = new Uint8Array(512);

    ledger.trackBuffer(buffer, { source: 'prepared-mask', owner });
    ledger.releaseOwner(owner);

    const report = ledger.report();
    expect(report.activeBytes).toBe(0);
    expect(report.releasedButReachableBytes).toBe(512);
    expect(report.samples[0].status).toBe('released-but-reachable');
  });

  test('keeps a record active while another owner still owns it', () => {
    const ledger = new NiftiMemoryLedger();
    const firstOwner = ledger.createOwner('response');
    const secondOwner = ledger.createOwner('segmentation');
    const buffer = new Uint8Array(256);

    ledger.trackBuffer(buffer, { source: 'response', owner: firstOwner });
    ledger.trackBuffer(buffer, { source: 'derived', owner: secondOwner });
    ledger.releaseOwner(firstOwner);

    let report = ledger.report();
    expect(report.activeBytes).toBe(256);
    expect(report.releasedButReachableBytes).toBe(0);

    ledger.releaseOwner(secondOwner);
    report = ledger.report();
    expect(report.activeBytes).toBe(0);
    expect(report.releasedButReachableBytes).toBe(256);
  });

  test('tracks object roots without adding them to the byte total', () => {
    const ledger = new NiftiMemoryLedger();
    const object = {};
    ledger.trackObject(object, { source: 'derived-image', owner: 'segmentation:1' });

    const report = ledger.report();
    expect(report.trackedRecordCount).toBe(1);
    expect(report.reachableBytes).toBe(0);
    expect(report.samples[0].kind).toBe('object');
  });

  test('omits per-record samples while preserving aggregate owner state', () => {
    const ledger = new NiftiMemoryLedger();
    const activeOwner = ledger.createOwner('active');
    const releasedOwner = ledger.createOwner('released');
    const activeBuffer = new Uint8Array(128);
    const releasedBuffer = new Uint8Array(64);

    ledger.trackBuffer(activeBuffer, { source: 'active-buffer', owner: activeOwner });
    ledger.trackBuffer(releasedBuffer, { source: 'released-buffer', owner: releasedOwner });
    ledger.releaseOwner(releasedOwner);

    const report = ledger.report({ includeSamples: false });
    expect(report.samples).toBeUndefined();
    expect(report.activeBytes).toBe(128);
    expect(report.releasedButReachableBytes).toBe(64);
    expect(report.bySource).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'active-buffer', activeBytes: 128 }),
        expect.objectContaining({
          source: 'released-buffer',
          releasedButReachableBytes: 64,
        }),
      ])
    );
  });

  test('reset clears metadata and owner numbering', () => {
    const ledger = new NiftiMemoryLedger();
    ledger.trackBuffer(new Uint8Array(8), { source: 'test', owner: 'owner' });
    ledger.reset();

    expect(ledger.report().trackedRecordCount).toBe(0);
    expect(ledger.createOwner('fresh')).toBe('fresh:1');
    expect(niftiSegmentationMemoryOwner('abc')).toBe('nifti-segmentation:abc');
  });
});
