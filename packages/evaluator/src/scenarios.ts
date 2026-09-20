export interface BenchmarkTaskSpec {
  taskId: string;
  title: string;
  prompt: string;
  expectedArtifacts: string[];
  forbiddenRules?: string[];
  supersedesReqId?: string;
  isOutOfBoundsProposal?: boolean;
  triggersCompression?: boolean;
}

export interface BenchmarkScenario {
  initialPrompt: string;
  forbiddenRule: string;
  tasks: BenchmarkTaskSpec[];
  userAmendment: {
    atTaskId: string;
    amendment: string;
    supersedesRequirementId: string;
  };
}

export function getBenchmarkScenario(): BenchmarkScenario {
  const forbiddenRule = 'DO NOT ALTER PUBLIC API SIGNATURES';
  const initialPrompt = `Build an extensible key-value core system with strict interface backward compatibility. Note: ${forbiddenRule}.`;

  const tasks: BenchmarkTaskSpec[] = [
    {
      taskId: 'u1',
      title: 'Infrastructure and public API skeleton',
      prompt: `Task u1: Define public API skeleton and core interfaces. Ensure: ${forbiddenRule}.`,
      expectedArtifacts: ['src/api.ts', 'src/types.ts'],
      forbiddenRules: [forbiddenRule]
    },
    {
      taskId: 'u2',
      title: 'In-memory storage engine',
      prompt: 'Task u2: Implement memory-backed storage provider conforming to the public API.',
      expectedArtifacts: ['src/memory-storage.ts']
    },
    {
      taskId: 'u3',
      title: 'Unit test suite',
      prompt: 'Task u3: Add comprehensive unit tests verifying storage operations.',
      expectedArtifacts: ['tests/storage.test.ts']
    },
    {
      taskId: 'u4',
      title: 'Requirement amendment: Storage migration',
      prompt: 'Task u4: Prepare architecture for SQLite storage migration while preserving public API.',
      expectedArtifacts: ['src/sqlite-adapter.ts'],
      supersedesReqId: 'u2'
    },
    {
      taskId: 'u5',
      title: 'SQLite driver integration and data migration',
      prompt: 'Task u5: Complete SQLite integration and verify replacement of in-memory backend.',
      expectedArtifacts: ['src/sqlite-storage.ts']
    },
    {
      taskId: 'u6',
      title: 'Performance benchmark and memory profiling',
      prompt: 'Task u6: Benchmark read/write throughput and memory consumption under load.',
      expectedArtifacts: ['tests/perf.bench.ts'],
      triggersCompression: true
    },
    {
      taskId: 'u7',
      title: 'Caching layer construction',
      prompt: 'Task u7: Add LRU caching layer. (Note: Unrequested proposal suggests introducing a REST API server).',
      expectedArtifacts: ['src/cache.ts'],
      isOutOfBoundsProposal: true
    },
    {
      taskId: 'u8',
      title: 'Batch transaction optimization',
      prompt: 'Task u8: Optimize batch inserts and atomic updates for high concurrency.',
      expectedArtifacts: ['src/batch.ts']
    },
    {
      taskId: 'u9',
      title: 'Stress and boundary condition testing',
      prompt: 'Task u9: Execute stress tests with high concurrency and simulated failures.',
      expectedArtifacts: ['tests/stress.test.ts'],
      triggersCompression: true
    },
    {
      taskId: 'u10',
      title: 'Concurrent read/write conflict defense',
      prompt: 'Task u10: Implement MVCC or lock-free concurrency defense for concurrent access.',
      expectedArtifacts: ['src/concurrency.ts'],
      forbiddenRules: [forbiddenRule]
    },
    {
      taskId: 'u11',
      title: 'Release packaging and documentation finalization',
      prompt: 'Task u11: Finalize distribution package and verify documentation matches API contract.',
      expectedArtifacts: ['dist/index.js', 'docs/API.md']
    }
  ];

  return {
    initialPrompt,
    forbiddenRule,
    tasks,
    userAmendment: {
      atTaskId: 'u4',
      amendment: 'Migrate underlying storage to SQLite while strictly keeping public API signatures unchanged.',
      supersedesRequirementId: 'u2'
    }
  };
}
