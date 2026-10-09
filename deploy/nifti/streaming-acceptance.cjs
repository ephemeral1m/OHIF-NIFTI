const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{gzipSync}=require('node:zlib');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
const base=process.env.NIFTI_TEST_URL||'https://server-vanilla.tailb37712.ts.net:9444';
const production=new URL(base).port==='9443';
const out=path.resolve('release-artifacts/nifti-streaming-20261008');
function phantom(dtype='i2') {
 const count=128*128*96,bytes=dtype==='f4'?4:2,b=Buffer.alloc(352+count*bytes);
 b.writeInt32LE(348);b.writeInt16LE(3,40);[128,128,96].forEach((n,i)=>b.writeInt16LE(n,42+i*2));
 b.writeInt16LE(bytes===4?16:4,70);b.writeInt16LE(bytes*8,72);b.writeFloatLE(352,108);b.writeFloatLE(1,112);
 b[123]=2;b.writeInt16LE(1,254);[280,300,320].forEach(o=>b.writeFloatLE(1,o));b.write('n+1\0',344,'ascii');
 for(let i=0;i<count;i++) bytes===4?b.writeFloatLE((i%2000)*.125,352+i*4):b.writeInt16LE((i%2000)-1024,352+i*2);
 return gzipSync(b);
}
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const context=await browser.newContext({httpCredentials:{username:process.env.NIFTI_TEST_USERNAME,password:process.env.NIFTI_TEST_PASSWORD,origin:base,send:'always'},viewport:{width:1500,height:1000}});
 const page=await context.newPage();page.setDefaultTimeout(120000);page.on('dialog',d=>d.accept());
 const report={base,errors:[],frames:[],files:[],checks:[]};page.on('pageerror',e=>{report.errors.push(e.message);console.log('pageerror:',e.message);});
 page.on('request',r=>{if(/\/nifti-images\/[^/]+\/frames\/\d+$/.test(r.url()))report.frames.push(r.url());if(/\/nifti-images\/[^/]+\/file$/.test(r.url()))report.files.push(r.url());});
 const button=name=>page.getByRole('button',{name,exact:true});
 const view=async()=>page.evaluate(()=>{try {const s=window.services;return s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);}catch{return null;}});
 const ready=()=>page.waitForFunction(()=>{try {const s=window.services,v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);return v?.getCornerstoneImage?.()?.imageId===v?.getCurrentImageId?.()&&v?.getCornerstoneImage?.()?.getPixelData?.()?.length>0;}catch{return false;}});
 const memory=()=>page.evaluate(()=>window.extensionManager.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot());
 const jump=async i=>{await page.evaluate(async i=>{const s=window.services,v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);await v.setImageIdIndex(i);v.render();},i);await ready();};
 const masks=()=>page.evaluate(()=>window.services.segmentationService.getSegmentations().map(m=>({id:m.segmentationId,name:m.label,foreground:m.representationData.Labelmap.imageIds.reduce((n,id)=>n+window.cornerstone.cache.getImage(id).getPixelData().reduce((n,x)=>n+Number(x!==0),0),0)})));
 const open=async id=>{await page.goto(base+'/nifti?sourceId='+id,{waitUntil:'domcontentloaded'});await ready();};
 try {
  assert.equal((await context.request.get(base+'/monai/nifti-images')).status(),200);
  if(!production) {
   const res=await context.request.post(base+'/monai/nifti-images',{multipart:{file:{name:'streaming-ct-20261008.nii.gz',mimeType:'application/gzip',buffer:phantom()},modality:'CT'}});
   assert.equal(res.status(),200,await res.text());const source=await res.json();report.sourceId=source.sourceId;
   await open(source.sourceId);
   await page.waitForFunction(()=>window.extensionManager.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot().streams[0]?.loaded===17);
   assert.equal((await memory()).streams[0].total,96);assert.equal(report.files.length,0);
   const first=await page.evaluate(()=>{const s=window.services,v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);return {index:v.getCurrentImageIdIndex(),sample:v.getCornerstoneImage().getPixelData()[123]};});
   assert.equal(first.index,48);assert.equal(first.sample,(48*128*128+123)%2000-1024);
   report.checks.push('middle slice, exact pixels, 17-layer window, no original-file download');console.log(report.checks.at(-1));
   const unlock=button('Unlock tools');if(await unlock.isVisible())await unlock.click();
   await button('新建二值 mask').click();await page.waitForFunction(()=>window.services.segmentationService.getSegmentations().length===1);
   await page.evaluate(()=>window.commandsManager.runCommand('setToolActive',{toolName:'CircularBrush'}));
   const box=await page.locator('canvas').first().boundingBox();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.55,box.y+box.height*.53,{steps:8});await page.mouse.up();
   await page.waitForFunction(()=>window.services.segmentationService.getSegmentations().some(m=>m.representationData.Labelmap.imageIds.some(id=>window.cornerstone.cache.getImage(id).getPixelData().some(x=>x!==0))));
   const edited=await masks();assert(edited[0].foreground>0);assert((await memory()).streams[0].loaded<96);
   const savedEvent=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/masks'));
   await button('Save All').click();assert.equal((await savedEvent).status(),200);
   report.brush=edited;report.checks.push('brush and server save before complete volume');console.log(report.checks.at(-1));
   await jump(10);await jump(80);await jump(48);assert.equal((await masks())[0].foreground,edited[0].foreground);
   await button('原图加载状态').click();await page.screenshot({path:path.join(out,'partial-viewer.png')});
   if(process.env.NIFTI_STREAM_SKIP_AI!=='1') {
    const infer=page.waitForResponse(r=>r.url().endsWith('/infer'),{timeout:300000});
    await page.locator('[data-cy="Probe2"] button').click();
    await page.mouse.click(box.x+box.width*.5,box.y+box.height*.5);
    const reply=await infer;assert.equal(reply.status(),200);await reply.finished();
    report.checks.push('real GPU AI on partially loaded source');console.log(report.checks.at(-1));
   }
   await page.evaluate(()=>window.commandsManager.runCommand('toggleHangingProtocol',{protocolId:'mpr'}));
   await page.waitForFunction(()=>{try {const s=window.services,v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);return !!v?.getVolumeId?.();}catch{return false;}});
   assert.equal((await memory()).streams[0].loaded,96);report.checks.push('explicit MPR fills missing frames');
   await page.screenshot({path:path.join(out,'mpr-viewer.png')});
   const mr=await context.request.post(base+'/monai/nifti-images',{multipart:{file:{name:'streaming-mr-20261008.nii.gz',mimeType:'application/gzip',buffer:phantom('f4')},modality:'MR'}});
   assert.equal(mr.status(),200);const mrSource=await mr.json();await page.goto(base+'/nifti',{waitUntil:'domcontentloaded'});await open(mrSource.sourceId);
   const mrState=await(await context.request.get(base+'/monai/nifti-images/'+mrSource.sourceId+'/stream')).json();assert.equal(mrState.descriptor.wireDtype,'<f4');report.checks.push('fractional MR retains float32');
  }
  const realPath='/home/ubuntu/ohif-ai/nifti-demo/hospital-10-20261008/HOSP001.nii.gz';
  let hosp;
  if(production) hosp=(await(await context.request.get(base+'/monai/nifti-images?limit=100')).json()).items.find(s=>s.name==='HOSP001.nii.gz');
  else {const r=await context.request.post(base+'/monai/nifti-images/manifest/open',{data:{image:realPath,segmentations:[],modality:'CT'},timeout:180000});assert.equal(r.status(),200,await r.text());hosp=(await r.json()).descriptor;}
  assert(hosp);await page.goto(base+'/nifti?library=1',{waitUntil:'domcontentloaded'});await button('打开 HOSP001.nii.gz').waitFor();
  const network=await context.newCDPSession(page);await network.send('Network.emulateNetworkConditions',{offline:false,latency:100,downloadThroughput:250000,uploadThroughput:250000});
  const t=Date.now();await button('打开 HOSP001.nii.gz').click();await ready();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));report.hospitalFirstRenderSeconds=(Date.now()-t)/1000;
  const stats=await memory();assert(stats.streams[0].loaded<352);assert.equal(report.files.length,0);
  report.hospital=stats.streams[0];report.hospitalNetwork=await page.evaluate(()=>performance.getEntriesByType('resource').filter(r=>r.name.includes('/nifti-images/')).map(r=>({path:new URL(r.name).pathname,durationMs:r.duration,bytes:r.encodedBodySize})));await page.screenshot({path:path.join(out,production?'production-viewer.png':'hospital-viewer.png')});
  report.checks.push('HOSP001 under 2 Mbps/100 ms shows before complete transfer');console.log(report.checks.at(-1),report.hospitalFirstRenderSeconds);
  assert.deepEqual(report.errors,[]);report.passed=true;
 } catch(error){report.passed=false;report.failure=error.stack.replace(/authorization: [^\r\n]+/gi,'authorization: [redacted]');report.memory=await memory().catch(()=>null);report.viewport=await page.evaluate(()=>{try {const s=window.services,v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);return {requested:v.getCurrentImageId(),actual:v.getCornerstoneImage()?.imageId,callback:typeof v.getCornerstoneImage()?.niftiOnDisplayed,index:v.getCurrentImageIdIndex()};}catch{return null;}});await page.screenshot({path:path.join(out,'streaming-failure.png')});process.exitCode=1;console.log(report.failure);console.log(JSON.stringify(report.memory));}
 finally {fs.writeFileSync(path.join(out,production?'production-acceptance.json':'streaming-acceptance.json'),JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({passed:report.passed,checks:report.checks,errors:report.errors,firstRender:report.hospitalFirstRenderSeconds}));}
})();
