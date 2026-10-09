/* Read-only production check: never edit or save clinical masks/PACS objects. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
const base=process.env.NIFTI_TEST_URL,out=path.resolve('release-artifacts/nifti-streaming-20261008');
assert.equal(new URL(base).port,'9443');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const context=await browser.newContext({httpCredentials:{username:process.env.NIFTI_TEST_USERNAME,password:process.env.NIFTI_TEST_PASSWORD,origin:base,send:'always'},viewport:{width:1500,height:1000}});
 const page=await context.newPage();page.setDefaultTimeout(180000);page.on('dialog',d=>d.accept());
 const report={base,errors:[],files:[],frames:[],clinicalWrites:[]};page.on('pageerror',e=>report.errors.push(e.message));
 page.on('request',r=>{const url=new URL(r.url());if(/\/nifti-images\/[^/]+\/file$/.test(url.pathname))report.files.push(url.pathname);if(url.pathname.includes('/frames/'))report.frames.push(url.pathname);if(r.method()==='POST'&&url.pathname.startsWith('/monai/')&&!url.pathname.endsWith('/stream/prepare'))report.clinicalWrites.push(url.pathname);});
 const memory=()=>page.evaluate(()=>window.extensionManager.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot());
 try {
  const items=(await(await context.request.get(base+'/monai/nifti-images?limit=100')).json()).items,hosp=items.find(s=>s.name==='HOSP001.nii.gz');assert(hosp);
  const masksUrl=base+'/monai/nifti-images/'+hosp.sourceId+'/masks',before=await(await context.request.get(masksUrl)).json();
  await page.goto(base+'/nifti?sourceId='+hosp.sourceId,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.extensionManager?.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics')?.exports.memorySnapshot().streams[0]?.loaded===17);
  await page.waitForTimeout(1500);report.partial=await memory();assert.equal(report.partial.streams[0].loaded,17);assert.equal(report.partial.streams[0].total,352);assert.equal(report.frames.length,17);assert.equal(report.files.length,0);
  await page.screenshot({path:path.join(out,'production-partial-status.png')});
  await page.getByRole('link',{name:'打开另一例 NIfTI',exact:true}).click();await page.getByRole('heading',{name:'NIfTI 检查列表',exact:true}).waitFor();
  const cdp=await context.newCDPSession(page);await cdp.send('HeapProfiler.collectGarbage');await page.waitForTimeout(100);await cdp.send('HeapProfiler.collectGarbage');await cdp.detach();
  report.released=await memory();assert.equal(report.released.sources,0);assert.equal(report.released.images,0);assert.equal(report.released.bytes,0);assert.equal(report.released.sourceReleasedButReachableBytes,0);
  const seriesResponse=await context.request.get(base+'/pacs/dicom-web/series?Modality=CT');assert.equal(seriesResponse.status(),200);
  const series=(await seriesResponse.json()).filter(s=>Number(s['00201209']?.Value?.[0])>=30).sort((a,b)=>Number(a['00201209'].Value[0])-Number(b['00201209'].Value[0]))[0];assert(series);
  report.dicom={studyUID:series['0020000D'].Value[0],seriesUID:series['0020000E'].Value[0]};
  await page.goto(base+'/viewer?StudyInstanceUIDs='+report.dicom.studyUID+'&initialSeriesInstanceUID='+report.dicom.seriesUID,{waitUntil:'domcontentloaded'});
  const ready=()=>page.waitForFunction(()=>{try{const s=window.services,v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);return !!v.getCornerstoneImage?.()&&v.getCornerstoneImage().imageId===v.getCurrentImageId();}catch{return false;}});
  await ready();await page.evaluate(async()=>{const s=window.services,v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);await v.setImageIdIndex(5);v.render();});await ready();
  report.dicom.display=await page.evaluate(()=>{const s=window.services,v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);return {index:v.getCurrentImageIdIndex(),pixels:v.getCornerstoneImage().getPixelData().length};});assert.equal(report.dicom.display.index,5);assert(report.dicom.display.pixels>0);
  await page.screenshot({path:path.join(out,'production-dicom.png')});
  assert.deepEqual(await(await context.request.get(masksUrl)).json(),before);assert.deepEqual(report.clinicalWrites,[]);assert.deepEqual(report.errors,[]);report.passed=true;
 }catch(error){report.passed=false;report.failure=error.stack.replace(/authorization: [^\r\n]+/gi,'authorization: [redacted]');console.log(report.failure);process.exitCode=1;}
 finally{fs.writeFileSync(path.join(out,'production-smoke.json'),JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({passed:report.passed,loaded:report.partial?.streams[0]?.loaded,dicom:report.dicom?.display,clinicalWrites:report.clinicalWrites}));}
})();
