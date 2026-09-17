import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fixture } from './fixture.mjs';
import { renderViews } from './render-harness.mjs';
test('all seven views render; unknown recovery dates break chart series; question text is escaped',async()=>{
  const snapshot=fixture();snapshot.plan.questions[0].prompt='<img src=x onerror=alert(1)>';
  const {result,context}=await renderViews(snapshot);
  assert.equal(Object.keys(result).length,7);
  assert.ok(result.questions.includes('&lt;img'));
  assert.ok(!result.questions.includes('<img'));
  assert.equal(vm.runInContext("recoveryRows().find(x=>x.date==='2025-02-03').hrvMs===undefined",context),true);
  assert.ok(result.journal.includes('saved to your private account'));
});

test('source status distinguishes fetch time from observations and escapes failed-source messages',async()=>{
  const {result,elements}=await renderViews(fixture(),{configured:true,lastSuccessfulFetch:'2025-02-06T09:00:00Z',lastRefreshError:'Refresh failed',
    sources:{sleep:{lastSuccessfulFetch:'2025-02-06T09:00:00Z',lastResult:'error',lastError:'<img src=x onerror=alert(1)>'}}});
  assert.ok(result.data.includes('Last successful app fetch'));assert.ok(result.data.includes('Latest reading'));
  assert.ok(result.data.includes('&lt;img'));assert.ok(!result.data.includes('<img'));
  assert.match(elements.get('#freshness-note').textContent,/saved data retained/);
  assert.equal(elements.get('#refresh-data').disabled,false);
});
