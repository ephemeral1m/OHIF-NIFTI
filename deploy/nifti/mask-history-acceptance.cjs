/* Isolated, disposable synthetic case. Never writes production annotations. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.NIFTI_TEST_URL;
assert(base && new URL(base).port === '9444', 'Use the isolated 9444 service');
const out = process.env.NIFTI_TEST_OUTPUT || path.join(__dirname, 'acceptance-results/mask-history');
fs.mkdirSync(out, { recursive: true });
const phantom = Buffer.alloc(352 + 32**3 * 2);
phantom.writeInt32LE(348); phantom.writeInt16LE(3,40);
for(const offset of [42,44,46]) phantom.writeInt16LE(32,offset);
phantom.writeInt16LE(4,70); phantom.writeInt16LE(16,72); phantom.writeFloatLE(352,108); phantom.writeFloatLE(1,112);
phantom[123]=2; phantom.writeInt16LE(1,254); [280,300,320].forEach(o=>phantom.writeFloatLE(1,o));
phantom.write('n+1\0',344,'ascii'); for(let i=352;i<phantom.length;i+=2) phantom.writeInt16LE((i/2)%1000,i);
phantom.writeInt16LE(Math.floor(Math.random()*30000),352);
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const context=await browser.newContext({httpCredentials:{username:process.env.NIFTI_TEST_USERNAME,password:process.env.NIFTI_TEST_PASSWORD,origin:base},viewport:{width:1500,height:950}});
 const page=await context.newPage();page.setDefaultTimeout(90000);page.on('dialog',d=>d.accept());
 const report={base,errors:[],maskDownloads:0};page.on('pageerror',e=>report.errors.push(e.message));
 page.on('request',r=>{if(/\/masks\/[a-f0-9]{32}\?version=/.test(r.url()))report.maskDownloads++;});
 const snapshot=()=>page.evaluate(()=>window.services.segmentationService.getSegmentations().map(m=>({id:m.segmentationId,name:m.label,
   foreground:m.representationData.Labelmap.imageIds.reduce((n,id)=>n+window.cornerstone.cache.getImage(id).getPixelData().reduce((n,x)=>n+Number(x!==0),0),0)})));
 const launcher=()=>page.getByRole('button',{name:'加载已存 mask',exact:true});
 const latest=()=>page.getByRole('button',{name:'加载全部最新版本',exact:true});
 const finished=async()=>{await page.getByRole('status').filter({hasText:'加载完成'}).waitFor();await page.waitForFunction(()=>!document.querySelector('button[aria-label="加载已存 mask"]')?.disabled);};
 try {
  const res=await context.request.post(base+'/monai/nifti-images',{multipart:{file:{name:'mask-recovery-test.nii',mimeType:'application/octet-stream',buffer:phantom}}});assert.equal(res.status(),200);const source=await res.json(); report.sourceId=source.sourceId;
  const url=base+'/monai/nifti-images/'+source.sourceId+'/masks';
  const seed=Buffer.alloc(source.count);seed[0]=1;
  const save=async fields=>{const r=await context.request.post(url,{multipart:{file:{name:'seed.bin',mimeType:'application/octet-stream',buffer:seed},raw:'true',geometryHash:source.geometryHash,...fields}});assert.equal(r.status(),200,await r.text());return (await r.json()).items[0];};
  const a=await save({label:'Recovery A'});seed[1]=1;await save({label:'Recovery A',maskId:a.maskId,expectedVersion:'1'});
  seed.fill(0);const b=await save({label:'Recovery B',labelOnly:'true'});
  await page.goto(base+'/nifti?sourceId='+source.sourceId,{waitUntil:'domcontentloaded'});await launcher().click();
  await page.getByText('3 条保存记录',{exact:true}).waitFor();
  await page.evaluate(()=>{window.extensionManager.appConfig.niftiWorkingSetBytes=64*1024**2;});
  report.workingSetLimitMiB=64;
  await latest().click();await finished();
  report.first=await snapshot();assert.deepEqual(report.first.map(m=>m.foreground).sort(),[0,2]);
  const downloads=report.maskDownloads;await latest().click();await finished();
  assert.equal(report.maskDownloads,downloads);assert.equal((await snapshot()).length,2);assert.match(await page.getByRole('status').innerText(),/新增 0 个，已有 2 个/);
  // An old version must add a separate target and leave the latest target untouched.
  await page.getByRole('button',{name:`加载 ${a.maskId} v1 副本`,exact:true}).click();await finished();
  report.withCopy=await snapshot();assert.equal(report.withCopy.length,3);assert.equal(report.withCopy.find(m=>m.name.includes('v1 副本')).foreground,1);
  await page.screenshot({path:path.join(out,'saved-versions.png'),animations:'disabled'});
  await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Save All',exact:true}).click();await page.getByRole('status').filter({hasText:'已保存 3 / 3'}).waitFor();
  const saved=await(await context.request.get(url)).json();const copy=saved.items.find(m=>m.name.includes('v1 副本'));
  assert.deepEqual(copy.derivedFrom,{maskId:a.maskId,version:1});assert.notEqual(copy.maskId,a.maskId);
  assert.equal(saved.items.find(m=>m.maskId===a.maskId).version,3); // Color metadata migrates once on the original.
  // Delete runtime targets, switch MPR, and reload all versions without a page refresh.
  await page.evaluate(()=>{const s=window.services.segmentationService;[...s.getSegmentations()].forEach(m=>s.remove(m.segmentationId));});
  await page.evaluate(()=>window.commandsManager.runCommand('toggleHangingProtocol',{protocolId:'mpr'}));
  await page.waitForFunction(()=>[...window.services.viewportGridService.getState().viewports.keys()].every(id=>window.services.cornerstoneViewportService.getCornerstoneViewport(id)?.getVolumeId?.()));
  await launcher().click();await latest().click();await finished();report.mprReload=await snapshot();assert.deepEqual(report.mprReload.map(m=>m.foreground).sort(),[0,1,2]);
  // A real budget refusal must keep all current masks and become retryable after freeing budget.
  await page.evaluate(()=>{window.extensionManager.appConfig.niftiWorkingSetBytes=1024**2;});
  await page.getByRole('button',{name:`加载 ${a.maskId} v1 副本`,exact:true}).click();
  await page.getByRole('alert').filter({hasText:'内存预算不足'}).waitFor();assert.equal((await snapshot()).length,3);
  await page.evaluate(()=>{window.extensionManager.appConfig.niftiWorkingSetBytes=64*1024**2;});
  await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.evaluate(()=>{const s=window.services.segmentationService;[...s.getSegmentations()].forEach(m=>s.remove(m.segmentationId));});
  // A failed download reports the target and permits a retry; other targets remain loaded.
  const failurePattern=`**/masks/${b.maskId}?version=*`;await page.route(failurePattern,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Simulated interruption'})}));
  await launcher().click();await latest().click();await page.getByRole('alert').filter({hasText:'Simulated interruption'}).waitFor();
  assert.equal((await snapshot()).length,2);await page.unroute(failurePattern);await latest().click();await finished();assert.equal((await snapshot()).length,3);
  // A stalled request must cancel promptly, preserve prior targets and allow a clean retry.
  await page.keyboard.press('Escape');await page.evaluate(()=>{const s=window.services.segmentationService;[...s.getSegmentations()].forEach(m=>s.remove(m.segmentationId));});
  let pending;const stalled=new Promise(resolve=>pending=resolve);await page.route(failurePattern,route=>pending(route));
  await launcher().click();await latest().click();const route=await stalled;
  await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('status').filter({hasText:'已取消'}).waitFor();
  const countAfterCancel=(await snapshot()).length;assert(countAfterCancel<=2);await route.abort().catch(()=>{});await page.unroute(failurePattern);
  await latest().click();await finished();assert.equal((await snapshot()).length,3);report.cancelRetained=countAfterCancel;
  assert.equal(report.errors.length,0);report.passed=true;
 }catch(error){report.passed=false;report.failure=error.stack;report.text=(await page.locator('body').innerText()).slice(0,5500);await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'});process.exitCode=1;}
 finally{fs.writeFileSync(path.join(out,'mask-history.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
