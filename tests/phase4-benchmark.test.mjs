import test from 'node:test';
import assert from 'node:assert/strict';
import {logicalMakespan,runBenchmark} from '../scripts/benchmark-phase4.mjs';

test('deterministic incremental scheduling improves makespan without claiming actual host speedup',()=>{
  const durations=[150,4,4,4,150,4,4,4,150,4,4,4];
  const barrier=logicalMakespan(durations,4,false);
  const incremental=logicalMakespan(durations,4,true);
  assert.ok(incremental<barrier,{barrier,incremental});
  assert.ok(barrier/incremental>=1.5);
  assert.equal(logicalMakespan([7,8,9],1,false),
    logicalMakespan([7,8,9],1,true));
});
test('real SQLite workload records bounded latency, events, receipts and crash recovery',async()=>{
  const report=await runBenchmark({units:12,reads:4});
  assert.equal(report.assurance,'LOCAL_SYNTHETIC_NOT_HOST_LATENCY');
  assert.equal(report.workload.actualNativeWorkers,0);
  assert.equal(report.result.completed,12);
  assert.equal(report.result.receiptCount,12);
  assert.ok(report.result.historyEvents>=12);
  assert.ok(report.result.databaseBytes>0);
  assert.ok(report.latencyMs.write.count>=12);
  assert.ok(report.latencyMs.read.count>=4);
  assert.equal(report.latencyMs.recovery.count,1);
  assert.ok(report.result.incrementalRefills>0);
  assert.ok(report.deterministicSchedule.logicalSpeedup>1);
});
