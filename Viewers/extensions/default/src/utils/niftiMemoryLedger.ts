type MemoryKind = 'buffer' | 'object';

type TrackOptions = {
  source: string;
  owner?: string;
};

type OwnerState = {
  releasedAt?: number;
};

type MemoryRecord = {
  id: number;
  generation: number;
  kind: MemoryKind;
  primarySource: string;
  sources: Set<string>;
  owners: Map<string, OwnerState>;
  byteLength: number;
  createdAt: number;
  collectedAt?: number;
  reference: WeakRef<object>;
};

type FinalizedRecord = {
  id: number;
  generation: number;
};

type MemorySourceReport = {
  source: string;
  recordCount: number;
  reachableCount: number;
  activeCount: number;
  releasedButReachableCount: number;
  collectedCount: number;
  reachableBytes: number;
  activeBytes: number;
  releasedButReachableBytes: number;
};

const DEFAULT_MAX_RECORDS = 100_000;
const UNOWNED = 'unowned';

function bufferObject(value: ArrayBuffer | ArrayBufferView): object {
  return ArrayBuffer.isView(value) ? (value.buffer as object) : value;
}

function bufferByteLength(value: ArrayBuffer | ArrayBufferView): number {
  return ArrayBuffer.isView(value) ? value.buffer.byteLength : value.byteLength;
}

/**
 * Records the lifecycle of large NIfTI-related objects without retaining them.
 *
 * The ledger only stores WeakRef/WeakMap references. A "released but reachable"
 * entry means OHIF has finished with its logical owner, but the browser has not
 * collected the object yet. Immediately after an operation this can simply mean
 * GC has not run. If it persists after Firefox "Minimize memory usage", another
 * root (for example a Promise, notification or DevTools console grip) retains it.
 */
export class NiftiMemoryLedger {
  private records = new Map<number, MemoryRecord>();
  private objectIds = new WeakMap<object, number>();
  private nextRecordId = 1;
  private nextOwnerId = 1;
  private generation = 1;
  private droppedRecords = 0;
  private readonly maxRecords: number;
  private readonly supported: boolean;
  private readonly finalizer?: FinalizationRegistry<FinalizedRecord>;

  constructor(maxRecords = DEFAULT_MAX_RECORDS) {
    this.maxRecords = maxRecords;
    this.supported = typeof WeakRef === 'function';
    if (this.supported && typeof FinalizationRegistry === 'function') {
      this.finalizer = new FinalizationRegistry(({ id, generation }) => {
        if (generation !== this.generation) {
          return;
        }
        const record = this.records.get(id);
        if (record) {
          record.collectedAt = Date.now();
        }
      });
    }
  }

  createOwner(prefix: string): string {
    return `${prefix}:${this.nextOwnerId++}`;
  }

  trackBuffer(
    value: ArrayBuffer | ArrayBufferView | undefined,
    options: TrackOptions
  ): number | void {
    if (!value) {
      return;
    }
    const target = bufferObject(value);
    return this.track(target, 'buffer', bufferByteLength(value), options);
  }

  trackObject(value: object | undefined | null, options: TrackOptions): number | void {
    if (!value) {
      return;
    }
    return this.track(value, 'object', 0, options);
  }

  releaseOwner(owner: string | undefined): void {
    if (!owner) {
      return;
    }
    const releasedAt = Date.now();
    for (const record of this.records.values()) {
      const state = record.owners.get(owner);
      if (state && state.releasedAt === undefined) {
        state.releasedAt = releasedAt;
      }
    }
  }

  report({ includeSamples = true }: { includeSamples?: boolean } = {}) {
    const now = Date.now();
    const bySource = new Map<string, MemorySourceReport>();
    const sampleCandidates: Array<{
      id: number;
      kind: MemoryKind;
      primarySource: string;
      sources: string[];
      byteLength: number;
      status: 'active' | 'released-but-reachable' | 'collected';
      ageMs: number;
      activeOwners: string[];
      releasedOwners: string[];
    }> = [];

    let reachableCount = 0;
    let activeCount = 0;
    let releasedButReachableCount = 0;
    let collectedCount = 0;
    let reachableBytes = 0;
    let activeBytes = 0;
    let releasedButReachableBytes = 0;

    for (const record of this.records.values()) {
      const reachable = record.reference.deref() !== undefined;
      if (!reachable && record.collectedAt === undefined) {
        record.collectedAt = now;
      }
      let hasActiveOwner = false;
      let hasReleasedOwner = false;
      let activeOwners: string[] | undefined;
      let releasedOwners: string[] | undefined;
      if (includeSamples) {
        activeOwners = [];
        releasedOwners = [];
      }
      for (const [owner, state] of record.owners.entries()) {
        if (state.releasedAt === undefined) {
          hasActiveOwner = true;
          activeOwners?.push(owner);
        } else {
          hasReleasedOwner = true;
          releasedOwners?.push(owner);
        }
      }
      const active = reachable && hasActiveOwner;
      const releasedButReachable = reachable && !hasActiveOwner && hasReleasedOwner;

      if (reachable) {
        reachableCount++;
        reachableBytes += record.byteLength;
      } else {
        collectedCount++;
      }
      if (active) {
        activeCount++;
        activeBytes += record.byteLength;
      }
      if (releasedButReachable) {
        releasedButReachableCount++;
        releasedButReachableBytes += record.byteLength;
      }

      let source = bySource.get(record.primarySource);
      if (!source) {
        source = {
          source: record.primarySource,
          recordCount: 0,
          reachableCount: 0,
          activeCount: 0,
          releasedButReachableCount: 0,
          collectedCount: 0,
          reachableBytes: 0,
          activeBytes: 0,
          releasedButReachableBytes: 0,
        };
        bySource.set(record.primarySource, source);
      }
      source.recordCount++;
      if (reachable) {
        source.reachableCount++;
        source.reachableBytes += record.byteLength;
      } else {
        source.collectedCount++;
      }
      if (active) {
        source.activeCount++;
        source.activeBytes += record.byteLength;
      }
      if (releasedButReachable) {
        source.releasedButReachableCount++;
        source.releasedButReachableBytes += record.byteLength;
      }

      if (includeSamples) {
        const status = !reachable ? 'collected' : active ? 'active' : 'released-but-reachable';
        sampleCandidates.push({
          id: record.id,
          kind: record.kind,
          primarySource: record.primarySource,
          sources: [...record.sources],
          byteLength: record.byteLength,
          status,
          ageMs: now - record.createdAt,
          activeOwners: activeOwners!,
          releasedOwners: releasedOwners!,
        });
      }
    }

    return {
      supported: this.supported,
      trackedRecordCount: this.records.size,
      reachableCount,
      activeCount,
      releasedButReachableCount,
      collectedCount,
      reachableBytes,
      activeBytes,
      releasedButReachableBytes,
      droppedRecords: this.droppedRecords,
      bySource: [...bySource.values()].sort(
        (a, b) => b.releasedButReachableBytes - a.releasedButReachableBytes
      ),
      ...(includeSamples
        ? {
            samples: sampleCandidates
              .sort((a, b) => {
                const aPriority = a.status === 'released-but-reachable' ? 1 : 0;
                const bPriority = b.status === 'released-but-reachable' ? 1 : 0;
                return bPriority - aPriority || b.byteLength - a.byteLength;
              })
              .slice(0, 100),
          }
        : {}),
    };
  }

  reset(): void {
    this.generation++;
    this.records.clear();
    this.objectIds = new WeakMap<object, number>();
    this.nextRecordId = 1;
    this.nextOwnerId = 1;
    this.droppedRecords = 0;
  }

  private track(
    target: object,
    kind: MemoryKind,
    byteLength: number,
    { source, owner = UNOWNED }: TrackOptions
  ): number | void {
    if (!this.supported) {
      return;
    }
    const existingId = this.objectIds.get(target);
    if (existingId !== undefined) {
      const record = this.records.get(existingId);
      if (record) {
        record.sources.add(source);
        record.owners.set(owner, {});
      }
      return existingId;
    }

    if (this.records.size >= this.maxRecords) {
      this.droppedRecords++;
      return;
    }

    const id = this.nextRecordId++;
    const record: MemoryRecord = {
      id,
      generation: this.generation,
      kind,
      primarySource: source,
      sources: new Set([source]),
      owners: new Map([[owner, {}]]),
      byteLength,
      createdAt: Date.now(),
      reference: new WeakRef(target),
    };
    this.records.set(id, record);
    this.objectIds.set(target, id);
    this.finalizer?.register(target, { id, generation: this.generation });
    return id;
  }
}

export const niftiMemoryLedger = new NiftiMemoryLedger();

export function niftiSegmentationMemoryOwner(segmentationId: string): string {
  return `nifti-segmentation:${segmentationId}`;
}
