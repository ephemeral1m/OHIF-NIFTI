const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
const base=process.env.NIFTI_TEST_URL,out=path.resolve('release-artifacts/nifti-streaming-20261008');
const production=new URL(base).port==='9443';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const context=await browser.newContext({httpCredentials:{username:process.env.NIFTI_TEST_USERNAME,password:process.env.NIFTI_TEST_PASSWORD,origin:base,send:'always'},viewport:{width:1500,height:1000}});
 const page=await context.newPage();page.setDefaultTimeout(180000);
 const report={base,browser:browser.version(),environment:{cpu:require('node:os').cpus()[0].model,viewport:'1500x1000',headless:true,downloadBytesPerSecond:250000,addedLatencyMs:100},errors:[],files:[],targets:{hotSeconds:5,coldSeconds:15,p95ms:100}};
 page.on('pageerror',e=>report.errors.push(e.message));page.on('dialog',d=>d.accept());page.on('request',r=>{if(/\/nifti-images\/[^/]+\/file$/.test(r.url()))report.files.push(r.url());});
 const ready=()=>page.waitForFunction(()=>{try{const s=window.services,v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);return !!v.getCornerstoneImage?.()&&v.getCornerstoneImage().imageId===v.getCurrentImageId();}catch{return false;}});
 const memory=()=>page.evaluate(()=>window.extensionManager.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot());
 try {
  const anonymous=await browser.newContext();
  const denied=await anonymous.request.get(base+'/monai/nifti-images');
  report.unauthenticatedStatus=denied.status();assert.equal(denied.status(),401);await anonymous.close();
  const runtime=await(await context.request.get(base+'/app-config.js')).text();assert(/enableNiftiStreaming:\s*(?:true|!0)/.test(runtime));
  let standard;
  if(!production&&process.env.NIFTI_PERF_LIBRARY_ONLY!=='1') {
   const fixture=fs.readFileSync(path.resolve('release-artifacts/nifti-phantoms/ct-standard-128mib.nii.gz'));
   const r=await context.request.post(base+'/monai/nifti-images',{timeout:180000,multipart:{file:{name:'ct-standard-128mib.nii.gz',mimeType:'application/gzip',buffer:fixture},modality:'CT'}});assert.equal(r.status(),200,await r.text());standard=await r.json();
   await page.goto(base+'/nifti?sourceId='+standard.sourceId,{waitUntil:'domcontentloaded'});await ready();
   await page.getByRole('button',{name:'原图加载状态',exact:true}).click();await page.getByRole('button',{name:'加载完整体数据',exact:true}).click();
   await page.waitForFunction(()=>window.extensionManager.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot().streams[0].loaded===256);
   let frames=0;const count=r=>{if(r.url().includes('/frames/'))frames++;};page.on('request',count);
   report.renderMs=await page.evaluate(async()=>{const s=window.services,v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId),samples=[];for(let i=80;i<130;i++){const start=performance.now(),rendered=new Promise(resolve=>v.element.addEventListener(window.cornerstone.Enums.Events.IMAGE_RENDERED,resolve,{once:true}));await v.setImageIdIndex(i);v.render();await rendered;samples.push(performance.now()-start);}return samples;});
   page.off('request',count);report.cachedScrollRequests=frames;assert.equal(frames,0);report.p95ms=[...report.renderMs].sort((a,b)=>a-b)[47];report.standard=await memory();
   await page.getByRole('link',{name:'打开另一例 NIfTI',exact:true}).click();await page.getByRole('heading',{name:'NIfTI 检查列表',exact:true}).waitFor();console.log('128 MiB cached scroll p95',report.p95ms);
  }
  const all=await(await context.request.get(base+'/monai/nifti-images?limit=100')).json(),hosp=all.items.find(s=>s.name==='HOSP001.nii.gz');assert(hosp);report.hospitalId=hosp.sourceId;
  const initial=await(await context.request.get(base+'/monai/nifti-images/'+hosp.sourceId+'/stream')).json();
  if(production&&initial.state==='missing') {
   const other=all.items.find(s=>s.sourceId!==hosp.sourceId&&s.workingBytes<32*1024**2)||all.items.find(s=>s.sourceId!==hosp.sourceId);assert(other);
   await page.goto(base+'/nifti?sourceId='+other.sourceId,{waitUntil:'domcontentloaded'});await ready();
   await page.getByRole('link',{name:'打开另一例 NIfTI',exact:true}).click();await page.getByRole('button',{name:'打开 HOSP001.nii.gz',exact:true}).waitFor();
   const coldNetwork=await context.newCDPSession(page);await coldNetwork.send('Network.emulateNetworkConditions',{offline:false,latency:100,downloadThroughput:250000,uploadThroughput:250000});
   const start=Date.now();await page.getByRole('button',{name:'打开 HOSP001.nii.gz',exact:true}).click();await ready();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   report.coldFirstRenderSeconds=(Date.now()-start)/1000;report.targetColdMet=report.coldFirstRenderSeconds<=15;console.log('HOSP001 cold first render',report.coldFirstRenderSeconds);
   await coldNetwork.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await coldNetwork.detach();
  }
  const preparation=await context.request.post(base+'/monai/nifti-images/'+hosp.sourceId+'/stream/prepare');assert([200,202].includes(preparation.status()));
  let transport;
  for(let i=0;i<60;i++){const status=await(await context.request.get(base+'/monai/nifti-images/'+hosp.sourceId+'/stream')).json();if(status.state==='ready'){transport=status.descriptor;break;}assert(status.state!=='failed');await new Promise(r=>setTimeout(r,500));}
  assert(transport);report.preparationSeconds=transport.preparationSeconds;
  const privateFile=await context.request.get(base+'/_nifti-stream-cache/'+transport.cacheKey+'/176.gz');assert.equal(privateFile.status(),404);report.directCacheStatus=privateFile.status();
  // Warm application/viewport assets before measuring original transfer.
  await page.goto(base+'/nifti?sourceId='+hosp.sourceId,{waitUntil:'domcontentloaded'});await ready();await page.getByRole('link',{name:'打开另一例 NIfTI',exact:true}).click();await page.getByRole('button',{name:'打开 HOSP001.nii.gz',exact:true}).waitFor();
  const cdp=await context.newCDPSession(page);await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:100,downloadThroughput:250000,uploadThroughput:250000});
  const t=Date.now();await page.getByRole('button',{name:'打开 HOSP001.nii.gz',exact:true}).click();await ready();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));report.hotFirstRenderSeconds=(Date.now()-t)/1000;
  report.hospital=await memory();assert(report.hospital.streams[0].loaded<352);assert.equal(report.files.length,0);
  report.displayedFrame=await page.evaluate(async()=>{const s=window.services,v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId),pixels=v.getCornerstoneImage().getPixelData(),packed=new Int16Array(pixels);return {index:v.getCurrentImageIdIndex(),packedHash:[...new Uint8Array(await crypto.subtle.digest('SHA-256',packed))].map(x=>x.toString(16).padStart(2,'0')).join('')};});
  assert.equal(report.displayedFrame.index,176);assert.equal(report.displayedFrame.packedHash,transport.frames[176].sha256);
  report.resources=await page.evaluate(()=>performance.getEntriesByType('resource').filter(r=>r.name.includes('/nifti-images/')).map(r=>({path:new URL(r.name).pathname,durationMs:r.duration,bytes:r.encodedBodySize})));
  report.hashedAssets=await page.evaluate(()=>performance.getEntriesByType('resource').filter(r=>/\.[a-f0-9]{16,}\.js$/.test(new URL(r.name).pathname)).map(r=>({path:new URL(r.name).pathname,transferBytes:r.transferSize,durationMs:r.duration})));
  report.targetHotMet=report.hotFirstRenderSeconds<=5;report.targetScrollMet=report.p95ms===undefined?undefined:report.p95ms<=100;
  await page.screenshot({path:path.join(out,production?'production-viewer.png':'streaming-performance.png')});assert.deepEqual(report.errors,[]);report.passed=true;console.log('HOSP001 hot first render',report.hotFirstRenderSeconds);
 }catch(error){report.passed=false;report.failure=error.stack.replace(/authorization: [^\r\n]+/gi,'authorization: [redacted]');console.log(report.failure);process.exitCode=1;}
 finally{fs.writeFileSync(path.join(out,production?'production-performance.json':'streaming-performance.json'),JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({passed:report.passed,hotSeconds:report.hotFirstRenderSeconds,p95ms:report.p95ms,hotMet:report.targetHotMet,scrollMet:report.targetScrollMet}));}
})();
