const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.NIFTI_TEST_URL;assert(new URL(base).port==='9444','Isolated environment only');
const out=process.env.NIFTI_TEST_OUTPUT||path.join(__dirname,'acceptance-results/annotation-history');fs.mkdirSync(out,{recursive:true});
const phantom=Buffer.alloc(352+32**3*2);phantom.writeInt32LE(348);phantom.writeInt16LE(3,40);[42,44,46].forEach(o=>phantom.writeInt16LE(32,o));phantom.writeInt16LE(4,70);phantom.writeInt16LE(16,72);phantom.writeFloatLE(352,108);phantom.writeFloatLE(1,112);phantom[123]=2;phantom.writeInt16LE(1,254);[280,300,320].forEach(o=>phantom.writeFloatLE(1,o));phantom.write('n+1\0',344,'ascii');for(let i=352;i<phantom.length;i+=2)phantom.writeInt16LE((i/2)%1000,i);phantom.writeInt16LE(Math.random()*30000|0,352);
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const context=await browser.newContext({httpCredentials:{username:process.env.NIFTI_TEST_USERNAME,password:process.env.NIFTI_TEST_PASSWORD,origin:base},viewport:{width:1500,height:1000}});
 const page=await context.newPage();page.setDefaultTimeout(90000);page.on('dialog',d=>d.accept());const report={base,errors:[],posts:0};page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/nifti-images/'))report.posts++;});
 const button=name=>page.getByRole('button',{name,exact:true});
 const snapshot=()=>page.evaluate(()=>window.services.segmentationService.getSegmentations().map(m=>({id:m.segmentationId,name:m.label,foreground:m.representationData.Labelmap.imageIds.reduce((n,id)=>n+window.cornerstone.cache.getImage(id).getPixelData().reduce((n,x)=>n+Number(x!==0),0),0)})));
 const memory=()=>page.evaluate(()=>window.extensionManager.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot().bytes);
 const close=async()=>{await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});};
 try{
  const res=await context.request.post(base+'/monai/nifti-images',{multipart:{file:{name:'annotation-history.nii',mimeType:'application/octet-stream',buffer:phantom}}});assert.equal(res.status(),200);const source=await res.json(),url=base+'/monai/nifti-images/'+source.sourceId+'/masks';report.sourceId=source.sourceId;
  const seed=Buffer.alloc(source.count);seed[0]=1;
  const save=async(fields,color=[70,220,240,255])=>{const r=await context.request.post(url,{multipart:{file:{name:'seed.bin',mimeType:'application/octet-stream',buffer:seed},raw:'true',geometryHash:source.geometryHash,provenance:JSON.stringify({displayColor:color}),...fields}});assert.equal(r.status(),200,await r.text());return (await r.json()).items[0];};
  const a=await save({label:'Target A'});seed[1]=1;await save({label:'Target A',maskId:a.maskId,expectedVersion:'1'});seed.fill(0);const b=await save({label:'Target B',labelOnly:'true'},[245,175,60,255]);
  seed[0]=1;const copy=await save({label:'Review copy',provenance:JSON.stringify({derivedFrom:{maskId:a.maskId,version:1},displayColor:[190,150,240,255]})});
  await page.goto(base+'/nifti?sourceId='+source.sourceId,{waitUntil:'domcontentloaded'});await button('标注历史').click();await button('Target A').waitFor();
  await button('选择版本 v2').waitFor();assert.equal(await page.locator('ol[aria-label="当前标注的版本轨迹"] li').count(),2);
  await button('加载这份标注的最新版本').click();await page.getByRole('status').filter({hasText:'已加载 Target A'}).waitFor();
  await button('Target B').click();await button('选择版本 v1').waitFor();assert.equal(await page.locator('ol li').count(),1);
  await button('加载这份标注的最新版本').click();await page.getByRole('status').filter({hasText:'已加载 Target B'}).waitFor();await close();
  const initial=await snapshot();assert.deepEqual(initial.map(m=>m.foreground).sort(),[0,2]);
  await page.evaluate(()=>{const s=window.services.segmentationService,m=s.getSegmentations().find(m=>m.label==='Target A');s.setSegmentLabel(m.segmentationId,1,'Target A edited');});
  await button('标注历史').click();await button('Target A').click();await button('选择版本 v1').click();assert(await button('恢复为新版本').isDisabled());
  const beforePreview=await snapshot(),beforeBytes=await memory(),beforePosts=report.posts;
  const active=await page.evaluate(()=>{const s=window.services;return s.segmentationService.getActiveSegmentation(s.viewportGridService.getState().activeViewportId)?.segmentationId;});
  await button('只读预览').click();await page.getByRole('region',{name:'只读历史影像预览'}).waitFor();
  assert.deepEqual(await snapshot(),beforePreview);assert.equal(report.posts,beforePosts);assert(await memory()>beforeBytes);
  await page.getByLabel('历史预览切片',{exact:true}).fill('0');
  await page.screenshot({path:path.join(out,'readonly-preview.png'),animations:'disabled'});
  await button('Target B').click();await button('选择版本 v1').waitFor();assert.equal(await page.getByRole('region',{name:'只读历史影像预览'}).count(),0);assert.equal(await memory(),beforeBytes);
  assert.equal(await page.evaluate(()=>{const s=window.services;return s.segmentationService.getActiveSegmentation(s.viewportGridService.getState().activeViewportId)?.segmentationId;}),active);
  await close();await button('Save All').click();await page.getByRole('status').filter({hasText:'已保存 2 / 2'}).waitFor();
  await page.evaluate(()=>window.commandsManager.runCommand('toggleHangingProtocol',{protocolId:'mpr'}));
  await page.waitForFunction(()=>[...window.services.viewportGridService.getState().viewports.keys()].every(id=>window.services.cornerstoneViewportService.getCornerstoneViewport(id)?.getVolumeId?.()));
  await button('标注历史').click();await button('Target A edited').click();await button('选择版本 v1').click();await button('恢复为新版本').click();await button('确认恢复').click();
  await page.getByRole('status').filter({hasText:'已恢复为 v4'}).waitFor();report.restored=await snapshot();assert.equal(report.restored.length,2);assert.equal(report.restored.find(m=>m.name==='Target A edited').foreground,1);assert.equal(report.restored.find(m=>m.name==='Target B').foreground,0);
  const latest=(await(await context.request.get(url)).json()).items;assert.equal(latest.length,3);const restored=latest.find(m=>m.maskId===a.maskId);assert.equal(restored.version,4);assert.equal(restored.restoredFrom,1);
  await page.waitForFunction(()=>{const s=window.services,ids=s.segmentationService.getSegmentations().map(m=>m.segmentationId);return [...s.viewportGridService.getState().viewports.keys()].every(v=>ids.every(id=>s.segmentationService.getSegmentationRepresentations(v).some(r=>r.segmentationId===id)));});report.mprRepresentations=true;
  await page.screenshot({path:path.join(out,'individual-history.png'),animations:'disabled'});
  await button('Review copy').click();await button('Target A edited · v1').click();await button('选择版本 v4').waitFor();assert.equal(await button('选择版本 v1').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('ol li').count(),4);
  // Cancellation during a read cannot add targets or leak preview reservations.
  let arrived;const waiting=new Promise(resolve=>arrived=resolve),pattern=`**/masks/${a.maskId}?version=1`;await page.route(pattern,route=>arrived(route));
  await button('只读预览').click();const route=await waiting;await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('status').filter({hasText:'已取消'}).waitFor();await route.abort().catch(()=>{});await page.unroute(pattern);assert.equal((await snapshot()).length,2);
  await button('另存为独立标注').click();await page.getByRole('status').filter({hasText:'已创建独立标注副本'}).waitFor();assert.equal((await snapshot()).length,3);
  await close();await button('Save All').click();await page.getByRole('status').filter({hasText:'已保存 3 / 3'}).waitFor();
  const afterCopy=(await(await context.request.get(url)).json()).items;assert.equal(afterCopy.length,4);assert.equal(afterCopy.find(m=>m.maskId===a.maskId).version,4);
  await button('标注历史').click();await button('Target A edited').click();await button('选择版本 v1').click();await button('只读预览').click();await page.getByRole('region',{name:'只读历史影像预览'}).waitFor();
  await page.setViewportSize({width:900,height:700});await page.waitForFunction(()=>{const r=document.querySelector('[role="dialog"]').getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;});
  await close();await page.getByRole('link',{name:'打开另一例 NIfTI',exact:true}).click();await page.getByRole('heading',{name:'NIfTI 检查列表',exact:true}).waitFor();assert.equal(await memory(),0);
  assert.deepEqual(report.errors,[]);report.passed=true;
 }catch(error){report.passed=false;report.failure=error.stack;report.text=(await page.locator('body').innerText()).slice(0,6500);await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'});process.exitCode=1;}
 finally{fs.writeFileSync(path.join(out,'annotation-history.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
